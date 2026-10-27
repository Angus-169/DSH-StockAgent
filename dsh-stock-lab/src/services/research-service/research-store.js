/**
 * research-store.js — Research Notebook 持久化层
 *
 * 设计（ARCHITECTURE §4）：
 *   - 人可读：每条 note 落一个 markdown 文件
 *   - 可查询：SQLite 索引（node:sqlite 内置，无第三方依赖）
 *   - 可复现：note 必须记录当时的数据快照元信息（asOf / sources / universe / benchmark）
 *
 * 目录：$DSH_HOME/stock-lab/research/
 *   notes/<id>.md
 *   index.db
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { normalize } from '../market-service/symbols.js'

/** 规范化为内部 symbol；无法解析时保留原值（研究记录不该因代码格式被拒） */
function normSymbol(input) {
  const raw = String(input || '').trim()
  if (raw === '') return raw
  try { return normalize(raw).symbol } catch { return raw.toUpperCase() }
}

const HOME = process.env.DSH_STOCK_LAB_HOME
  || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'stock-lab')
const ROOT = join(HOME, 'research')
const NOTES_DIR = join(ROOT, 'notes')
const DB_PATH = join(ROOT, 'index.db')

function ensureDirs() {
  mkdirSync(NOTES_DIR, { recursive: true })
}

/** note 的字段与校验 */
const REQUIRED = ['symbol', 'observation', 'hypothesis']
const FIELDS = [
  'id', 'symbol', 'name', 'createdAt', 'asOf', 'observation', 'hypothesis',
  'evidence', 'counterEvidence', 'prediction', 'confidence', 'reviewDate',
  'reviewedAt', 'verdict', 'reviewNotes', 'tags', 'dataVersion', 'benchmark',
  'sources', 'status',
]

export class ResearchStore {
  constructor(dbPath = DB_PATH) {
    ensureDirs()
    this.dbPath = dbPath
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        name TEXT,
        createdAt TEXT NOT NULL,
        asOf TEXT,
        observation TEXT NOT NULL,
        hypothesis TEXT NOT NULL,
        evidence TEXT,
        counterEvidence TEXT,
        prediction TEXT,
        confidence REAL,
        reviewDate TEXT,
        reviewedAt TEXT,
        verdict TEXT,
        reviewNotes TEXT,
        tags TEXT,
        dataVersion TEXT,
        benchmark TEXT,
        sources TEXT,
        status TEXT NOT NULL DEFAULT 'open'
      );
      CREATE INDEX IF NOT EXISTS idx_notes_symbol ON notes(symbol);
      CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);
      CREATE INDEX IF NOT EXISTS idx_notes_review ON notes(reviewDate);
    `)
  }

  /** 新建 note，返回完整记录 */
  create(input) {
    for (const f of REQUIRED) {
      if (!input || input[f] === undefined || String(input[f]).trim() === '') {
        throw new Error(`缺少必填字段：${f}`)
      }
    }
    const now = new Date().toISOString()
    const id = input.id || randomUUID()
    const asJson = (v) => (v === undefined || v === null ? null : JSON.stringify(v))
    const rec = {
      id,
      symbol: normSymbol(input.symbol),
      name: input.name ?? null,
      createdAt: now,
      asOf: input.asOf ?? now,
      observation: String(input.observation),
      hypothesis: String(input.hypothesis),
      evidence: asJson(input.evidence),
      counterEvidence: asJson(input.counterEvidence),
      prediction: input.prediction ?? null,
      confidence: input.confidence === undefined || input.confidence === null ? null : Number(input.confidence),
      reviewDate: input.reviewDate ?? null,
      reviewedAt: null,
      verdict: null,
      reviewNotes: null,
      tags: asJson(input.tags),
      dataVersion: input.dataVersion ?? null,
      benchmark: input.benchmark ?? null,
      sources: asJson(input.sources),
      status: 'open',
    }
    if (rec.confidence !== null && (rec.confidence < 0 || rec.confidence > 1)) {
      throw new Error('confidence 必须在 0 到 1 之间')
    }
    this.db.prepare(`
      INSERT INTO notes (id,symbol,name,createdAt,asOf,observation,hypothesis,evidence,
        counterEvidence,prediction,confidence,reviewDate,reviewedAt,verdict,reviewNotes,
        tags,dataVersion,benchmark,sources,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      rec.id, rec.symbol, rec.name, rec.createdAt, rec.asOf, rec.observation, rec.hypothesis,
      rec.evidence, rec.counterEvidence, rec.prediction, rec.confidence, rec.reviewDate,
      rec.reviewedAt, rec.verdict, rec.reviewNotes, rec.tags, rec.dataVersion, rec.benchmark,
      rec.sources, rec.status,
    )
    this._writeMarkdown(rec)
    return this.get(id)
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id)
    return row ? this._hydrate(row) : null
  }

  /** 列表，可按 symbol / status / 是否到期复盘 过滤 */
  list(opts = {}) {
    const where = []
    const args = []
    if (opts.symbol) { where.push('symbol = ?'); args.push(normSymbol(opts.symbol)) }
    if (opts.status) { where.push('status = ?'); args.push(opts.status) }
    if (opts.dueOnly) {
      where.push("status = 'open' AND reviewDate IS NOT NULL AND reviewDate <= ?")
      args.push(opts.now || new Date().toISOString().slice(0, 10))
    }
    const sql = 'SELECT * FROM notes'
      + (where.length ? ' WHERE ' + where.join(' AND ') : '')
      + ' ORDER BY createdAt DESC LIMIT ?'
    args.push(Math.min(Math.max(opts.limit || 50, 1), 200))
    return this.db.prepare(sql).all(...args).map((r) => this._hydrate(r))
  }

  /** 到期需要复盘的 note */
  due(now = new Date().toISOString().slice(0, 10)) {
    return this.list({ dueOnly: true, now })
  }

  /** 复盘：写入结论并关闭 */
  review(id, { verdict, reviewNotes, actualOutcome }) {
    if (!verdict) throw new Error('verdict 必填（correct / partially / wrong / void）')
    const allowed = ['correct', 'partially', 'wrong', 'void']
    if (!allowed.includes(verdict)) throw new Error('verdict 只能是 ' + allowed.join(' / '))
    const rec = this.get(id)
    if (!rec) throw new Error('note 不存在：' + id)
    const now = new Date().toISOString()
    // 只更新复盘相关列，绝不动 evidence/sources 等 JSON 列（早期版本误用 join 覆盖过 sources）
    const notes = [reviewNotes, actualOutcome].filter((x) => x !== undefined && x !== null && x !== '').join('\n\n---\n\n')
    this.db.prepare('UPDATE notes SET status = ?, reviewedAt = ?, verdict = ?, reviewNotes = ? WHERE id = ?')
      .run('reviewed', now, verdict, notes === '' ? null : notes, id)
    const updated = this.get(id)
    this._writeMarkdown(updated)
    return updated
  }

  delete(id) {
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(id)
    const p = join(NOTES_DIR, id + '.md')
    if (existsSync(p)) {
      try { writeFileSync(p, '') } catch { /* ignore */ }
    }
    return true
  }

  /** 统计：总览用 */
  stats() {
    const total = this.db.prepare('SELECT COUNT(*) AS n FROM notes').get().n
    const open = this.db.prepare("SELECT COUNT(*) AS n FROM notes WHERE status = 'open'").get().n
    const reviewed = this.db.prepare("SELECT COUNT(*) AS n FROM notes WHERE status = 'reviewed'").get().n
    const byVerdict = this.db.prepare(
      "SELECT verdict, COUNT(*) AS n FROM notes WHERE verdict IS NOT NULL GROUP BY verdict",
    ).all()
    return { total, open, reviewed, byVerdict, root: ROOT }
  }

  /** markdown 渲染（人可读，落在 notes/ 下） */
  _writeMarkdown(rec) {
    // rec 来自 _hydrate()，JSON 列已是解析后的数组/对象；这里兼容两种形态
    const asList = (v) => {
      if (v === null || v === undefined) return []
      if (Array.isArray(v)) return v
      if (typeof v === 'string') {
        try { const p = JSON.parse(v); return Array.isArray(p) ? p : [String(p)] }
        catch { return v.split(',').map((s) => s.trim()).filter(Boolean) }
      }
      return [String(v)]
    }
    const evidence = asList(rec.evidence)
    const counterEvidence = asList(rec.counterEvidence)
    const sources = asList(rec.sources)
    const md = [
      `# Research Note — ${rec.name || ''} ${rec.symbol}`.trim(),
      '',
      `- **创建**：${rec.createdAt}`,
      `- **数据截止 (asOf)**：${rec.asOf || '—'}`,
      `- **基准**：${rec.benchmark || '—'}`,
      `- **置信度**：${rec.confidence === null ? '—' : rec.confidence}`,
      `- **复盘日**：${rec.reviewDate || '—'}`,
      `- **状态**：${rec.status}`,
      rec.dataVersion ? `- **数据版本**：${rec.dataVersion}` : null,
      sources.length ? `- **数据源**：${sources.join(', ')}` : null,
      '',
      '## 观察（Observation）',
      '',
      rec.observation,
      '',
      '## 假设（Hypothesis）',
      '',
      rec.hypothesis,
      '',
      '## 证据（Evidence）',
      '',
      ...(evidence.length ? evidence.map((e) => '- ' + e) : ['—']),
      '',
      '## 反证（Counter Evidence）',
      '',
      ...(counterEvidence.length ? counterEvidence.map((e) => '- ' + e) : ['—']),
      '',
      '## 预测（Prediction）',
      '',
      rec.prediction || '—',
      '',
      rec.reviewedAt ? '## 复盘（Review）' : null,
      rec.reviewedAt ? '' : null,
      rec.reviewedAt ? `- **复盘时间**：${rec.reviewedAt}` : null,
      rec.reviewedAt ? `- **结论**：${rec.verdict}` : null,
      rec.reviewedAt ? '' : null,
      rec.reviewedAt && rec.reviewNotes ? rec.reviewNotes : null,
      '',
      '---',
      '⚠️ 本记录为个人研究过程存档，不构成投资建议。',
    ].filter((x) => x !== null).join('\n')
    writeFileSync(join(NOTES_DIR, rec.id + '.md'), md, 'utf8')
  }

  _hydrate(row) {
    const parse = (v) => { try { return v === null ? null : JSON.parse(v) } catch { return v } }
    return {
      ...row,
      evidence: parse(row.evidence),
      counterEvidence: parse(row.counterEvidence),
      tags: parse(row.tags),
      sources: parse(row.sources),
    }
  }

  close() { try { this.db.close() } catch { /* ignore */ } }
}

export const paths = { HOME, ROOT, NOTES_DIR, DB_PATH }
