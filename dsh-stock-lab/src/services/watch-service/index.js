/**
 * watch-service/index.js — Watch Engine 服务
 *
 * 职责：
 *   1. 按规则拉取所需数据（经 MarketService，不直连数据源）
 *   2. 调 evaluator 判定
 *   3. 触发时写入 trigger 记录并回调通知（供外部提醒）
 *   4. 与研究笔记联动：复盘到期 / 假设失效
 *
 * 冷却机制：同一规则在 cooldownMinutes 内不重复触发，
 * 避免盘中的持续状态（如"仍在放量"）把提醒刷屏。
 */

import { WatchStore, WATCH_KINDS } from './watch-store.js'
import { evaluateRule, SEVERITY_ORDER } from './evaluator.js'

export { WATCH_KINDS, SEVERITY_ORDER }

const DEFAULT_COOLDOWN_MIN = 240

export class WatchService {
  constructor({ market, research, log } = {}) {
    this.store = new WatchStore()
    this.market = market
    this.research = research
    this.log = log || (() => {})
    this.onTrigger = null
  }

  // ── 规则管理 ─────────────────────────────────────────

  createRule(input) {
    // 校验：hypothesis_review_due 必须关联存在的笔记
    if (input?.kind === 'hypothesis_review_due') {
      if (!input.noteId) throw new Error('kind=hypothesis_review_due 时必须提供 noteId')
      const note = this.research?.get(String(input.noteId))
      if (!note) throw new Error('关联的研究笔记不存在：' + input.noteId)
      if (!input.symbol) input.symbol = note.symbol
    }
    return this.store.createRule(input)
  }

  listRules(opts) { return this.store.listRules(opts) }
  getRule(id) { return this.store.getRule(id) }
  setEnabled(id, enabled) { return this.store.setEnabled(id, enabled) }
  deleteRule(id) { return this.store.deleteRule(id) }
  listTriggers(opts) { return this.store.listTriggers(opts) }
  acknowledge(id, ack) { return this.store.acknowledge(id, ack) }
  stats() { return this.store.stats() }

  // ── 数据准备 ─────────────────────────────────────────

  /** 为一条规则按需拉取上下文（只取该条件真正需要的，避免无谓请求） */
  async _buildContext(rule) {
    const need = (k) => rule.kind === k
    const symbol = rule.symbol
    const p = rule.params || {}
    const ctx = { quote: null, bars: null, benchmarkBars: null, moneyFlow: null, stockSector: null, note: null }

    const wantQuote = ['price_threshold', 'daily_change_pct', 'turnover_spike', 'sector_relative'].includes(rule.kind)
    const hasLocalHistory = this._localHistoryAvailable()

    if (wantQuote || rule.kind === 'price_threshold') {
      try { ctx.quote = await this.market.getQuote(symbol) } catch (e) { this.log('取行情失败 ' + symbol + ': ' + e.message) }
    }

    // 需要历史序列的条件：按窗口长度请求
    const needBars = ['volume_anomaly', 'volatility_breakout', 'relative_strength_shift'].includes(rule.kind)
    if (needBars) {
      const n = Math.max(Number(p.n) || 20, 20)
      // 波动率需要两期，相对强弱需与基准对齐，统一多取一些
      const count = Math.min(Math.max(n * 2 + 40, 120), 800)
      try {
        ctx.bars = await this.market.getKline(symbol, { timeframe: '1d', adjust: 'qfq', count })
      } catch (e) { this.log('取K线失败 ' + symbol + ': ' + e.message) }
    }
    if (rule.kind === 'relative_strength_shift') {
      const bench = p.benchmark || 'IDX000300'
      try {
        ctx.benchmarkBars = await this.market.getKline(bench, { timeframe: '1d', adjust: 'qfq', count: 200 })
      } catch (e) { this.log('取基准K线失败 ' + bench + ': ' + e.message) }
    }
    if (rule.kind === 'money_flow_anomaly') {
      try { ctx.moneyFlow = await this.market.getMoneyFlow(symbol, { days: Math.min(Number(p.days) || 5, 30) }) } catch (e) { this.log('取资金流失败: ' + e.message) }
    }
    if (rule.kind === 'sector_relative') {
      try { ctx.stockSector = await this.market.getStockSector(symbol) } catch (e) { this.log('取行业失败: ' + e.message) }
    }
    if (rule.kind === 'hypothesis_review_due' && rule.noteId) {
      ctx.note = this.research?.get(String(rule.noteId)) || null
    }
    ctx.hasLocalHistory = hasLocalHistory
    return ctx
  }

  /** 本地历史库是否已落库（有则说明用户已启用 Python 存储） */
  _localHistoryAvailable() {
    return Boolean(process.env.DSH_STOCK_LAB_DATA)
  }

  // ── 求值 ────────────────────────────────────────────

  /**
   * 评估规则。dryRun=true 时只返回判定结果，不写触发记录。
   * @returns {Array<{rule, result}>}
   */
  async evaluateRules(rules, { dryRun = false } = {}) {
    const out = []
    for (const rule of rules) {
      let result
      try {
        const ctx = await this._buildContext(rule)
        result = evaluateRule(rule, ctx)
      } catch (e) {
        result = { fired: false, skip: '求值异常：' + (e?.message || e) }
      }
      this.store.touchEvaluated(rule.id)

      if (result.fired && !dryRun) {
        if (!this._inCooldown(rule)) {
          const trig = this.store.addTrigger({
            ruleId: rule.id,
            symbol: rule.symbol,
            kind: rule.kind,
            severity: result.severity || 'warning',
            title: result.title || rule.kind,
            detail: result.detail,
            metrics: result.metrics,
            noteId: rule.noteId,
          })
          result.trigger = trig
          try { this.onTrigger?.(trig, rule) } catch (e) { this.log('onTrigger 回调异常: ' + e.message) }
        } else {
          result.suppressed = true
        }
      }
      out.push({ rule, result })
    }
    return out
  }

  _inCooldown(rule) {
    if (!rule.lastTriggeredAt) return false
    const cd = Number.isFinite(rule.cooldownMinutes) ? rule.cooldownMinutes : DEFAULT_COOLDOWN_MIN
    if (cd <= 0) return false
    const last = Date.parse(rule.lastTriggeredAt)
    if (!Number.isFinite(last)) return false
    return Date.now() - last < cd * 60000
  }

  /** 评估所有启用规则（或指定标的的规则） */
  async evaluateAll(opts = {}) {
    const rules = this.store.listRules({ enabledOnly: true, symbol: opts.symbol, limit: 500 })
    const results = await this.evaluateRules(rules, { dryRun: opts.dryRun })
    const fired = results.filter((r) => r.result.fired && !r.result.suppressed)
    const suppressed = results.filter((r) => r.result.suppressed)
    const skipped = results.filter((r) => !r.result.fired && r.result.skip)
    return {
      evaluated: results.length,
      fired: fired.length,
      suppressedByCooldown: suppressed.length,
      skipped: skipped.length,
      triggers: fired.map((r) => r.result.trigger).filter(Boolean),
      details: results.map(({ rule, result }) => ({
        ruleId: rule.id,
        symbol: rule.symbol,
        name: rule.name,
        kind: rule.kind,
        fired: result.fired,
        severity: result.severity || null,
        title: result.title || null,
        detail: result.detail || null,
        metrics: result.metrics || null,
        skip: result.skip || null,
        suppressedByCooldown: result.suppressed === true,
      })).sort((a, b) => {
        if (a.fired !== b.fired) return a.fired ? -1 : 1
        return (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9)
      }),
    }
  }

  /** 只做判定不写记录（供 UI 预览 / AI 试探） */
  previewRule(rule) {
    return this.evaluateRules([rule], { dryRun: true }).then((r) => r[0])
  }

  close() { this.store.close() }
}