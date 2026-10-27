/**
 * tools/watch-tools.js — Watch Engine 相关 AI Tools
 *
 * 定位（ARCHITECTURE §17）：盯盘不只是价格阈值，而是智能事件；
 * 并且要与 Research Notebook 联动——假设失效时提醒复盘。
 */

import { WATCH_KINDS } from '../services/watch-service/index.js'

const OUT_TEXT = {
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
}

const KIND_DOC = {
  price_threshold: '价格阈值：params {op:">="|"<="|">"|"<", value:价格}',
  daily_change_pct: '当日涨跌幅：params {op, value:百分比}',
  volume_anomaly: '成交量异常：params {n:20, mult:2}（当日量 ≥ 前N日均量×倍数）',
  turnover_spike: '换手率骤升：params {value:换手率%}',
  volatility_breakout: '波动率突破：params {n:20, ratio:1.6}（当期波动率 ≥ 前一期×倍数）',
  relative_strength_shift: '相对强弱突变：params {n:20, threshold:5, direction:"underperform"|"outperform"|"any", benchmark:"IDX000300"}',
  money_flow_anomaly: '资金流异常：params {days:5, threshold:净额(元), direction:"inflow"|"outflow"|"any"}',
  sector_relative: '个股与行业背离：params {threshold:3, direction:"any"}',
  hypothesis_review_due: '研究假设到复盘日：必须传 noteId，关联 Research Notebook 笔记',
}

export function registerWatchTools(ctx, watch) {
  if (ctx.tools === undefined || !watch) return 0
  let count = 0
  const reg = (def) => { ctx.tools.register({ output: OUT_TEXT, ...def }); count++ }

  reg({
    name: 'create_watch_rule',
    description: '创建一个智能盯盘规则。不要只做价格提醒——支持智能事件：成交量异常、波动率突破、相对强弱突变、资金流异常、个股与行业背离，以及「研究假设到复盘日」（关联研究笔记后自动提醒复盘）。规则会被评估并把触发写入触发记录。条件类型与参数：\n'
      + Object.entries(KIND_DOC).map(([k, v]) => `- ${k}: ${v}`).join('\n'),
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '股票代码（kind=hypothesis_review_due 时可省略，会自动取自笔记）' },
        name: { type: 'string', description: '股票名称（便于提醒时辨认）' },
        kind: { type: 'string', enum: WATCH_KINDS, description: '条件类型' },
        params: { type: 'object', description: '条件参数，见 description 中的各类型说明', additionalProperties: true },
        reason: { type: 'string', description: '为什么设这条规则（用户的研究意图，会存下来）' },
        noteId: { type: 'string', description: '关联的研究笔记 id（kind=hypothesis_review_due 时必填）' },
        cooldownMinutes: { type: 'integer', minimum: 0, maximum: 10080, description: '重复触发的最小间隔（分钟），默认 240，0 表示不冷却' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const rule = watch.createRule({
          symbol: args.symbol,
          name: args.name,
          kind: args.kind,
          params: args.params,
          reason: args.reason,
          noteId: args.noteId,
          cooldownMinutes: args.cooldownMinutes,
        })
        return {
          created: true,
          rule: {
            id: rule.id, symbol: rule.symbol, name: rule.name, kind: rule.kind,
            params: rule.params, reason: rule.reason, noteId: rule.noteId,
            enabled: rule.enabled, cooldownMinutes: rule.cooldownMinutes,
          },
          note: '规则已创建。用 evaluate_watch_rules 立即检查一次；触发会记录到触发列表。',
        }
      } catch (e) { throw new Error(String(e?.message || e)) }
    },
  })

  reg({
    name: 'list_watch_rules',
    description: '列出已配置的盯盘规则与触发统计（每条规则的最后评估/触发时间、累计触发次数）。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '只看某只股票' },
        enabledOnly: { type: 'boolean', description: '只看启用中的' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const rules = watch.listRules({ symbol: args.symbol, enabledOnly: args.enabledOnly === true })
      const stats = watch.stats()
      return {
        rules: rules.map((r) => ({
          id: r.id, symbol: r.symbol, name: r.name, kind: r.kind, params: r.params,
          reason: r.reason, noteId: r.noteId, enabled: r.enabled,
          lastEvaluatedAt: r.lastEvaluatedAt, lastTriggeredAt: r.lastTriggeredAt,
          triggerCount: r.triggerCount, cooldownMinutes: r.cooldownMinutes,
        })),
        stats: { rules: stats.rules, enabled: stats.enabled, triggers: stats.triggers, unacknowledged: stats.unacknowledged },
      }
    },
  })

  reg({
    name: 'evaluate_watch_rules',
    description: '立即评估盯盘规则（不等到下次周期）。返回每条规则的判定结果：是否触发、严重度、判断依据的具体数值；未触发的会说明原因（数据不足/条件未满足）。同一规则在冷却期内不会重复写触发记录。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '只评估某只股票的规则（省略则评估全部启用规则）' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const r = await watch.evaluateAll({ symbol: args.symbol })
        return r
      } catch (e) { throw new Error('评估失败：' + String(e?.message || e)) }
    },
  })

  reg({
    name: 'list_watch_triggers',
    description: '查看盯盘触发记录（最新的在前）。每条含触发时间、严重度、标题、具体数值依据、以及关联的研究笔记 id（若有）。这是"市场提醒我该看什么"的入口。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '只看某只股票' },
        unacknowledgedOnly: { type: 'boolean', description: '只看未确认的' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '条数，默认 30' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const triggers = watch.listTriggers({
        symbol: args.symbol,
        unacknowledgedOnly: args.unacknowledgedOnly === true,
        limit: args.limit || 30,
      })
      return {
        count: triggers.length,
        triggers: triggers.map((t) => ({
          id: t.id, ruleId: t.ruleId, symbol: t.symbol, kind: t.kind,
          firedAt: t.firedAt, severity: t.severity, title: t.title,
          detail: t.detail, metrics: t.metrics, noteId: t.noteId, acknowledged: t.acknowledged,
        })),
      }
    },
  })

  reg({
    name: 'watch_digest',
    description: '盯盘摘要：把未确认的触发记录与「到期的研究假设」汇总成一段可直接呈现给用户的简报，并给出严重度分级。回答"盯盘有什么情况""今天要我看什么""我的假设该复盘了吗"时用这个，不要在回答里堆原始 JSON。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '只看某只股票（可选）' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '最多汇总多少条触发，默认 15' },
        includeAcknowledged: { type: 'boolean', description: '是否包含已确认的（默认否）' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const triggers = watch.listTriggers({
        symbol: args.symbol,
        unacknowledgedOnly: args.includeAcknowledged !== true,
        limit: args.limit || 15,
      })
      // 到期的研究假设（无论是否已触发过记录）
      let dueNotes = []
      try {
        const rules = watch.listRules({ enabledOnly: true, symbol: args.symbol })
        const hypoRules = rules.filter((r) => r.kind === 'hypothesis_review_due' && r.noteId)
        for (const r of hypoRules) {
          const note = watch.research?.get?.(r.noteId)
          if (!note || note.status === 'reviewed') continue
          if (note.reviewDate && note.reviewDate <= new Date().toISOString().slice(0, 10)) {
            dueNotes.push({
              noteId: note.id, symbol: note.symbol, name: note.name,
              reviewDate: note.reviewDate, prediction: note.prediction || null,
              createdAt: note.createdAt,
            })
          }
        }
      } catch { /* 研究库不可用时忽略 */ }

      const stats = watch.stats()
      const bySeverity = { critical: [], warning: [], info: [] }
      for (const t of triggers) (bySeverity[t.severity] || bySeverity.info).push(t)

      const line = (t) => `- [${t.severity}] ${t.title}｜${t.detail || ''}（${String(t.firedAt).slice(0, 16).replace('T', ' ')}）`
        + (t.noteId ? ' → 关联研究笔记' : '')

      let digest = ''
      if (dueNotes.length) {
        digest += `### 到期的研究假设（${dueNotes.length} 条）\n`
        for (const n of dueNotes) {
          digest += `- ${n.name || n.symbol}｜复盘日 ${n.reviewDate}｜当时预测："${n.prediction || '（未填写）'}"\n`
        }
        digest += '请对照实际走势判断该假设成立、部分成立还是被推翻，并用 review_research_note 记录结论。\n\n'
      }
      if (triggers.length === 0) {
        digest += dueNotes.length ? '' : '盯盘暂无未确认触发。'
      } else {
        digest += `### 盯盘触发（未确认 ${triggers.length} 条 / 历史累计 ${stats.triggers} 条）\n`
        if (bySeverity.critical.length) digest += `\n**重要（${bySeverity.critical.length}）**\n` + bySeverity.critical.map(line).join('\n') + '\n'
        if (bySeverity.warning.length) digest += `\n**关注（${bySeverity.warning.length}）**\n` + bySeverity.warning.map(line).join('\n') + '\n'
        if (bySeverity.info.length) digest += `\n**提示（${bySeverity.info.length}）**\n` + bySeverity.info.map(line).join('\n') + '\n'
      }

      return {
        digest,
        counts: {
          triggers: triggers.length,
          critical: bySeverity.critical.length,
          warning: bySeverity.warning.length,
          info: bySeverity.info.length,
          dueNotes: dueNotes.length,
          alertingRules: stats.enabled,
        },
        triggers: triggers.map((t) => ({
          id: t.id, symbol: t.symbol, severity: t.severity, title: t.title,
          detail: t.detail, metrics: t.metrics, firedAt: t.firedAt, noteId: t.noteId,
        })),
        dueNotes,
        instruction: '把 digest 内容整理成给用户的简报；每个触发都要带依据数值，不要只说"有异常"。到期的假设要明确请用户复盘。',
      }
    },
  })

  return count
}