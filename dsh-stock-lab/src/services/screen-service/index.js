/**
 * screen-service/index.js — 公式选股引擎（ROADMAP T5.7）
 *
 * 做什么：把一条通达信**条件公式**在**本地库**的一批标的上批量求值，返回命中的标的。
 *
 * 设计要点（都来自实测/踩坑，不是拍脑袋）：
 *   1. **只读本地库，不联网**：选股必须可复现、可离线。缺数据的标的**单独计数**，不静默跳过——
 *      "5000 只里只算了 5 只"如果不说出来，结果会被误读成"全市场只有 5 只命中"。
 *   2. **分批 + 让出事件循环**：5000 标的全链路实测约 4–15 秒；必须能做进度、能取消，
 *      不能把宿主进程卡死（每批 40 个后 setImmediate 一次）。
 *   3. **结果缓存**：同一公式 + 同一参数 + 同一数据版本（文件大小+mtime 指纹）→ 直接复用。
 *      数据一变版本就变，缓存自然失效，不会拿旧结果骗人。
 *   4. **只信 signalsFrom 的 0/1 判定**：指标公式（最后一行不是 0/1 条件）直接报错，
 *      绝不把"非零"当命中——那会把每条均线都算成信号（这个安全判定在 formula-service 里）。
 *   5. **数字全部由代码算**：命中次数、最近命中日、收盘价、涨跌幅都由这里算好，LLM 只解释。
 *   6. **不直接 import datasource/**：本地库读写一律经 MarketService（架构铁律，有测试扫描）。
 */

import { randomUUID, createHash } from 'node:crypto'
import { analyze, run, signalsFrom } from '../formula-service/index.js'

const DEFAULT_BATCH = 40
const MAX_JOBS = 20
const MAX_RESULTS = 500
const MAX_ERRORS = 20

/** 只保留最近 N 个任务（内存不会无限长） */
function trimJobs(jobs, max) {
  if (jobs.size <= max) return
  const finished = [...jobs.values()]
    .filter((j) => j.state !== 'running')
    .sort((a, b) => a.createdAt - b.createdAt)
  while (jobs.size > max && finished.length) {
    const victim = finished.shift()
    jobs.delete(victim.id)
  }
}

export class ScreenService {
  /**
   * @param {object} opts
   * @param {object} opts.formulas  FormulaStore（可选：也可以直接传公式文本）
   * @param {object} opts.market    MarketService（全市场标的池 / 本地库只读接口 / symbol 规范化）
   * @param {Function} opts.log
   */
  constructor({ formulas = null, market = null, log = () => {}, batchSize = DEFAULT_BATCH } = {}) {
    this.formulas = formulas
    this.market = market
    this.log = log
    this.batchSize = Math.max(1, Number(batchSize) || DEFAULT_BATCH)
    this.jobs = new Map()
    this.cache = new Map()
  }

  _needMarket() {
    if (!this.market) throw new Error('选股引擎缺少 MarketService（无法读本地库）')
    return this.market
  }

  // ── 标的池 ──────────────────────────────────────────────

  /**
   * 解析标的池。
   * @param {'local'|'watchlist'|'market'} source
   * @returns {Promise<{source, total, symbols:[{symbol,name}], missingData, note}>}
   */
  async resolveUniverse(source, opts = {}) {
    const market = this._needMarket()
    const timeframe = opts.timeframe || '1d'
    const adjust = opts.adjust || 'qfq'
    const localMeta = market.listLocalMeta().symbols || []
    const localSet = new Set(
      localMeta
        .filter((m) => (m.timeframe || '1d') === timeframe && (m.adjust || 'qfq') === adjust)
        .map((m) => m.symbol),
    )

    if (source === 'watchlist') {
      const raw = Array.isArray(opts.symbols) ? opts.symbols : []
      const symbols = []
      const seen = new Set()
      for (const s of raw) {
        let sym = null
        try { sym = market.normalizeSymbol?.(s) || String(s || '').toUpperCase() } catch { sym = null }
        if (!sym || seen.has(sym)) continue
        seen.add(sym)
        symbols.push({ symbol: sym, name: null })
      }
      return {
        source: 'watchlist',
        total: symbols.length,
        symbols,
        missingData: symbols.filter((x) => !localSet.has(x.symbol)).length,
        note: '自选股池由调用方传入',
      }
    }

    if (source === 'market') {
      if (!market.getStockUniverse) throw new Error('全市场标的池不可用（MarketService 缺少 getStockUniverse）')
      const uni = await market.getStockUniverse()
      const all = Array.isArray(uni?.symbols) ? uni.symbols : []
      const symbols = all.filter((x) => localSet.has(x.symbol))
      return {
        source: 'market',
        total: all.length,
        symbols,
        missingData: Math.max(0, all.length - symbols.length),
        note: `全市场 ${all.length} 只，其中本地库有数据的 ${symbols.length} 只；`
          + `缺数据的 ${Math.max(0, all.length - symbols.length)} 只未参与计算`,
      }
    }

    // 默认 local：本地库已落库的标的
    const symbols = localMeta
      .filter((m) => (m.timeframe || '1d') === timeframe && (m.adjust || 'qfq') === adjust)
      .map((m) => ({ symbol: m.symbol, name: null }))
    return {
      source: 'local',
      total: symbols.length,
      symbols,
      missingData: 0,
      note: '本地库已落库的标的',
    }
  }

  // ── 任务 ────────────────────────────────────────────────

  /** 取公式文本（id / name / 直接文本 三选一） */
  _resolveFormula(opts) {
    if (opts.formulaId) {
      const f = this.formulas?.get?.(String(opts.formulaId))
      if (!f) throw new Error('找不到公式：' + opts.formulaId)
      return { id: f.id, name: f.name, text: f.text }
    }
    if (opts.name) {
      const f = this.formulas?.findByName?.(String(opts.name), opts.symbol)
      if (!f) throw new Error('找不到公式：' + opts.name)
      return { id: f.id, name: f.name, text: f.text }
    }
    if (typeof opts.text === 'string' && opts.text.trim() !== '') {
      return { id: null, name: '（临时公式）', text: opts.text }
    }
    throw new Error('必须提供 formulaId / name / text 之一')
  }

  /**
   * 启动选股任务。立刻返回任务快照；后台分批执行，用 status(jobId) 轮询。
   */
  async start(opts = {}) {
    const job = {
      id: randomUUID(),
      state: 'running',
      createdAt: Date.now(),
      finishedAt: null,
      formula: null,
      universe: null,
      params: {
        timeframe: opts.timeframe || '1d',
        adjust: opts.adjust || 'qfq',
        count: Math.min(Math.max(Number(opts.count) || 500, 60), 800),
        latestOnly: opts.latestOnly === true,
      },
      progress: { total: 0, done: 0, hit: 0, missing: 0, failed: 0 },
      results: [],
      errors: [],
      cached: false,
      cancelled: false,
      error: null,
    }
    this.jobs.set(job.id, job)
    trimJobs(this.jobs, MAX_JOBS)

    job.promise = this._run(job, opts).catch((e) => {
      job.state = 'failed'
      job.error = e?.message || String(e)
      job.finishedAt = Date.now()
    })
    return this.status(job.id)
  }

  async _run(job, opts) {
    const formula = this._resolveFormula(opts)
    job.formula = { id: formula.id, name: formula.name }

    const info = analyze(formula.text)
    if (!info.ok) {
      job.state = 'failed'
      job.error = '公式无法计算：' + info.errors.join('；')
      job.finishedAt = Date.now()
      return
    }
    if (info.futureFunctions.length > 0 && opts.allowFutureFunctions !== true) {
      job.state = 'failed'
      job.error = `公式含未来函数（${info.futureFunctions.join('、')}），已拒绝选股：`
        + '它会重画历史，用它选出的结果不具有可验证性。'
      job.finishedAt = Date.now()
      return
    }

    const uni = await this.resolveUniverse(opts.universe || 'local', opts)
    job.universe = {
      source: uni.source,
      total: uni.total,
      // evaluated 先按"meta 登记"记；真正的口径在跑完后由 _finalizeUniverse() 用
      // "done − missing" 重算——因为 meta 里登记了、文件却被删掉的标的其实没算。
      evaluated: uni.symbols.length,
      missingData: uni.missingData,
      note: uni.note,
    }
    job.progress.total = uni.symbols.length
    if (uni.symbols.length === 0) {
      this._finalizeUniverse(job)
      job.state = 'done'
      job.finishedAt = Date.now()
      job.error = uni.note || '标的池为空'
      return
    }

    const market = this._needMarket()
    // 缓存键：公式文本 + 参数 + 标的池 + 数据版本（数据一变就失效）
    const dataVersion = market.localDataVersion(uni.symbols.map((x) => x.symbol), job.params.timeframe, job.params.adjust)
    const key = createHash('sha256').update(JSON.stringify({
      text: formula.text,
      params: job.params,
      universe: uni.source,
      symbols: uni.symbols.map((x) => x.symbol),
      dataVersion,
      allowFuture: opts.allowFutureFunctions === true,
    })).digest('hex')

    if (opts.useCache !== false) {
      const hit = this.cache.get(key)
      if (hit) {
        job.results = hit.results
        job.progress = { ...hit.progress }
        job.universe = { ...hit.universe }   // 用缓存里的口径（evaluated/missingData 是实际值，不是估算）
        job.state = 'done'
        job.cached = true
        job.finishedAt = Date.now()
        job.cacheKey = key
        return
      }
    }
    job.cacheKey = key

    const { timeframe, adjust, count, latestOnly } = job.params
    const list = uni.symbols

    for (let i = 0; i < list.length; i += this.batchSize) {
      if (job.cancelled) break
      const slice = list.slice(i, i + this.batchSize)
      for (const item of slice) {
        if (job.cancelled) break
        const symbol = item.symbol
        let bars = null
        try {
          bars = market.getLocalKline(symbol, { timeframe, adjust, count })
        } catch {
          bars = null
        }
        if (!Array.isArray(bars) || bars.length === 0) {
          job.progress.missing++
          continue
        }
        const r = run(formula.text, bars, { allowFutureFunctions: opts.allowFutureFunctions === true })
        if (!r.ok) {
          // 公式本身算不出来（不是单个标的问题）：立刻终止，别把 5000 个错误都跑一遍
          job.state = 'failed'
          job.error = '公式计算失败：' + (r.errors || []).join('；')
          job.finishedAt = Date.now()
          return
        }
        const sig = signalsFrom(r)
        if (!sig.ok) {
          job.state = 'failed'
          job.error = sig.reason
          job.finishedAt = Date.now()
          return
        }
        if (sig.indices.length === 0) continue
        if (latestOnly && sig.indices[sig.indices.length - 1] !== bars.length - 1) continue

        const last = bars[bars.length - 1]
        const prev = bars[bars.length - 2]
        const hitIndex = sig.indices[sig.indices.length - 1]
        job.results.push({
          symbol,
          name: item.name || null,
          hitCount: sig.indices.length,
          lastHitDate: bars[hitIndex]?.time || null,
          lastHitIndex: hitIndex,
          close: typeof last?.close === 'number' ? last.close : null,
          changePct: (last && prev && typeof prev.close === 'number' && prev.close !== 0)
            ? Math.round(((last.close - prev.close) / prev.close) * 10000) / 100
            : null,
        })
      }
      job.progress.done = Math.min(i + slice.length, list.length)
      // 让出事件循环：否则进度/取消都要等整批跑完
      await new Promise((resolve) => setImmediate(resolve))
    }

    job.progress.hit = job.results.length
    job.results.sort((a, b) => String(b.lastHitDate || '').localeCompare(String(a.lastHitDate || ''))
      || b.hitCount - a.hitCount || a.symbol.localeCompare(b.symbol))
    job.state = job.cancelled ? 'cancelled' : 'done'
    job.finishedAt = Date.now()
    if (job.state === 'done') {
      this._finalizeUniverse(job)
    } else {
      // 取消 ≠ 缺数据：没跑到的标的只是"未评估"，不能算进 missingData
      const done = Number(job.progress.done) || 0
      const missing = Number(job.progress.missing) || 0
      const evaluated = Math.max(0, done - missing)
      const total = Number(job.universe?.total) || 0
      job.universe = {
        ...job.universe,
        evaluated,
        missingData: Number(job.universe?.missingData) || 0,
        note: `任务已取消：只评估了 ${evaluated}/${total} 只，其余未评估（不代表缺数据）`,
      }
    }

    if (job.state === 'done') {
      this.cache.set(key, {
        progress: { ...job.progress },
        results: job.results,
        universe: { ...job.universe },
        at: Date.now(),
      })
      // 缓存别无限长：只留最近 20 条
      if (this.cache.size > 20) {
        const oldest = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, this.cache.size - 20)
        for (const [k] of oldest) this.cache.delete(k)
      }
    }
  }

  /**
   * 用**实际执行结果**修正标的池口径。
   *
   * 为什么需要：`resolveUniverse` 只能看 meta.db 的登记（便宜），但 meta 里登记了、
   * 文件却被删掉的标的是"算不了"的——它们会计入 `progress.missing`。若 `universe.evaluated`
   * 仍按 meta 登记数报，就会**高估可算标的、低估缺数据**（而缺数据恰恰是最不能糊弄的数字）。
   * 因此跑完后统一用 `done − missing` 重算，并重写 note。
   */
  _finalizeUniverse(job) {
    if (!job.universe) return
    const done = Number(job.progress.done) || 0
    const missing = Number(job.progress.missing) || 0
    const evaluated = Math.max(0, done - missing)
    const total = Number(job.universe.total) || 0
    const missingData = Math.max(0, total - evaluated)
    const source = job.universe.source
    const note = source === 'market'
      ? `全市场 ${total} 只，其中实际可算 ${evaluated} 只（本地库有数据）；`
        + `缺数据 ${missingData} 只未参与计算——缺数据 ≠ 不满足条件`
      : `共 ${total} 只，实际可算 ${evaluated} 只；缺数据 ${missingData} 只未参与计算——缺数据 ≠ 不满足条件`
    job.universe = { ...job.universe, evaluated, missingData, note }
  }

  status(id) {
    const job = this.jobs.get(String(id))
    if (!job) return null
    const elapsed = (job.finishedAt || Date.now()) - job.createdAt
    return {
      id: job.id,
      state: job.state,
      createdAt: new Date(job.createdAt).toISOString(),
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      elapsedMs: elapsed,
      formula: job.formula,
      universe: job.universe,
      params: job.params,
      progress: job.progress,
      results: job.results.slice(0, MAX_RESULTS),
      resultsTruncated: job.results.length > MAX_RESULTS,
      errors: job.errors.slice(0, MAX_ERRORS),
      cached: job.cached,
      error: job.error,
    }
  }

  cancel(id) {
    const job = this.jobs.get(String(id))
    if (!job) return { ok: false, error: '任务不存在' }
    if (job.state !== 'running') return { ok: false, error: '任务已结束（' + job.state + '）', state: job.state }
    job.cancelled = true
    return { ok: true, id: job.id }
  }

  list() {
    return [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 10)
      .map((j) => ({
        id: j.id,
        state: j.state,
        formula: j.formula,
        universe: j.universe,
        progress: j.progress,
        createdAt: new Date(j.createdAt).toISOString(),
        elapsedMs: (j.finishedAt || Date.now()) - j.createdAt,
      }))
  }

  /** 等任务结束（AI 工具用；UI 用轮询） */
  async waitFor(id, timeoutMs = 120000) {
    const job = this.jobs.get(String(id))
    if (!job) return null
    if (job.state !== 'running') return this.status(id)
    let timer
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs) })
    const got = await Promise.race([job.promise || Promise.resolve(), timeout])
    clearTimeout(timer)
    if (got === 'timeout') {
      job.cancelled = true
      return { ...this.status(id), error: `选股超时（>${Math.round(timeoutMs / 1000)}s），已请求取消；可缩小标的池后重试` }
    }
    return this.status(id)
  }
}
