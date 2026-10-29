/**
 * index.js — dsh-stock-lab Host 入口
 *
 * 职责：
 *   1. 创建 MarketService（唯一数据入口）
 *   2. 注册 AI Tools（只调 MarketService）
 *   3. 持有 StockContext（UI 状态 → LLM）
 *   4. 注册 webServer 路由（Client UI 取数）
 *   5. 注册 stock-lab skill（研究方法论与合规约束）
 *
 * 架构铁律：本文件不得直接 import datasource/*。取数一律走 market。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MarketService } from './services/market-service/index.js'
import { ResearchStore } from './services/research-service/research-store.js'
import { registerStockTools } from './tools/index.js'
import { registerResearchTools } from './tools/research-tools.js'
import { registerQuantTools } from './tools/quant-tools.js'
import { registerWatchTools } from './tools/watch-tools.js'
import { registerFormulaTools } from './tools/formula-tools.js'
import { registerDrawingTools } from './tools/drawing-tools.js'
import { FormulaStore } from './services/formula-service/formula-store.js'
import { ScreenService } from './services/screen-service/index.js'
import { DrawingStore } from './services/drawing-service/drawing-store.js'
import { WatchService } from './services/watch-service/index.js'
import { ChatService } from './services/chat-service/index.js'
import { createStockContext } from './context/stock-context.js'

export const name = 'stock-lab'
// tools / skills 是可选依赖：存在才注册，不存在不影响行情 UI。
// 宿主里两者都是常驻服务（见 inspect Service.listService），因此一并注入。
export const inject = ['webServer', 'tools', 'skills']

/** A 股交易时段（本地时区 +08:00）：09:30–11:30、13:00–15:00，周末不算 */
function isTradingTime(now = new Date()) {
  const cn = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }))
  const day = cn.getDay()
  if (day === 0 || day === 6) return false
  const mins = cn.getHours() * 60 + cn.getMinutes()
  return (mins >= 570 && mins <= 690) || (mins >= 780 && mins <= 900)
}

const PREFIX = '/stock-lab'

export function apply(ctx) {
  const market = new MarketService({ log: (m) => ctx.logger?.info?.('[stock-lab] ' + m) })
  const stockContext = createStockContext(ctx)
  // Research Notebook 存储（SQLite + markdown 落盘）
  let research = null
  try {
    research = new ResearchStore()
  } catch (e) {
    ctx.logger?.warn?.('stock-lab: 研究库初始化失败（研究笔记功能不可用）%s', e?.message || e)
  }

  // Watch Engine（盯盘规则 + 触发记录）
  let watch = null
  try {
    watch = new WatchService({
      market,
      research,
      log: (m) => ctx.logger?.info?.('[watch] ' + m),
    })
    // 触发时写日志（后续可接 DSH 提醒）
    watch.onTrigger = (trigger) => {
      ctx.logger?.info?.('[watch] 触发 %s %s: %s', trigger.severity, trigger.symbol, trigger.title)
    }
  } catch (e) {
    ctx.logger?.warn?.('stock-lab: 盯盘引擎初始化失败 %s', e?.message || e)
  }

  // 通达信公式库
  let formulas = null
  try {
    formulas = new FormulaStore()
  } catch (e) {
    ctx.logger?.warn?.('stock-lab: 公式库初始化失败（TDX 公式功能不可用）%s', e?.message || e)
  }

  // 公式选股引擎（T5.7）：只读本地库、分批求值、可取消
  let screen = null
  try {
    screen = new ScreenService({ formulas, market, log: (m) => ctx.logger?.info?.('[screen] ' + m) })
  } catch (e) {
    ctx.logger?.warn?.('stock-lab: 选股引擎初始化失败 %s', e?.message || e)
  }

  // 手工画线（图表标注）：JSON 落在数据根目录，便于备份、手工查看、以及被 AI 读写
  let drawings = null
  try {
    drawings = new DrawingStore()
  } catch (e) {
    ctx.logger?.warn?.('stock-lab: 画线库初始化失败（图表标注不可用）%s', e?.message || e)
  }

  // ── AI Tools ──
  //
  // 注册的同时**收集一份本地白名单**（name → 定义）。
  // 为什么需要它：自建的右栏 Chat 要自己调模型，而 `ctx.tools.schemas()` 会把
  // agent 自有的 read/write/bash 等工具一起暴露出去——那些绝不该出现在一个
  // 聊天面板里。因此 Chat 只暴露本插件自己的工具，且直接调本进程的 execute。
  const localTools = new Map()
  const toolsServiceMissing = ctx.tools === undefined
  if (toolsServiceMissing) {
    // 注意：这里不能直接 return。tools 服务缺失只是"无法把工具注册给 agent"，
    // 右栏 Chat 仍可直接调用这些 execute，所以白名单照样要收集起来。
    ctx.logger?.warn?.('stock-lab: tools 服务不可用，AI 工具未注册为模型工具（右栏对话仍可调用）')
  }
  const toolRegistrar = {
    logger: ctx.logger,
    skills: ctx.skills,
    effect: ctx.effect,
    get: (k) => ctx.get?.(k),
    tools: {
      register: (def) => {
        if (def && def.name) localTools.set(def.name, def)
        if (toolsServiceMissing) return () => {}
        return ctx.tools.register(def)
      },
    },
  }
  try {
    registerStockTools(toolRegistrar, market)
    if (research) registerResearchTools(toolRegistrar, research, market)
    registerQuantTools(toolRegistrar)
    if (watch) registerWatchTools(toolRegistrar, watch)
    if (formulas) registerFormulaTools(toolRegistrar, formulas, market, screen)
    if (drawings) registerDrawingTools(toolRegistrar, drawings, market, stockContext)
  } catch (e) {
    ctx.logger?.warn?.('stock-lab: tool 注册失败 %s', e?.message || e)
  }

  // ── Stock Lab Chat（自建对话：ctx.llm + 本插件工具白名单） ──
  let chat = null
  try {
    let skillText = ''
    try {
      const here = dirname(fileURLToPath(import.meta.url))
      skillText = readFileSync(join(here, '..', 'skill.md'), 'utf8')
    } catch { /* skill.md 缺失时仍可对话，只是少方法论约束 */ }
    chat = new ChatService({
      llm: ctx.get?.('llm'),
      selection: () => {
        try {
          const picker = ctx.get?.('agentDefaultModel')
          const sel = picker && typeof picker.currentSelection === 'function' ? picker.currentSelection() : null
          return sel ? { provider: sel.provider, model: sel.model } : null
        } catch { return null }
      },
      tools: localTools,
      systemBase: skillText,
      market,
      logger: ctx.logger,
    })
    if (!ctx.get?.('llm')) {
      ctx.logger?.info?.('stock-lab: llm 服务不可用，右栏 Chat 将给出可读提示而非崩溃')
    }
  } catch (e) {
    ctx.logger?.warn?.('stock-lab: 对话服务初始化失败 %s', e?.message || e)
  }

  // ── 周期评估（交易时段内每 N 分钟自动检查一次） ──
  if (watch) {
    const INTERVAL_MIN = Number(process.env.DSH_STOCK_LAB_WATCH_MINUTES) || 5
    const INTERVAL_MS = Math.max(INTERVAL_MIN, 1) * 60000
    ctx.effect(() => {
      const timerSvc = ctx.get?.('timer')
      if (timerSvc === undefined || typeof timerSvc.interval !== 'function') {
        ctx.logger?.info?.('stock-lab: timer 服务不可用，盯盘改为仅手动/工具触发')
        return () => {}
      }
      const dispose = timerSvc.interval(async () => {
        try {
          const rules = watch.listRules({ enabledOnly: true })
          if (rules.length === 0) return
          if (!isTradingTime()) return
          const r = await watch.evaluateAll({})
          if (r.fired > 0) ctx.logger?.info?.('stock-lab: 盯盘触发 %d 条', r.fired)
        } catch (e) {
          ctx.logger?.warn?.('stock-lab: 周期评估异常 %s', e?.message || e)
        }
      }, INTERVAL_MS)
      return dispose
    }, 'stock-lab:watch-loop')
  }

  // ── skill（随插件分发，内含研究方法论与合规红线） ──
  try {
    if (ctx.skills !== undefined) {
      const here = dirname(fileURLToPath(import.meta.url))
      const body = readFileSync(join(here, '..', 'skill.md'), 'utf8')
      ctx.skills.register({
        name: 'stock-lab',
        description: 'A股智能研究工作台：查看行情/K线、分析个股相对强弱、检索新闻财务、形成可验证的研究假设并复盘。涉及投资建议时按合规红线处理。',
        content: body,
        source: 'bundled',
      })
    }
  } catch (e) {
    ctx.logger?.warn?.('stock-lab: skill 注册失败 %s', e?.message || e)
  }

  // ── HTTP 路由（供 Client UI 调用；UI 不直连任何行情 API） ──
  //
  // 两种注册方式：
  //   route(path, handler)      —— 常规 JSON 路由，返回值包成 {ok,data} 自动发送
  //   rawRoute(path, handler)   —— 原始 req/res，用于 SSE 长连接（自己写响应）
  const route = (path, handler) => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + path,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const query = Object.fromEntries(url.searchParams.entries())
          const body = req.method === 'POST' ? await readJson(req) : {}
          const data = await handler(query, body)
          sendJson(res, 200, { ok: true, data })
        } catch (error) {
          sendJson(res, 200, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }), `stock-lab:route:${path}`)
  }

  const rawRoute = (path, handler) => {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: PREFIX + path,
      handler: async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const query = Object.fromEntries(url.searchParams.entries())
          await handler(req, res, query)
        } catch (error) {
          try {
            res.statusCode = 200
            res.setHeader('content-type', 'application/json; charset=utf-8')
            res.end(JSON.stringify({ ok: false, error: String((error && error.message) || error) }))
          } catch { /* 响应可能已开始，无法再写 */ }
        }
      },
    }), `stock-lab:rawroute:${path}`)
  }

  route('/health', async () => ({ ok: true, plugin: name, version: '0.0.1' }))
  route('/overview', async () => market.getMarketOverview())
  route('/quote', async (q) => market.getQuotes(String(q.symbols || '').split(',').filter(Boolean)))
  route('/kline', async (q) => market.getKline(String(q.symbol || ''), {
    timeframe: q.timeframe || '1d',
    adjust: q.adjust || 'qfq',
    count: Number(q.count) || 320,
  }))
  route('/minute', async (q) => market.getMinute(String(q.symbol || '')))
  route('/search', async (q) => market.search(String(q.q || '')))
  route('/profile', async (q) => market.getCompanyProfile(String(q.symbol || '')))
  route('/financials', async (q) => market.getFinancials(String(q.symbol || '')))
  route('/moneyflow', async (q) => market.getMoneyFlow(String(q.symbol || '')))
  route('/news', async (q) => market.getNews(String(q.symbol || ''), { limit: Number(q.limit) || 10 }))
  // 行业/板块
  route('/sectors', async (q) => market.getSectorList({
    type: q.type || 'industry', sort: q.sort || 'changePct', limit: Number(q.limit) || 20,
  }))
  route('/sector', async (q) => market.getSector(String(q.id || '')))
  route('/sector/members', async (q) => market.getSectorMembers(String(q.id || ''), { limit: Number(q.limit) || 20 }))
  route('/stock-sector', async (q) => market.getStockSector(String(q.symbol || '')))
  // GET 读取当前 UI 状态；POST 更新（Context-aware AI）
  route('/context', async (_q, body) => {
    if (body && Object.keys(body).length > 0) {
      return { updated: true, state: stockContext.update(body) }
    }
    return { updated: false, state: stockContext.get() }
  })

  // ── Research Notebook ──
  const noResearch = () => { throw new Error('研究库不可用（初始化失败）') }
  route('/research/list', async (q) => {
    if (!research) noResearch()
    return {
      notes: research.list({
        symbol: q.symbol, status: q.status,
        dueOnly: q.due === '1' || q.due === 'true',
        limit: Number(q.limit) || 50,
      }),
    }
  })
  route('/research/due', async () => (research ? research.due() : []))
  route('/research/stats', async () => (research ? research.stats() : { total: 0, open: 0, reviewed: 0, byVerdict: [] }))
  route('/research/get', async (q) => {
    if (!research) noResearch()
    const n = research.get(String(q.id || ''))
    if (!n) throw new Error('note 不存在')
    return n
  })
  route('/research/create', async (_q, body) => {
    if (!research) noResearch()
    return research.create(body || {})
  })
  route('/research/review', async (_q, body) => {
    if (!research) noResearch()
    return research.review(String(body?.id || ''), {
      verdict: body?.verdict, reviewNotes: body?.reviewNotes, actualOutcome: body?.actualOutcome,
    })
  })
  route('/research/delete', async (_q, body) => {
    if (!research) noResearch()
    return { deleted: research.delete(String(body?.id || '')) }
  })

  // ── Quant Engine（Python 子进程） ──
  route('/quant/event-study', async (q) => {
    const { runPythonJson } = await import('./services/quant-bridge/index.js')
    let params = {}
    try { params = q.params ? JSON.parse(String(q.params)) : {} } catch { params = {} }
    return runPythonJson('quant/event_study.py', [
      '--symbol', String(q.symbol || ''),
      '--condition', String(q.condition || ''),
      '--horizon', String(Number(q.horizon) || 5),
      '--benchmark', String(q.benchmark || 'IDX000300'),
      '--params', JSON.stringify(params),
    ])
  })
  route('/quant/collect', async (_q, body) => {
    const { runPythonJson } = await import('./services/quant-bridge/index.js')
    const symbols = Array.isArray(body?.symbols) ? body.symbols : []
    if (symbols.length === 0) throw new Error('symbols 不能为空')
    return runPythonJson('collectors/collector.py', [
      'fetch-many', ...symbols.map(String),
      '--count', String(Number(body.count) || 500),
      '--adjust', String(body.adjust || 'qfq'),
    ])
  })
  route('/quant/status', async () => {
    const { runPythonJson } = await import('./services/quant-bridge/index.js')
    return runPythonJson('collectors/collector.py', ['status'])
  })
  route('/quant/python', async () => {
    const { isPythonAvailable, pythonDiagnostics } = await import('./services/quant-bridge/index.js')
    return { available: await isPythonAvailable(), diagnostics: pythonDiagnostics() }
  })

  // ── 本地历史库 ──
  route('/local/status', async () => {
    const { resolveDataRoot, dataRootCandidates } = await import('./data-root.js')
    return {
      ...market.getLocalDataStatus(),
      resolvedRoot: resolveDataRoot(),
      candidates: dataRootCandidates(),
    }
  })
  route('/local/version', async (q) => ({
    symbols: String(q.symbols || '').split(',').filter(Boolean),
    version: market.getDataVersion(String(q.symbols || '').split(',').filter(Boolean), {
      timeframe: q.timeframe || '1d', adjust: q.adjust || 'qfq',
    }),
  }))

  // ── Stock Lab Chat（右栏对话） ──
  const noChat = () => { throw new Error('对话服务不可用（初始化失败）') }
  route('/chat/info', async () => ({
    available: !!chat,
    llmMounted: ctx.get?.('llm') !== undefined,
    model: (() => {
      try {
        const sel = ctx.get?.('agentDefaultModel')?.currentSelection?.()
        return sel ? { provider: sel.provider, model: sel.model } : null
      } catch { return null }
    })(),
    toolCount: chat ? chat.toolNames().length : 0,
    tools: chat ? chat.toolNames() : [],
    stats: chat ? chat.stats() : null,
  }))
  route('/chat/threads', async (q) => {
    if (!chat) noChat()
    return {
      threads: chat.listThreads({ limit: Number(q.limit) || 100 }),
      stats: chat.stats(),
    }
  })
  route('/chat/messages', async (q) => {
    if (!chat) noChat()
    const r = chat.listMessages(q.symbol || q.thread || GLOBAL_THREAD, {
      limit: Number(q.limit) || 200,
      tail: Number(q.tail) || undefined,
    })
    return r
  })
  route('/chat/send', async (_q, body) => {
    if (!chat) noChat()
    const symbol = body?.symbol || GLOBAL_THREAD
    const text = String(body?.text || '')
    const { runId, thread } = chat.start({ symbol, text })
    return { runId, threadId: thread.id, symbol: thread.symbol, title: thread.title }
  })
  route('/chat/cancel', async (_q, body) => {
    if (!chat) noChat()
    return chat.cancel(String(body?.runId || ''))
  })
  route('/chat/run', async (q) => {
    if (!chat) noChat()
    const r = chat.getRun(String(q.runId || ''))
    if (!r) throw new Error('run 不存在或已清理')
    return r
  })
  route('/chat/delete-thread', async (_q, body) => {
    if (!chat) noChat()
    return { deleted: chat.deleteThread(body?.symbol || GLOBAL_THREAD) }
  })

  // 一次性跑完（非流式）：便于在没有 SSE 的场合验证，也便于工具/脚本调用
  route('/chat/ask', async (_q, body) => {
    if (!chat) noChat()
    const symbol = body?.symbol || GLOBAL_THREAD
    const text = String(body?.text || '')
    const { runId } = chat.start({ symbol, text })
    // 等 run 结束（带超时，避免请求悬挂）
    const timeoutMs = Math.min(Math.max(Number(body?.timeoutMs) || 120000, 5000), 300000)
    const started = Date.now()
    for (;;) {
      const r = chat.getRun(runId)
      if (!r) throw new Error('run 意外消失')
      if (r.done) return { runId, ...r.result }
      if (Date.now() - started > timeoutMs) return { runId, ok: false, error: '等待超时（仍在后台运行，可用 /chat/run 查看）' }
      await new Promise((res) => setTimeout(res, 250))
    }
  })

  // SSE：把一个 run 的事件流式推给前端（用 rawRoute，因为要自己持有 res）
  rawRoute('/chat/stream', async (req, res, q) => {
    res.setHeader('content-type', 'text/event-stream; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('connection', 'keep-alive')
    const send = (obj) => {
      try { res.write('data: ' + JSON.stringify(obj) + '\n\n') } catch { /* 客户端断开 */ }
    }
    if (!chat) {
      send({ type: 'error', message: '对话服务不可用（初始化失败）' })
      res.end()
      return
    }
    const runId = String(q.runId || '')
    const unsubscribe = chat.subscribe(runId, (evt) => {
      if (evt === null) { try { res.end() } catch { /* ignore */ } ; return }
      send(evt)
    })
    if (unsubscribe === null) {
      send({ type: 'error', message: 'run 不存在或已清理' })
      res.end()
      return
    }
    // 客户端断开时退订，避免订阅者泄漏
    req.on?.('close', () => { try { unsubscribe() } catch { /* ignore */ } })
  })

  // ── 图表画线（标注）──
  // 锚点是「日期 + 价格」，并记录画线时的复权模式（见 drawing-store.js 的说明）
  const noDrawings = () => { throw new Error('画线库不可用（初始化失败）') }
  route('/drawings', async (q) => {
    if (!drawings) noDrawings()
    const r = drawings.list(String(q.symbol || ''))
    return { symbol: r.symbol, drawings: r.drawings, warnings: r.warnings }
  })
  route('/drawings/stats', async () => {
    if (!drawings) noDrawings()
    return drawings.stats()
  })
  route('/drawings/add', async (_q, body) => {
    if (!drawings) noDrawings()
    const r = drawings.add(body?.symbol, body || {})
    if (!r.ok) throw new Error(r.errors.join('；'))
    const after = drawings.list(body.symbol)
    return { saved: after.drawings.length, path: r.path, drawing: after.drawings[after.drawings.length - 1] || null }
  })
  route('/drawings/remove', async (_q, body) => {
    if (!drawings) noDrawings()
    const r = drawings.remove(body?.symbol, String(body?.id || ''))
    if (!r.ok) throw new Error(r.errors.join('；'))
    return { removed: true }
  })

  // ── 通达信公式 ──
  const noFormula = () => { throw new Error('公式库不可用（初始化失败）') }
  route('/formula/list', async (q) => {
    if (!formulas) noFormula()
    return {
      formulas: formulas.list({
        symbol: q.symbol,
        onlySymbol: q.scope === 'symbol' ? q.symbol : undefined,
        okOnly: q.okOnly === '1',
        limit: Number(q.limit) || 100,
      }),
      stats: formulas.stats(),
    }
  })
  route('/formula/analyze', async (_q, body) => {
    const { analyze } = await import('./services/formula-service/index.js')
    const text = String(body?.text || '')
    if (body?.filePath) {
      // 文件路径导入复用工具层的读取逻辑（含 GBK 兜底与体积上限）
      const { readFormulaFileText } = await import('./services/formula-service/read-file.js')
      return analyze(readFormulaFileText(String(body.filePath)))
    }
    return analyze(text)
  })
  route('/formula/import', async (_q, body) => {
    if (!formulas) noFormula()
    const { analyze } = await import('./services/formula-service/index.js')
    let text = body?.text
    let sourceRef = null
    if (!text && body?.filePath) {
      const { readFormulaFileText } = await import('./services/formula-service/read-file.js')
      text = readFormulaFileText(String(body.filePath))
      sourceRef = String(body.filePath)
    }
    if (!text) throw new Error('需要 text 或 filePath')
    const info = analyze(text)
    return formulas.create({
      name: String(body?.name || '未命名公式'),
      symbol: body?.symbol,
      source: body?.filePath ? 'file' : 'manual',
      sourceRef,
      text,
      ok: info.ok,
      errors: info.errors,
      warnings: info.warnings,
      outputs: info.outputs,
      futureFunctions: info.futureFunctions,
      ignoredDrawCalls: info.ignoredDrawCalls,
      usedFunctions: info.usedFunctions,
    })
  })
  // 对某标的求值（返回数值序列，供图表叠加）
  route('/formula/run', async (q) => {
    if (!formulas) noFormula()
    const { run, signalsFrom } = await import('./services/formula-service/index.js')
    const f = q.id ? formulas.get(String(q.id)) : formulas.findByName(String(q.name || ''), q.symbol)
    if (!f) throw new Error('找不到公式：' + (q.id || q.name))
    const count = Number(q.count) || 500
    // 公式在「图表当前显示的那批 K 线」上求值，因此周期与复权要跟随图表，
    // 否则切到周线/月线时刻线与柱体会错位。
    const timeframe = String(q.timeframe || '1d')
    const adjust = String(q.adjust || 'qfq')
    const info = await market.getKlineInfo(String(q.symbol || ''), { timeframe, adjust, count })
    const allowFuture = q.allowFuture === '1'
    const r = run(f.text, info.bars, { allowFutureFunctions: allowFuture })
    if (r.ok) formulas.touchRun(f.id)
    const signals = signalsFrom(r)
    return {
      ok: r.ok,
      formula: { id: f.id, name: f.name },
      timeframe,
      adjust,
      errors: r.errors,
      warnings: r.warnings,
      futureFunctions: r.futureFunctions,
      ignoredDrawCalls: r.ignoredDrawCalls,
      barCount: r.barCount,
      range: { start: info.bars[0]?.time ?? null, end: info.bars.at(-1)?.time ?? null },
      times: info.bars.map((b) => b.time),
      outputs: (r.outputs || []).map((o) => ({ name: o.name, attrs: o.attrs, validCount: o.validCount, values: o.values })),
      signals: signals.ok ? { conditionName: signals.conditionName, indices: signals.indices } : { notACondition: signals.reason },
      provenance: info.provenance,
    }
  })
  route('/formula/delete', async (_q, body) => {
    if (!formulas) noFormula()
    return { deleted: formulas.delete(String(body?.id || '')) }
  })
  route('/formula/capabilities', async () => {
    const { supportedFunctionNames } = await import('./services/formula-service/index.js')
    return { supportedFunctions: supportedFunctionNames(), stats: formulas ? formulas.stats() : null }
  })

  // ── 公式选股（T5.7）──
  // ⚠️ 这里必须是「不可用才抛」，不是无条件抛：
  // 曾经写成裸 `noScreen()`，结果 5 条路由 100% 报"选股引擎不可用"，
  // 而单测只数路由条数、冒烟直连 service，全都发现不了。host.test 现在会真的调一次 handler。
  const noScreen = () => { throw new Error('选股引擎不可用（初始化失败）') }
  route('/formula/screen/universes', async () => {
    if (!screen) noScreen()
    const localPool = await screen.resolveUniverse('local', {})
    let marketPool = null
    try {
      const u = await market.getStockUniverse()
      marketPool = {
        total: u.total, fetched: u.fetched, partial: u.partial,
        failedPages: u.failedPages || 0, fetchedAt: u.fetchedAt,
      }
    } catch (e) {
      marketPool = { error: e?.message || String(e) }
    }
    return { local: { total: localPool.total }, market: marketPool }
  })
  route('/formula/screen/start', async (_q, body) => {
    if (!screen) noScreen()
    return screen.start(body || {})
  })
  route('/formula/screen/status', async (q) => {
    if (!screen) noScreen()
    const id = String(q.id || q.jobId || '')
    const s = screen.status(id)
    if (!s) throw new Error('任务不存在：' + id)
    return s
  })
  route('/formula/screen/cancel', async (_q, body) => {
    if (!screen) noScreen()
    return screen.cancel(String(body?.id || body?.jobId || ''))
  })
  route('/formula/screen/jobs', async () => {
    if (!screen) noScreen()
    return { jobs: screen.list() }
  })

  // ── Watch Engine（盯盘） ──
  const noWatch = () => { throw new Error('盯盘引擎不可用（初始化失败）') }
  route('/watch/kinds', async () => {
    const { WATCH_KINDS } = await import('./services/watch-service/index.js')
    return { kinds: WATCH_KINDS, tradingTime: isTradingTime() }
  })
  route('/watch/rules', async (q) => {
    if (!watch) noWatch()
    return {
      rules: watch.listRules({
        symbol: q.symbol,
        enabledOnly: q.enabledOnly === '1' || q.enabledOnly === 'true',
      }),
      stats: watch.stats(),
    }
  })
  route('/watch/create', async (_q, body) => {
    if (!watch) noWatch()
    return watch.createRule(body || {})
  })
  route('/watch/toggle', async (_q, body) => {
    if (!watch) noWatch()
    return watch.setEnabled(String(body?.id || ''), body?.enabled !== false)
  })
  route('/watch/delete', async (_q, body) => {
    if (!watch) noWatch()
    return { deleted: watch.deleteRule(String(body?.id || '')) }
  })
  route('/watch/evaluate', async (q) => {
    if (!watch) noWatch()
    return watch.evaluateAll({ symbol: q.symbol })
  })
  route('/watch/triggers', async (q) => {
    if (!watch) noWatch()
    return {
      triggers: watch.listTriggers({
        symbol: q.symbol,
        unacknowledgedOnly: q.unack === '1' || q.unack === 'true',
        limit: Number(q.limit) || 50,
      }),
    }
  })
  route('/watch/ack', async (_q, body) => {
    if (!watch) noWatch()
    return watch.acknowledge(String(body?.id || ''), body?.acknowledged !== false)
  })
  // 待看清单：插件无法向会话推送，因此把"该看什么"聚合成一个紧凑出口，
  // 由会话侧（AI 工具 / DSH 调度提醒）来取。
  route('/watch/pending', async (q) => {
    if (!watch) noWatch()
    const triggers = watch.listTriggers({
      symbol: q.symbol, unacknowledgedOnly: true, limit: Number(q.limit) || 20,
    })
    const today = new Date().toISOString().slice(0, 10)
    const dueNotes = []
    try {
      const rules = watch.listRules({ enabledOnly: true, symbol: q.symbol })
      for (const r of rules) {
        if (r.kind !== 'hypothesis_review_due' || !r.noteId) continue
        const note = research?.get(String(r.noteId))
        if (!note || note.status === 'reviewed') continue
        if (note.reviewDate && note.reviewDate <= today) {
          dueNotes.push({
            noteId: note.id, symbol: note.symbol, name: note.name,
            reviewDate: note.reviewDate, prediction: note.prediction || null,
          })
        }
      }
    } catch { /* ignore */ }
    return { triggers, dueNotes, stats: watch.stats(), tradingTime: isTradingTime() }
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

async function readJson(req, limit = 65536) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text.trim() === '' ? {} : JSON.parse(text)
}

export { MarketService }
