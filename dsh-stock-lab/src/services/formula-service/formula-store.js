/**
 * formula-store.js — 指标公式的持久化（导入的 TDX 公式）
 *
 * 与 research-store / watch-store 同一模式：SQLite（node:sqlite，零依赖）。
 * 目录：$DSH_STOCK_LAB_HOME/formula/index.db 或 $DSH_HOME/stock-lab/formula/index.db
 *
 * 存什么：
 *   - 公式原文（**必须存原文**：用户要能回看、能改、能重新解析）
 *   - 解析诊断快照（导入时能不能用、哪里不支持、有无未来函数）
 *   - 归属（全局公式 or 绑定某标的）
 */

import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { normalize } from '../market-service/symbols.js'

function resolveRoot() {
  const explicit = process.env.DSH_STOCK_LAB_HOME
  if (explicit) return join(explicit, 'formula')
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'stock-lab', 'formula')
}

function normSymbol(input) {
  const raw = String(input || '').trim()
  if (raw === '') return null
  try { return normalize(raw).symbol } catch { return raw.toUpperCase() }
}

/** 公式来源 */
export const FORMULA_SOURCES = ['chat', 'file', 'manual']

export class FormulaStore {
  constructor(dbPath = join(resolveRoot(), 'index.db')) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS formulas (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        symbol TEXT,
        source TEXT NOT NULL,
        sourceRef TEXT,
        text TEXT NOT NULL,
        ok INTEGER NOT NULL,
        errors TEXT,
        warnings TEXT,
        outputs TEXT,
        futureFunctions TEXT,
        ignoredDrawCalls TEXT,
        usedFunctions TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        runCount INTEGER NOT NULL DEFAULT 0,
        lastRunAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_formulas_symbol ON formulas(symbol);
      CREATE INDEX IF NOT EXISTS idx_formulas_name ON formulas(name);
    `)
  }

  /**
   * 保存公式。同名（同一 symbol 下）视为更新原文并重新记录诊断。
   */
  create(input) {
    const name = String(input?.name || '').trim()
    if (name === '') throw new Error('公式必须有名字')
    const text = String(input?.text || '')
    if (text.trim() === '') throw new Error('公式内容为空')

    const symbol = normSymbol(input.symbol)
    const now = new Date().toISOString()
    const asJson = (v) => (v === undefined || v === null ? null : JSON.stringify(v))

    // 同 name + symbol 视为同一公式的更新
    const existing = this.db.prepare(
      'SELECT id, createdAt, runCount, lastRunAt FROM formulas WHERE name = ? AND ((symbol IS NULL AND ? IS NULL) OR symbol = ?)',
    ).get(name, symbol, symbol)

    const rec = {
      id: existing?.id || input.id || randomUUID(),
      name,
      symbol,
      source: FORMULA_SOURCES.includes(input.source) ? input.source : 'manual',
      sourceRef: input.sourceRef ?? null,
      text,
      ok: input.ok === false ? 0 : 1,
      errors: asJson(input.errors),
      warnings: asJson(input.warnings),
      outputs: asJson(input.outputs),
      futureFunctions: asJson(input.futureFunctions),
      ignoredDrawCalls: asJson(input.ignoredDrawCalls),
      usedFunctions: asJson(input.usedFunctions),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      runCount: existing?.runCount ?? 0,
      lastRunAt: existing?.lastRunAt ?? null,
    }

    if (existing) {
      this.db.prepare(`
        UPDATE formulas SET source=?, sourceRef=?, text=?, ok=?, errors=?, warnings=?,
          outputs=?, futureFunctions=?, ignoredDrawCalls=?, usedFunctions=?, updatedAt=?
        WHERE id=?
      `).run(rec.source, rec.sourceRef, rec.text, rec.ok, rec.errors, rec.warnings,
        rec.outputs, rec.futureFunctions, rec.ignoredDrawCalls, rec.usedFunctions,
        rec.updatedAt, rec.id)
    } else {
      this.db.prepare(`
        INSERT INTO formulas (id,name,symbol,source,sourceRef,text,ok,errors,warnings,outputs,
          futureFunctions,ignoredDrawCalls,usedFunctions,createdAt,updatedAt,runCount,lastRunAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(rec.id, rec.name, rec.symbol, rec.source, rec.sourceRef, rec.text, rec.ok,
        rec.errors, rec.warnings, rec.outputs, rec.futureFunctions, rec.ignoredDrawCalls,
        rec.usedFunctions, rec.createdAt, rec.updatedAt, rec.runCount, rec.lastRunAt)
    }
    return this.get(rec.id)
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM formulas WHERE id = ?').get(id)
    return row ? this._hydrate(row) : null
  }

  /**
 * 按名字查找公式。
 *
 * 语义（与界面/工具的预期一致）：
 *   - 给了 symbol：**优先**返回绑定该标的的那条；没有则回退到通用公式（symbol IS NULL）
 *   - 没给 symbol：优先通用公式；没有则返回最近更新的同名公式
 *
 * 修复记录：早期实现只做「同名且同标的」精确匹配，导致通用公式在带标的调用时
 * 一律找不到（明明导入过却报"没有这个公式"）。
 */
  findByName(name, symbol) {
    const s = normSymbol(symbol)
    const nm = String(name)
    if (s) {
      const hit = this.db.prepare('SELECT * FROM formulas WHERE name = ? AND symbol = ?').get(nm, s)
      if (hit) return this._hydrate(hit)
      const generic = this.db.prepare('SELECT * FROM formulas WHERE name = ? AND symbol IS NULL').get(nm)
      return generic ? this._hydrate(generic) : null
    }
    const generic = this.db.prepare('SELECT * FROM formulas WHERE name = ? AND symbol IS NULL').get(nm)
    if (generic) return this._hydrate(generic)
    const any = this.db.prepare(
      'SELECT * FROM formulas WHERE name = ? ORDER BY updatedAt DESC LIMIT 1',
    ).get(nm)
    return any ? this._hydrate(any) : null
  }

  list(opts = {}) {
    const where = []
    const args = []
    if (opts.symbol) {
      // 该标的的公式 + 通用公式
      where.push('(symbol = ? OR symbol IS NULL)')
      args.push(normSymbol(opts.symbol))
    }
    if (opts.onlySymbol) { where.push('symbol = ?'); args.push(normSymbol(opts.onlySymbol)) }
    if (opts.okOnly) where.push('ok = 1')
    const sql = 'SELECT * FROM formulas'
      + (where.length ? ' WHERE ' + where.join(' AND ') : '')
      + ' ORDER BY updatedAt DESC LIMIT ?'
    args.push(Math.min(Math.max(opts.limit || 100, 1), 500))
    return this.db.prepare(sql).all(...args).map((r) => this._hydrate(r))
  }

  touchRun(id) {
    this.db.prepare('UPDATE formulas SET runCount = runCount + 1, lastRunAt = ? WHERE id = ?')
      .run(new Date().toISOString(), id)
  }

  delete(id) {
    this.db.prepare('DELETE FROM formulas WHERE id = ?').run(id)
    return true
  }

  stats() {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM formulas').get().n
    const okCount = this.db.prepare('SELECT COUNT(*) AS n FROM formulas WHERE ok = 1').get().n
    const withFuture = this.db.prepare(
      "SELECT COUNT(*) AS n FROM formulas WHERE futureFunctions IS NOT NULL AND futureFunctions != '[]'",
    ).get().n
    return { total, usable: okCount, withFutureWarning: withFuture, root: resolveRoot() }
  }

  _hydrate(row) {
    const parse = (v) => { try { return v === null ? null : JSON.parse(v) } catch { return v } }
    return {
      ...row,
      ok: row.ok === 1,
      errors: parse(row.errors),
      warnings: parse(row.warnings),
      outputs: parse(row.outputs),
      futureFunctions: parse(row.futureFunctions),
      ignoredDrawCalls: parse(row.ignoredDrawCalls),
      usedFunctions: parse(row.usedFunctions),
    }
  }

  close() { try { this.db.close() } catch { /* ignore */ } }
}

export const paths = { resolveRoot }