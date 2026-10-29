/**
 * tools/formula-tools.js — 通达信公式相关 AI Tools
 *
 * 让用户能**在对话里**导入公式并立刻看到结果（ARCHITECTURE §13 的导入通道之一）。
 * 另一条通道是界面粘贴框（Phase 5.6 的「指标公式」tab）。
 *
 * 设计要点：
 *   - 诊断先行：`analyze` 模式只判断"能不能用、哪里不支持"，不改任何状态
 *   - 不支持的东西**如实报告**，不含糊其辞
 *   - 未来函数必须让用户显式确认才计算（因为它会让信号失真）
 */

import { analyze, run, signalsFrom, supportedFunctionNames } from '../services/formula-service/index.js'
import { readFormulaFileText, listFormulaFiles } from '../services/formula-service/read-file.js'

const OUT_TEXT = {
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
}

/**
 * 递归剔除 undefined。
 *
 * 为什么要这个：DSH 要求工具返回值是 **lossless JSON**，而 `undefined` 不是合法
 * JSON 值（`JSON.stringify` 会静默丢弃它，但宿主校验会直接报
 * "value is not lossless JSON" 并让整次工具调用失败）。
 * 因此任何可选的字段都必须落到具体值（null / [] / ''），不能留着 undefined。
 */
function jsonSafe(value) {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object') {
    // NaN / Infinity 同样不是合法 JSON
    if (typeof value === 'number' && !Number.isFinite(value)) return null
    return value
  }
  if (Array.isArray(value)) return value.map(jsonSafe)
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v)
  return out
}

export function registerFormulaTools(ctx, store, market, screen = null) {
  if (ctx.tools === undefined || !store) return 0
  let count = 0
  // 统一包一层 jsonSafe：工具返回值必须是 lossless JSON，
  // 否则宿主会以 "value is not lossless JSON" 让整次调用失败。
  const reg = (def) => {
    const run = def.execute
    ctx.tools.register({
      ...def,
      output: OUT_TEXT,
      execute: async (args, exec) => jsonSafe(await run(args, exec)),
    })
    count++
  }

  /** 取 K 线：优先本地库（可复现），本地没有则实时 */
  async function barsFor(symbol, count) {
    const info = await market.getKlineInfo(symbol, { timeframe: '1d', adjust: 'qfq', count: count || 500 })
    return { bars: info.bars, provenance: info.provenance }
  }

  reg({
    name: 'import_formula',
    description: '导入通达信（TDX）指标/选股公式。可传公式文本（text），或传本地文件路径（filePath）。'
      + '导入后会返回：解析是否成功、每条输出线、不支持的部分、以及是否含未来函数。'
      + '⚠️ 本引擎是**兼容子集**，不是完整通达信：加密公式文件（.tne 等二进制）无法解析；'
      + '跨公式引用（如 "MACD.MA1"）不支持；绘图指令（DRAWTEXT 等）会被忽略。遇到不支持会明确指出，不会给一个"看起来像"的结果。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '公式名字（同名同标的会覆盖更新）' },
        text: { type: 'string', description: '公式源码文本' },
        filePath: { type: 'string', description: '公式文件路径（.txt/.tnf 等文本格式；二进制加密文件无法解析）' },
        symbol: { type: 'string', description: '绑定到某标的（可选；不传则为通用公式）' },
        dryRun: { type: 'boolean', description: '只做诊断不保存（默认 false，即保存）' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async execute(args) {
      let text = args.text
      let sourceRef = null
      if (!text && args.filePath) {
        text = readFormulaFileText(String(args.filePath))
        sourceRef = String(args.filePath)
      }
      if (!text) throw new Error('需要提供 text（公式文本）或 filePath（公式文件路径）之一')

      const info = analyze(text)
      const payload = {
        name: args.name,
        symbol: args.symbol ? market.normalizeSymbol(args.symbol).symbol : null,
        source: args.filePath ? 'file' : 'chat',
        sourceRef,
        text,
        ok: info.ok,
        errors: info.errors,
        warnings: info.warnings,
        outputs: info.outputs,
        futureFunctions: info.futureFunctions,
        ignoredDrawCalls: info.ignoredDrawCalls,
        usedFunctions: info.usedFunctions,
      }

      // 若给出标的，顺带试算一次，让用户当场知道能不能用
      let trial = null
      if (args.symbol && info.ok) {
        try {
          const { bars, provenance } = await barsFor(args.symbol, 500)
          const r = run(text, bars, { allowFutureFunctions: info.futureFunctions.length === 0 })
          trial = {
            ok: r.ok,
            errors: r.errors,
            barCount: r.barCount,
            outputs: (r.outputs || []).map((o) => ({
              name: o.name,
              attrs: o.attrs,
              validCount: o.validCount,
              lastValue: o.values.at(-1),
              lastTime: bars.at(-1)?.time ?? null,
            })),
            provenance,
          }
        } catch (e) {
          trial = { ok: false, errors: ['试算失败：' + (e?.message || e)] }
        }
      }

      if (args.dryRun === true) {
        return {
          saved: false,
          diagnostic: payload,
          trial,
          summary: summarize(info, args.name),
        }
      }

      const saved = store.create(payload)
      return {
        saved: true,
        id: saved.id,
        name: saved.name,
        symbol: saved.symbol,
        ok: saved.ok,
        outputs: (saved.outputs || []).map((o) => o.name),
        futureFunctions: saved.futureFunctions || [],
        ignoredDrawCalls: saved.ignoredDrawCalls || [],
        errors: saved.errors || [],
        warnings: saved.warnings || [],
        trial,
        summary: summarize(info, args.name),
      }
    },
  })

  reg({
    name: 'run_formula',
    description: '对某标的运行已导入的通达信公式，返回各输出线的最近若干根数值与信号统计。'
      + '若公式是选股条件（最后一条输出线为 0/1），会额外返回命中次数与最近命中时间。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '公式名字（按名字查找；同名优先取绑定该标的的版本）' },
        id: { type: 'string', description: '公式 id（与 name 二选一，优先 id）' },
        symbol: { type: 'string', description: '要运行的标的' },
        count: { type: 'integer', minimum: 60, maximum: 800, description: '使用多少根 K 线，默认 500' },
        tail: { type: 'integer', minimum: 1, maximum: 60, description: '返回最近多少根的数值，默认 10' },
        allowFutureFunctions: { type: 'boolean', description: '允许未来函数（仅看图时用；默认 false）' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
    async execute(args) {
      const formula = args.id ? store.get(String(args.id)) : store.findByName(String(args.name || ''), args.symbol)
      if (!formula) {
        const hint = args.name
          ? `没有找到名为「${args.name}」的公式。可以先用 list_formulas 看已导入的公式。`
          : '需要提供 name 或 id'
        throw new Error(hint)
      }
      const { bars, provenance } = await barsFor(args.symbol, args.count || 500)
      const r = run(formula.text, bars, { allowFutureFunctions: args.allowFutureFunctions === true })
      if (!r.ok) {
        return { ok: false, formula: formula.name, errors: r.errors, warnings: r.warnings, futureFunctions: r.futureFunctions }
      }
      store.touchRun(formula.id)
      const tail = Math.min(Math.max(args.tail || 10, 1), 60)
      const signals = signalsFrom(r)
      return {
        ok: true,
        formula: formula.name,
        symbol: market.normalizeSymbol(args.symbol).symbol,
        barCount: r.barCount,
        range: { start: bars[0]?.time ?? null, end: bars.at(-1)?.time ?? null },
        outputs: r.outputs.map((o) => ({
          name: o.name,
          attrs: o.attrs,
          validCount: o.validCount,
          recent: o.values.slice(-tail).map((v, i) => ({
            time: bars[bars.length - tail + i]?.time ?? null,
            value: v === null ? null : Math.round(v * 10000) / 10000,
          })),
        })),
        signals: signals.ok
          ? {
            conditionName: signals.conditionName,
            hitCount: signals.indices.length,
            recentHits: signals.indices.slice(-5).map((i) => bars[i]?.time ?? null),
            hitRate: Math.round((signals.indices.length / r.barCount) * 10000) / 10000,
          }
          : { notACondition: signals.reason },
        warnings: r.warnings,
        futureFunctions: r.futureFunctions,
        provenance,
      }
    },
  })

  reg({
    name: 'list_formulas',
    description: '列出已导入的通达信公式（可只看某标的可用的，含通用公式）。返回名字、输出线、可用状态与是否含未来函数。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '只看某标的可用的公式（含通用公式）' },
        okOnly: { type: 'boolean', description: '只看解析成功的' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const list = store.list({ symbol: args.symbol, okOnly: args.okOnly === true })
      return {
        count: list.length,
        formulas: list.map((f) => ({
          id: f.id,
          name: f.name,
          symbol: f.symbol,
          source: f.source,
          ok: f.ok,
          outputs: (f.outputs || []).map((o) => o.name),
          futureFunctions: f.futureFunctions || [],
          ignoredDrawCalls: f.ignoredDrawCalls || [],
          errors: f.errors || [],
          updatedAt: f.updatedAt,
          runCount: f.runCount,
        })),
        stats: store.stats(),
      }
    },
  })

  reg({
    name: 'delete_formula',
    description: '删除一个已导入的通达信公式。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '公式 id' },
        name: { type: 'string', description: '公式名字（与 id 二选一）' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const f = args.id ? store.get(String(args.id)) : store.findByName(String(args.name || ''))
      if (!f) throw new Error('找不到该公式')
      store.delete(f.id)
      return { deleted: true, id: f.id, name: f.name }
    },
  })

  reg({
    name: 'import_formula_dir',
    description: '批量导入一个目录下的通达信公式文件（.txt/.tnf 等文本格式）。'
      + '会逐个解析并报告每个文件的成功/失败原因；加密二进制文件（.tne 等）会被列为"无法解析"而不是静默跳过。',
    parameters: {
      type: 'object',
      properties: {
        dirPath: { type: 'string', description: '目录路径' },
        symbol: { type: 'string', description: '全部绑定到某标的（可选）' },
        dryRun: { type: 'boolean', description: '只诊断不保存（默认 false）' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: '最多导入多少个，默认 50' },
      },
      required: ['dirPath'],
      additionalProperties: false,
    },
    async execute(args) {
      const files = listFormulaFiles(String(args.dirPath))
      if (files.length === 0) return { found: 0, imported: 0, results: [], note: '目录下没有可识别的公式文件' }
      const limit = Math.min(Math.max(args.limit || 50, 1), 200)
      const batch = files.slice(0, limit)
      const results = []
      let imported = 0
      for (const f of batch) {
        const baseName = f.name.replace(/\.[^.]+$/, '') || f.name
        if (f.rejected) {
          results.push({ file: f.name, imported: false, reason: f.rejected })
          continue
        }
        try {
          const text = readFormulaFileText(f.path)
          const info = analyze(text)
          if (args.dryRun === true) {
            results.push({
              file: f.name, imported: false, dryRun: true, ok: info.ok,
              errors: info.errors, outputs: info.outputs.map((o) => o.name),
              futureFunctions: info.futureFunctions,
            })
            continue
          }
          const saved = store.create({
            name: baseName,
            symbol: args.symbol,
            source: 'file',
            sourceRef: f.path,
            text,
            ok: info.ok,
            errors: info.errors,
            warnings: info.warnings,
            outputs: info.outputs,
            futureFunctions: info.futureFunctions,
            ignoredDrawCalls: info.ignoredDrawCalls,
            usedFunctions: info.usedFunctions,
          })
          imported++
          results.push({
            file: f.name, imported: true, id: saved.id, ok: saved.ok,
            outputs: (saved.outputs || []).map((o) => o.name),
            errors: (saved.errors || []).slice(0, 3),
            futureFunctions: saved.futureFunctions || [],
          })
        } catch (e) {
          results.push({ file: f.name, imported: false, reason: String(e?.message || e) })
        }
      }
      return {
        found: files.length,
        attempted: batch.length,
        imported,
        truncated: files.length > limit ? `目录下共 ${files.length} 个，本次只处理前 ${limit} 个` : null,
        results,
      }
    },
  })

  reg({
    name: 'tdx_capabilities',
    description: '查询通达信公式引擎的能力边界：支持哪些函数、不推荐哪些（未来函数）、哪些绘图指令会被忽略。在用户问"这个公式能不能用"或遇到解析失败时调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      return {
        supportedFunctions: supportedFunctionNames(),
        supportedSeries: ['OPEN/O', 'HIGH/H', 'LOW/L', 'CLOSE/C', 'VOL/V', 'AMOUNT/AMO'],
        notSupported: {
          futureFunctions: {
            list: ['ZIG', 'PEAK', 'PEAKBARS', 'TROUGH', 'TROUGHBARS', 'BACKSET', 'REFDATE'],
            why: '会随新数据重画历史（"事后诸葛亮"）。用它们判断买卖信号会得到虚假的高胜率，因此解析到就警告、默认拒绝计算。',
            workaround: '确实只是想看图时，用 run_formula 并传 allowFutureFunctions=true。',
          },
          dataDependentFunctions: {
            list: ['FINANCE', 'FINANCE_EX', 'DYNAINFO', 'CAPITAL', 'SELFDATA', 'HYBLOCK', 'INBLOCK'],
            why: '**这不是未来函数**——它们不会重画历史。真正的限制是本引擎只提供 K 线序列，拿不到财务与实时盘口数据。',
            workaround: '基本面选股（PE/ROE/流通股本等）请先用 stock_financials、stock_quote 取到数值，再另行筛选。',
          },
          notImplementedFunctions: {
            list: ['COST', 'WINNER', 'LWINNER'],
            why: '只靠 K 线理论上可算，属于本引擎的实现缺口，不是数据问题。',
          },
          ignoredDrawCalls: '绘图指令（DRAWTEXT/DRAWICON/DRAWLINE/STICKLINE/POLYLINE 等）会被忽略：输出线数值仍计算，但文字/图标/画线不显示。',
          binaryFiles: '加密的公式文件（.tne/.tnf 二进制）无法解析——这是格式限制，不是权限问题。请在通达信"公式管理器"里复制源码或导出 .txt。',
          crossFormulaRef: '跨公式引用（如 "MACD.MA1"）不支持，请把被引用的公式展开后导入。',
          unconfirmedSmoothing: '口径未确认的平滑函数（MEMA/WMA/DMA/EXPMA）未注册——宁可报不支持，也不给"看起来像"的结果。',
        },
        selection: {
          howToWrite: '选股（条件）公式的约定：**最后一条输出线必须是 0/1 条件**，例如 `XG:CROSS(MA(CLOSE,5),MA(CLOSE,20));`',
          strictness: '本引擎只在该输出线取值全为 0/1/null 时当作选股条件；写的是指标线（如 `MA5:MA(C,5);`）会被明确拒绝并说明原因，'
            + '避免把每条均线值都算成"命中"。',
          scope: '当前仅支持基于 K 线序列的**技术面选股**；含财务/实时盘口函数的公式无法运行（见 dataDependentFunctions）。',
        },
        semantics: {
          MA: '前 N-1 根无效',
          EMA: '首值取首根，alpha=2/(N+1)',
          SMA: 'Y=(M*X+(N-M)*Y)/N，首值取 X',
          STD: '总体标准差（除以 N）',
          CROSS: '当根上穿为 1，首根不可能为上穿',
        },
      }
    },
  })

  reg({
    name: 'screen_formula',
    description: '用一条通达信**选股（条件）公式**在标的池上批量选股（ROADMAP T5.7）。'
      + '只读本地历史库、不联网；缺数据的标的会如实计数，不会静默跳过。'
      + 'universe：local=本地库已落库的全部标的；watchlist=传入的 symbols；market=全市场（只评估本地有数据的）。'
      + '⚠️ 公式最后一条输出线必须是 0/1 条件（如 `XG:CROSS(MA(CLOSE,5),MA(CLOSE,20));`），'
      + '写的是指标线（如 MA5:MA(C,5);）会被明确拒绝——避免把每条均线值都算成命中。'
      + '返回命中的标的（命中次数 / 最近命中日 / 收盘价 / 当日涨跌幅），以及缺数据、失败的数量。'
      + '这是历史统计筛选，不构成投资建议。',
    parameters: {
      type: 'object',
      properties: {
        formulaId: { type: 'string', description: '已导入公式的 id（与 name / text 三选一）' },
        name: { type: 'string', description: '已导入公式的名字（与 id / text 三选一）' },
        text: { type: 'string', description: '直接给公式源码（与 id / name 三选一）' },
        universe: { type: 'string', enum: ['local', 'watchlist', 'market'], description: '标的池，默认 local' },
        symbols: { type: 'array', items: { type: 'string' }, description: 'universe=watchlist 时的标的列表' },
        latestOnly: { type: 'boolean', description: '只要"最新一根 K 线"满足条件（默认 false：历史上命中过就算）' },
        limit: { type: 'number', description: '最多返回多少条命中（默认 50，上限 200）' },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      if (!screen) throw new Error('选股引擎不可用（初始化失败）')
      const started = await screen.start({
        formulaId: args.formulaId,
        name: args.name,
        text: args.text,
        universe: args.universe || 'local',
        symbols: Array.isArray(args.symbols) ? args.symbols : undefined,
        latestOnly: args.latestOnly === true,
        count: 500,
      })
      const done = await screen.waitFor(started.id, 120000)
      if (!done) throw new Error('选股任务丢失')
      if (done.state === 'failed') {
        return { ok: false, error: done.error, formula: done.formula, universe: done.universe }
      }
      const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200)
      return {
        ok: true,
        state: done.state,
        formula: done.formula,
        universe: done.universe,
        params: done.params,
        progress: done.progress,
        elapsedMs: done.elapsedMs,
        cached: done.cached,
        results: done.results.slice(0, limit),
        resultsTruncated: done.results.length > limit,
        note: done.universe?.note || null,
        disclaimer: '历史统计筛选，不构成投资建议；缺数据的标的未参与计算，不代表它们不满足条件。',
      }
    },
  })

  return count
}

function summarize(info, name) {
  if (!info.ok) {
    return `「${name}」解析失败，共 ${info.errors.length} 处问题：` + info.errors.slice(0, 5).join('；')
  }
  const parts = [`「${name}」解析成功，${info.outputs.length} 条输出线`]
  if (info.futureFunctions?.length) parts.push(`⚠️ 含未来函数 ${info.futureFunctions.join('、')}（会让信号失真）`)
  if (info.ignoredDrawCalls?.length) parts.push(`忽略绘图指令 ${info.ignoredDrawCalls.join('、')}`)
  if (info.outputs.length === 0) parts.push('注意：没有输出线，无法在图表上显示')
  return parts.join('；')
}