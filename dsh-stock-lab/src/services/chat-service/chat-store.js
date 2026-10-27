/**
 * chat-store.js — Stock Lab Chat 的持久化层
 *
 * 设计（ARCHITECTURE §12）：**对话保存过程，笔记保存结论。**
 *   - 这里只负责把「过程」可靠地存下来（消息、工具调用、时间）
 *   - 「结论」交给 research-service 的 Research Note
 *   - 线程按标的组织：每个标的（股票/ETF/指数）一条，另有一条「全局」线程
 *
 * 存储：SQLite（node:sqlite，零依赖）
 * 目录：$DSH_STOCK_LAB_HOME/chat/index.db 或 $DSH_HOME/stock-lab/chat/index.db
 *
 * ⚠️ 为什么不在会话里只存「最近 N 轮」：
 *   用户要能**回看**完整过程（"我上个月到底怎么想的"）。所以原始消息全存，
 *   「喂给模型多少」是 T7.2 的装配问题，与存储无关。两件事必须分开。
 */

import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { normalize } from '../market-service/symbols.js'

function resolveRoot() {
  const explicit = process.env.DSH_STOCK_LAB_HOME
  if (explicit) return join(explicit, 'chat')
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'stock-lab', 'chat')
}

/** 线程归属：'global' 表示跨标的的研究主线 */
export const GLOBAL_THREAD = 'global'

/** 允许的消息角色 */
export const MESSAGE_ROLES = ['user', 'assistant', 'tool', 'system']

export function normSymbol(input) {
  const raw = String(input || '').trim()
  if (raw === '') return null
  if (raw === GLOBAL_THREAD) return null
  try { return normalize(raw).symbol } catch { return raw.toUpperCase() }
}

export class ChatStore {
  constructor(dbPath = join(resolveRoot(), 'index.db')) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        symbol TEXT,                        -- NULL = 全局线程
        title TEXT,
        summary TEXT,                       -- 滚动摘要（由装配层维护）
        summarizedUpTo INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        messageCount INTEGER NOT NULL DEFAULT 0,
        noteIds TEXT                        -- 关联的研究笔记 id 列表
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_symbol
        ON threads(symbol) WHERE symbol IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updatedAt);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        threadId TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        toolCalls TEXT,                     -- 工具调用/结果的结构化载荷
        meta TEXT,                          -- 模型/来源/token 等
        createdAt TEXT NOT NULL,
        FOREIGN KEY (threadId) REFERENCES threads(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_thread_seq ON messages(threadId, seq);
      CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(threadId);
    `)
  }

  /**
   * 取得（或创建）某标的的线程。全局线程用 symbol=null。
   * @param symbol 标的内码；传 GLOBAL_THREAD 或空则取全局线程
   */
  ensureThread(symbol, opts = {}) {
    const sym = normSymbol(symbol)
    const existing = sym === null
      ? this.db.prepare('SELECT * FROM threads WHERE symbol IS NULL').get()
      : this.db.prepare('SELECT * FROM threads WHERE symbol = ?').get(sym)
    if (existing) return this._hydrateThread(existing)

    const now = new Date().toISOString()
    const rec = {
      id: randomUUID(),
      symbol: sym,
      title: opts.title || (sym === null ? '研究主线' : sym),
      summary: null,
      summarizedUpTo: 0,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      noteIds: null,
    }
    this.db.prepare(`
      INSERT INTO threads (id,symbol,title,summary,summarizedUpTo,createdAt,updatedAt,messageCount,noteIds)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(rec.id, rec.symbol, rec.title, rec.summary, rec.summarizedUpTo,
      rec.createdAt, rec.updatedAt, rec.messageCount, rec.noteIds)
    return this.getThread(rec.id)
  }

  getThread(id) {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id)
    return row ? this._hydrateThread(row) : null
  }

  /**
   * 查找某标的的线程，**不创建**。
   *
   * ⚠️ 读路径必须用它，不能用 ensureThread。
   * 真实教训：前端每次切换标的都会调 `/chat/messages` 加载历史；
   * 若那里用 ensureThread，**用户每浏览过一只股票就会留下一个空线程** ——
   * 全市场浏览一遍就是几千条空记录。懒创建的含义是：
   * **只有真的在右栏输入了内容，才创建线程**（由 start() 负责）。
   */
  findThread(symbol) {
    const sym = normSymbol(symbol)
    const row = sym === null
      ? this.db.prepare('SELECT * FROM threads WHERE symbol IS NULL').get()
      : this.db.prepare('SELECT * FROM threads WHERE symbol = ?').get(sym)
    return row ? this._hydrateThread(row) : null
  }

  /**
   * 删除没有任何消息的空线程（清理历史遗留）。
   * 返回被删除的数量，便于调用方如实报告。
   */
  pruneEmptyThreads() {
    const rows = this.db.prepare('SELECT id FROM threads WHERE messageCount = 0').all()
    for (const r of rows) this.deleteThread(r.id)
    return rows.length
  }

  listThreads(opts = {}) {
    const limit = Math.min(Math.max(opts.limit || 100, 1), 500)
    const rows = this.db.prepare(
      'SELECT * FROM threads ORDER BY updatedAt DESC LIMIT ?',
    ).all(limit)
    return rows.map((r) => this._hydrateThread(r))
  }

  /** 只列有实际对话的线程（空线程是自动创建的，不该占列表） */
  listActiveThreads(opts = {}) {
    const limit = Math.min(Math.max(opts.limit || 100, 1), 500)
    const rows = this.db.prepare(
      'SELECT * FROM threads WHERE messageCount > 0 ORDER BY updatedAt DESC LIMIT ?',
    ).all(limit)
    return rows.map((r) => this._hydrateThread(r))
  }

  /**
   * 追加一条消息。
   * @param threadId
   * @param msg {role, content, toolCalls?, meta?}
   */
  appendMessage(threadId, msg) {
    const thread = this.getThread(threadId)
    if (!thread) throw new Error('线程不存在：' + threadId)
    const role = String(msg?.role || '')
    if (!MESSAGE_ROLES.includes(role)) {
      throw new Error(`role 必须是 ${MESSAGE_ROLES.join(' / ')} 之一，收到：${role || '（空）'}`)
    }
    if (typeof msg.content !== 'string') throw new Error('content 必须是字符串')

    const now = new Date().toISOString()
    const nextSeq = (this.db.prepare(
      'SELECT COALESCE(MAX(seq), 0) AS s FROM messages WHERE threadId = ?',
    ).get(threadId).s) + 1
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO messages (id,threadId,seq,role,content,toolCalls,meta,createdAt)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(id, threadId, nextSeq, role, msg.content,
      msg.toolCalls === undefined ? null : JSON.stringify(msg.toolCalls),
      msg.meta === undefined ? null : JSON.stringify(msg.meta),
      now)
    this.db.prepare(
      'UPDATE threads SET updatedAt = ?, messageCount = messageCount + 1 WHERE id = ?',
    ).run(now, threadId)
    return this.getMessage(id)
  }

  getMessage(id) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
    return row ? this._hydrateMessage(row) : null
  }

  /**
   * 读取线程消息。默认**按时间正序**返回（对话天然是正的），
   * `tail` 只取最近 N 条（仍然正序返回，便于直接渲染）。
   */
  listMessages(threadId, opts = {}) {
    const limit = Math.min(Math.max(opts.limit || 200, 1), 2000)
    let rows
    if (opts.tail) {
      rows = this.db.prepare(
        'SELECT * FROM messages WHERE threadId = ? ORDER BY seq DESC LIMIT ?',
      ).all(threadId, limit)
      rows.reverse()
    } else {
      const after = Number(opts.afterSeq) || 0
      rows = this.db.prepare(
        'SELECT * FROM messages WHERE threadId = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
      ).all(threadId, after, limit)
    }
    return rows.map((r) => this._hydrateMessage(r))
  }

  /** 更新滚动摘要（T7.2 装配上下文时用），并记录已摘要到哪一条 */
  setSummary(threadId, summary, upToSeq) {
    const t = this.getThread(threadId)
    if (!t) throw new Error('线程不存在：' + threadId)
    const upTo = Number.isFinite(upToSeq) ? Math.max(0, Math.floor(upToSeq)) : t.summarizedUpTo
    this.db.prepare('UPDATE threads SET summary = ?, summarizedUpTo = ?, updatedAt = ? WHERE id = ?')
      .run(String(summary ?? ''), upTo, new Date().toISOString(), threadId)
    return this.getThread(threadId)
  }

  /** 线程与研究笔记的关联（"回溯当时怎么判断"的入口） */
  linkNote(threadId, noteId) {
    const t = this.getThread(threadId)
    if (!t) throw new Error('线程不存在：' + threadId)
    const list = Array.isArray(t.noteIds) ? t.noteIds.slice() : []
    if (!list.includes(noteId)) list.push(noteId)
    this.db.prepare('UPDATE threads SET noteIds = ?, updatedAt = ? WHERE id = ?')
      .run(JSON.stringify(list), new Date().toISOString(), threadId)
    return this.getThread(threadId)
  }

  renameThread(threadId, title) {
    const next = String(title || '').trim()
    if (next === '') throw new Error('标题不能为空')
    this.db.prepare('UPDATE threads SET title = ?, updatedAt = ? WHERE id = ?')
      .run(next, new Date().toISOString(), threadId)
    return this.getThread(threadId)
  }

  /** 删除线程及其全部消息 */
  deleteThread(threadId) {
    this.db.prepare('DELETE FROM messages WHERE threadId = ?').run(threadId)
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(threadId)
    return true
  }

  stats() {
    const threads = this.db.prepare('SELECT COUNT(*) AS n FROM threads').get().n
    const active = this.db.prepare('SELECT COUNT(*) AS n FROM threads WHERE messageCount > 0').get().n
    const messages = this.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n
    const byRole = this.db.prepare('SELECT role, COUNT(*) AS n FROM messages GROUP BY role').all()
    return { threads, activeThreads: active, messages, byRole, root: resolveRoot() }
  }

  _hydrateThread(row) {
    const parse = (v) => { try { return v === null ? null : JSON.parse(v) } catch { return v } }
    return {
      ...row,
      isGlobal: row.symbol === null,
      noteIds: parse(row.noteIds) || [],
    }
  }

  _hydrateMessage(row) {
    const parse = (v) => { try { return v === null ? null : JSON.parse(v) } catch { return v } }
    return {
      ...row,
      toolCalls: parse(row.toolCalls),
      meta: parse(row.meta),
    }
  }

  close() { try { this.db.close() } catch { /* ignore */ } }
}

export const paths = { resolveRoot }