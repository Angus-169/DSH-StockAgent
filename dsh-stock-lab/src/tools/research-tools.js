/**
 * tools/research-tools.js — Research Notebook 相关 AI Tools
 *
 * 这些工具让 LLM 能把一次分析固化成可复查、可推翻的研究记录，
 * 并在到期时引导用户复盘——这是 Stock Lab 区别于普通行情插件的核心。
 */

const OUT_TEXT = {
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
}

export function registerResearchTools(ctx, store, market) {
  if (ctx.tools === undefined || !store) return 0
  let count = 0
  const reg = (def) => { ctx.tools.register({ output: OUT_TEXT, ...def }); count++ }

  /**
   * 自动补上数据版本信息（可复现原则 4）。
   * 用户没显式给 dataVersion 时，按本地库实际数据算指纹；
   * 本地库里没有该标的就如实写"live"（说明这次分析用的是实时数据，不可精确复现）。
   */
  const autoDataVersion = (symbol, explicit) => {
    if (explicit) return explicit
    if (!market || typeof market.getDataVersion !== 'function') return null
    try {
      const status = market.getLocalDataStatus()
      const has = (status?.symbols || []).some((s) => s.symbol === symbol)
      if (!has) return 'live（实时接口数据，未落库，无法精确复现）'
      return `${market.getDataVersion([symbol])}（本地库）`
    } catch {
      return null
    }
  }

  reg({
    name: 'save_research_note',
    description: '把一次研究分析保存为可复查的 Research Note。用于用户形成一个明确判断（有观察、有假设、有可验证预测）时。必填 symbol/observation/hypothesis；evidence 与 counterEvidence 要分别列出支持与反对的证据（不要把推断写成事实）。保存后返回 note id 与 markdown 路径。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '股票代码，如 300750' },
        name: { type: 'string', description: '股票名称' },
        observation: { type: 'string', description: '观察到的事实（客观、可核对的数据描述，不含判断）' },
        hypothesis: { type: 'string', description: '对该现象的解释假设（明确这是假设）' },
        evidence: { type: 'array', items: { type: 'string' }, description: '支持该假设的证据，逐条列出，尽量带数值' },
        counterEvidence: { type: 'array', items: { type: 'string' }, description: '不支持或与该假设冲突的证据（必须尽力找，不能空着糊弄）' },
        prediction: { type: 'string', description: '可验证的预测，例如"未来 10 个交易日继续弱于沪深300"' },
        confidence: { type: 'number', description: '置信度 0~1' },
        reviewDate: { type: 'string', description: '复盘日期 YYYY-MM-DD' },
        benchmark: { type: 'string', description: '比较基准，默认 IDX000300' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签' },
        dataVersion: { type: 'string', description: '数据版本指纹（不填会自动按本地库实际数据生成；本地无该标的则记为"实时接口数据，未落库"）' },
      },
      required: ['symbol', 'observation', 'hypothesis'],
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const normSymbol = (() => {
          try { return market?.normalizeSymbol?.(args.symbol)?.symbol || args.symbol } catch { return args.symbol }
        })()
        const note = store.create({
          symbol: args.symbol,
          name: args.name,
          observation: args.observation,
          hypothesis: args.hypothesis,
          evidence: args.evidence,
          counterEvidence: args.counterEvidence,
          prediction: args.prediction,
          confidence: args.confidence,
          reviewDate: args.reviewDate,
          benchmark: args.benchmark || 'IDX000300',
          tags: args.tags,
          asOf: new Date().toISOString().slice(0, 10),
          dataVersion: autoDataVersion(normSymbol, args.dataVersion),
        })
        return {
          saved: true,
          id: note.id,
          symbol: note.symbol,
          status: note.status,
          reviewDate: note.reviewDate,
          dataVersion: note.dataVersion,
          note: '已保存。到期后可用 review_research_note 记录复盘结论。'
            + '（dataVersion 用于日后核对当时依据的是哪一版数据）',
        }
      } catch (e) { throw new Error(String(e?.message || e)) }
    },
  })

  reg({
    name: 'list_research_notes',
    description: '列出已保存的研究记录，可按股票或状态过滤。dueOnly=true 时只返回到了复盘日、尚未复盘的记录——主动提醒用户复盘是重要职责。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '只看某只股票' },
        status: { type: 'string', enum: ['open', 'reviewed'], description: '状态过滤' },
        dueOnly: { type: 'boolean', description: '只看到期待复盘的' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const notes = store.list({
        symbol: args.symbol,
        status: args.status,
        dueOnly: args.dueOnly === true,
        limit: args.limit || 20,
      })
      return {
        count: notes.length,
        notes: notes.map((n) => ({
          id: n.id, symbol: n.symbol, name: n.name, createdAt: n.createdAt,
          hypothesis: n.hypothesis, prediction: n.prediction,
          confidence: n.confidence, reviewDate: n.reviewDate, status: n.status, verdict: n.verdict,
        })),
      }
    },
  })

  reg({
    name: 'review_research_note',
    description: '对一条到期研究记录做复盘：记录当时判断对错（verdict: correct 完全正确 / partially 部分正确 / wrong 错误 / void 作废）、哪部分对/错、是否有遗漏信息、是否错误理解因果。复盘价值不在于"猜对了"，而在于修正认知。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'note id' },
        verdict: { type: 'string', enum: ['correct', 'partially', 'wrong', 'void'], description: '结论' },
        reviewNotes: { type: 'string', description: '复盘正文：哪部分对、哪部分错、遗漏了什么、因果理解是否有误、下次如何改进' },
        actualOutcome: { type: 'string', description: '实际发生了什么（可带数值）' },
      },
      required: ['id', 'verdict'],
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const r = store.review(args.id, {
          verdict: args.verdict,
          reviewNotes: args.reviewNotes,
          actualOutcome: args.actualOutcome,
        })
        return { reviewed: true, id: r.id, symbol: r.symbol, verdict: r.verdict, reviewedAt: r.reviewedAt }
      } catch (e) { throw new Error(String(e?.message || e)) }
    },
  })

  reg({
    name: 'research_notebook_stats',
    description: '研究笔记总览：总数、待复盘数、已复盘数、按结论分布。用于回答"我之前的判断准不准"。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const s = store.stats()
      return { ...s, note: '这是历史判断的统计分布，样本少时不具统计意义，不可当胜率结论。' }
    },
  })

  return count
}
