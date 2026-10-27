/**
 * watch-store.js — Watch Engine 持久化层（规则 + 触发记录）
 *
 * 设计（ARCHITECTURE §17）：
 *   盯盘不只是"价格到某个值提醒"，而是智能事件：
 *   成交量异常 / 波动率突破 / 相对强弱突变 / 资金流异常 / 行业状态变化 /
 *   研究假设失效（与 Research Notebook 联动）
 *
 * 存储：SQLite（node:sqlite 内置，零依赖）
 * 目录：$DSH_STOCK_LAB_HOME/watch/index.db 或 $DSH_HOME/stock-lab/watch/index.db
 */

import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { normalize } from '../market-service/symbols.js'

function resolveRoot() {
  const explicit = process.env.DSH_STOCK_LAB_HOME
  if (explicit) return join(explicit, 'watch')
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'stock-lab', 'watch')
}

const ROOT = resolveRoot()
const DB_PATH = join(ROOT, 'index.db')

function normSymbol(input) {
  const raw = String(input || '').trim()
  if (raw === '') return raw
  try { return normalize(raw).symbol } catch { return raw.toUpperCase() }
}

/** 支持的盯盘条件类型（evaluator 必须实现同名分支） */
export const WATCH_KINDS = [
  'price_threshold',         // 价格突破/跌破某值
  'daily_change_pct',        // 当日涨跌幅超过阈值
  'volume_anomaly',          // 成交量异常（相对前 N 日均量）
  'turnover_spike',          // 换手率骤升
  'volatility_breakout',     // 波动率突破（相对前一期放大）
  'relative_strength_shift', // 相对基准强弱突变（N 日超额）
  'money_flow_anomaly',      // 资金流异常（近 N 日主力净流入绝对值）
  'sector_relative',         // 个股与所属行业当日背离
  'hypothesis_review_due',   // 研究假设到复盘日（与 Notebook 联动）
]

export class WatchStore {
  constructor(dbPath = DB_PATH) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS rules (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        name TEXT,
        kind TEXT NOT NULL,
        params TEXT,
        reason TEXT,
        noteId TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        cooldownMinutes INTEGER NOT NULL DEFAULT 240,
        createdAt TEXT NOT NULL,
        lastEvaluatedAt TEXT,
        lastTriggeredAt TEXT,
        triggerCount INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_rules_symbol ON rules(symbol);
      CREATE INDEX IF NOT EXISTS idx_rules_enabled ON rules(enabled);

      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY,
        ruleId TEXT NOT NULL,
        symbol TEXT NOT NULL,
        kind TEXT NOT NULL,
        firedAt TEXT NOT NULL,
        severity TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT,
        metrics TEXT,
        noteId TEXT,
        acknowledged INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_triggers_fired ON triggers(firedAt);
      CREATE INDEX IF NOT EXISTS idx_triggers_rule ON triggers(ruleId);
    `)
  }

  createRule(input) {
    if (!input || !input.symbol) throw new Error('缺少必填字段：symbol')
    if (!input.kind) throw new Error('缺少必填字段：kind')
    if (!WATCH_KINDS.includes(input.kind)) {
      throw new Error(`不支持的 kind：${input.kind}（可用：${WATCH_KINDS.join(', ')}）`)
    }
    const now = new Date().toISOString()
    const rec = {
      id: input.id || randomUUID(),
      symbol: normSymbol(input.symbol),
      name: input.name ?? null,
      kind: input.kind,
      params: JSON.stringify(input.params || {}),
      reason: input.reason ?? null,
      noteId: input.noteId ?? null,
      enabled: input.enabled === false ? 0 : 1,
      cooldownMinutes: Number.isFinite(input.cooldownMinutes) ? Number(input.cooldownMinutes) : 240,
      createdAt: now,
      lastEvaluatedAt: null,
      lastTriggeredAt: null,
      triggerCount: 0,
    }
    this.db.prepare(`
      INSERT INTO rules (id,symbol,name,kind,params,reason,noteId,enabled,cooldownMinutes,
        createdAt,lastEvaluatedAt,lastTriggeredAt,triggerCount)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(rec.id, rec.symbol, rec.name, rec.kind, rec.params, rec.reason, rec.noteId,
      rec.enabled, rec.cooldownMinutes, rec.createdAt, rec.lastEvaluatedAt,
      rec.lastTriggeredAt, rec.triggerCount)
    return this.getRule(rec.id)
  }

  getRule(id) {
    const row = this.db.prepare('SELECT * FROM rules WHERE id = ?').get(id)
    return row ? this._hydrateRule(row) : null
  }

  listRules(opts = {}) {
    const where = []
    const args = []
    if (opts.symbol) { where.push('symbol = ?'); args.push(normSymbol(opts.symbol)) }
    if (opts.enabledOnly) where.push('enabled = 1')
    const sql = 'SELECT * FROM rules'
      + (where.length ? ' WHERE ' + where.join(' AND ') : '')
      + ' ORDER BY createdAt DESC LIMIT ?'
    args.push(Math.min(Math.max(opts.limit || 100, 1), 500))
    return this.db.prepare(sql).all(...args).map((r) => this._hydrateRule(r))
  }

  setEnabled(id, enabled) {
    this.db.prepare('UPDATE rules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
    return this.getRule(id)
  }

  deleteRule(id) {
    this.db.prepare('DELETE FROM rules WHERE id = ?').run(id)
    return true
  }

  touchEvaluated(id) {
    this.db.prepare('UPDATE rules SET lastEvaluatedAt = ? WHERE id = ?')
      .run(new Date().toISOString(), id)
  }

  /** 记录一次触发；返回触发记录 */
  addTrigger({ ruleId, symbol, kind, severity = 'warning', title, detail, metrics, noteId }) {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO triggers (id,ruleId,symbol,kind,firedAt,severity,title,detail,metrics,noteId,acknowledged)
      VALUES (?,?,?,?,?,?,?,?,?,?,0)
    `).run(id, ruleId, normSymbol(symbol), kind, now, severity, String(title),
      detail ?? null, metrics ? JSON.stringify(metrics) : null, noteId ?? null)
    this.db.prepare('UPDATE rules SET lastTriggeredAt = ?, triggerCount = triggerCount + 1 WHERE id = ?')
      .run(now, ruleId)
    return this.getTrigger(id)
  }

  getTrigger(id) {
    const row = this.db.prepare('SELECT * FROM triggers WHERE id = ?').get(id)
    return row ? this._hydrateTrigger(row) : null
  }

  listTriggers(opts = {}) {
    const where = []
    const args = []
    if (opts.symbol) { where.push('symbol = ?'); args.push(normSymbol(opts.symbol)) }
    if (opts.ruleId) { where.push('ruleId = ?'); args.push(opts.ruleId) }
    if (opts.unacknowledgedOnly) where.push('acknowledged = 0')
    if (opts.since) { where.push('firedAt >= ?'); args.push(opts.since) }
    const sql = 'SELECT * FROM triggers'
      + (where.length ? ' WHERE ' + where.join(' AND ') : '')
      + ' ORDER BY firedAt DESC LIMIT ?'
    args.push(Math.min(Math.max(opts.limit || 100, 1), 500))
    return this.db.prepare(sql).all(...args).map((r) => this._hydrateTrigger(r))
  }

  acknowledge(id, ack = true) {
    this.db.prepare('UPDATE triggers SET acknowledged = ? WHERE id = ?').run(ack ? 1 : 0, id)
    return this.getTrigger(id)
  }

  stats() {
    const rules = this.db.prepare('SELECT COUNT(*) AS n FROM rules').get().n
    const enabled = this.db.prepare('SELECT COUNT(*) AS n FROM rules WHERE enabled = 1').get().n
    const triggers = this.db.prepare('SELECT COUNT(*) AS n FROM triggers').get().n
    const unack = this.db.prepare('SELECT COUNT(*) AS n FROM triggers WHERE acknowledged = 0').get().n
    const byKind = this.db.prepare(
      'SELECT kind, COUNT(*) AS n FROM rules GROUP BY kind',
    ).all()
    return { rules, enabled, triggers, unacknowledged: unack, byKind, root: ROOT }
  }

  _hydrateRule(row) {
    const parse = (v) => { try { return v === null ? null : JSON.parse(v) } catch { return v } }
    return { ...row, enabled: row.enabled === 1, params: parse(row.params) || {} }
  }

  _hydrateTrigger(row) {
    const parse = (v) => { try { return v === null ? null : JSON.parse(v) } catch { return v } }
    return { ...row, acknowledged: row.acknowledged === 1, metrics: parse(row.metrics) }
  }

  close() { try { this.db.close() } catch { /* ignore */ } }
}

export const paths = { ROOT, DB_PATH }