/**
 * local.js — 本地历史数据库适配器（Node 侧直读）
 *
 * 本地库由 Python（backend/storage/storage.py）写入，本模块用 Node 原生能力读取：
 *   - meta.db        → node:sqlite（标准 SQLite 文件）
 *   - bars/*.csv.gz  → node:zlib 解压后解析 CSV
 *
 * 格式是 Python 写入方与 Node 读取方之间的**共享契约**，因此：
 *   - 按**列名**取列（不按位置），列顺序变化不会破坏读取
 *   - 有跨语言契约测试（tests/local-storage.test.mjs）验证两侧一致
 *
 * 注意：Parquet 后端 Node 读不了（无 pyarrow 等价物）。若本地只有 .parquet，
 * 本模块返回 null，由 MarketService 回退到实时源；需要 Parquet 时走 Python 桥。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import zlib from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { resolveDataRoot } from '../data-root.js'

const num = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) return []
  const header = lines[0].split(',').map((h) => h.trim())
  const idx = {}
  for (let i = 0; i < header.length; i++) idx[header[i]] = i
  if (idx.time === undefined || idx.close === undefined) {
    throw new Error('本地 CSV 缺少必需列（time/close）：' + header.join(','))
  }
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',')
    rows.push({
      time: cells[idx.time],
      open: num(cells[idx.open]),
      high: num(cells[idx.high]),
      low: num(cells[idx.low]),
      close: num(cells[idx.close]),
      volume: num(cells[idx.volume]),
      amount: idx.amount !== undefined ? num(cells[idx.amount]) : null,
      adjust: idx.adjust !== undefined ? cells[idx.adjust] : null,
      source: idx.source !== undefined ? cells[idx.source] : 'local',
    })
  }
  return rows
}

/** 候选文件路径（csv.gz 优先，parquet 仅用于探测存在性） */
export function localBarPaths(symbol, timeframe = '1d', adjust = 'qfq') {
  const root = resolveDataRoot()
  const dir = join(root, 'bars', String(symbol).replace(/[/\\]/g, '_'))
  return {
    root,
    dir,
    csvGz: join(dir, `${timeframe}_${adjust}.csv.gz`),
    parquet: join(dir, `${timeframe}_${adjust}.parquet`),
  }
}

/** 本地是否有可读数据（csv.gz 才算可读） */
export function hasLocalBars(symbol, timeframe = '1d', adjust = 'qfq') {
  return existsSync(localBarPaths(symbol, timeframe, adjust).csvGz)
}

/**
 * 读取本地 K 线。
 * @returns {Array<Bar>|null} null 表示本地不可用（不存在 / 仅 Parquet / 解析失败）
 */
export function getLocalKline(symbol, opts = {}) {
  const timeframe = opts.timeframe || '1d'
  const adjust = opts.adjust || 'qfq'
  const p = localBarPaths(symbol, timeframe, adjust)
  if (!existsSync(p.csvGz)) return null
  let rows
  try {
    rows = parseCsv(zlib.gunzipSync(readFileSync(p.csvGz)).toString('utf8'))
  } catch {
    return null
  }
  if (rows.length === 0) return null
  let out = rows
  if (opts.start) out = out.filter((r) => r.time >= String(opts.start))
  if (opts.end) out = out.filter((r) => r.time <= String(opts.end))
  if (opts.count) out = out.slice(-Math.max(1, Number(opts.count)))
  // 标记来源，便于上层判断"这条数据来自本地库还是实时接口"
  return out.map((r) => ({ ...r, source: 'local', localSource: r.source || null }))
}

/** 本地库的采集元信息（读 meta.db；不可用时返回 null） */
export function getLocalMeta(symbol, timeframe = '1d', adjust = 'qfq') {
  const root = resolveDataRoot()
  const dbPath = join(root, 'meta.db')
  if (!existsSync(dbPath)) return null
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db.prepare(
      'SELECT * FROM bars_meta WHERE symbol = ? AND timeframe = ? AND adjust = ?',
    ).get(symbol, timeframe, adjust)
    return row ? { ...row } : null
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

/** 本地库已落库的全部标的 */
export function listLocalMeta() {
  const root = resolveDataRoot()
  const dbPath = join(root, 'meta.db')
  if (!existsSync(dbPath)) return { root, dataDir: root, symbols: [] }
  let db
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const rows = db.prepare('SELECT * FROM bars_meta ORDER BY symbol').all()
    return { root, dataDir: root, symbols: rows.map((r) => ({ ...r })) }
  } catch {
    return { root, dataDir: root, symbols: [] }
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

/**
 * 数据版本指纹（与 Python storage.data_version 语义一致：文件大小 + mtime）。
 * 用于 Research Note 记录"这次分析用的是哪一版数据"，保证可复现。
 */
export function localDataVersion(symbols, timeframe = '1d', adjust = 'qfq') {
  const list = [...new Set(symbols)].sort()
  const parts = []
  for (const s of list) {
    const p = localBarPaths(s, timeframe, adjust)
    if (existsSync(p.csvGz)) {
      try {
        const st = statSync(p.csvGz)
        parts.push(`${s}:${st.size}:${Math.floor(st.mtimeMs)}`)
      } catch { parts.push(`${s}:err`) }
    } else {
      parts.push(`${s}:missing`)
    }
  }
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16)
}

/** 诊断信息：本地库在哪、有什么 */
export function localDiagnostics() {
  const root = resolveDataRoot()
  const barsDir = join(root, 'bars')
  let dirs = []
  try { dirs = readdirSync(barsDir) } catch { /* 目录不存在 */ }
  return {
    dataRoot: root,
    metaDbExists: existsSync(join(root, 'meta.db')),
    barsDirExists: existsSync(barsDir),
    symbolCount: dirs.length,
    env: {
      DSH_STOCK_LAB_DATA: process.env.DSH_STOCK_LAB_DATA || null,
      DSH_STOCK_LAB_HOME: process.env.DSH_STOCK_LAB_HOME || null,
      DSH_HOME: process.env.DSH_HOME || null,
    },
  }
}