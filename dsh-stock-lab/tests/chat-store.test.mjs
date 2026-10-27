/**
 * chat-store.test.mjs — 对话数据层测试（临时库，纯离线）
 * 运行：node tests/chat-store.test.mjs
 */
import { strict as assert } from 'node:assert'
import { cleanupTempDir } from './cleanup.mjs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TEST_HOME = join(process.cwd(), '.test-data', 'chat-' + randomUUID().slice(0, 8))
process.env.DSH_STOCK_LAB_HOME = TEST_HOME

const { ChatStore, GLOBAL_THREAD, MESSAGE_ROLES } = await import('../src/services/chat-service/chat-store.js')

let passed = 0
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

console.log('线程管理')
const store = new ChatStore()

await t('首次取线程会创建', () => {
  const th = store.ensureThread('600519')
  assert.ok(th.id)
  assert.equal(th.symbol, 'SH600519', 'symbol 应被规范化')
  assert.equal(th.isGlobal, false)
  assert.equal(th.messageCount, 0)
  assert.equal(th.summarizedUpTo, 0)
})
await t('同一标的再次取到同一线程（不重复创建）', () => {
  const a = store.ensureThread('600519')
  const b = store.ensureThread('SH600519')
  assert.equal(a.id, b.id)
  assert.equal(store.listThreads({}).length, 1)
})
await t('不同标的各自独立线程', () => {
  const a = store.ensureThread('600519')
  const b = store.ensureThread('300750')
  assert.notEqual(a.id, b.id)
  assert.equal(a.symbol, 'SH600519')
  assert.equal(b.symbol, 'SZ300750')
})
await t('全局线程唯一（symbol 为空）', () => {
  const g1 = store.ensureThread(GLOBAL_THREAD)
  const g2 = store.ensureThread(null)
  const g3 = store.ensureThread('')
  assert.equal(g1.id, g2.id)
  assert.equal(g1.id, g3.id)
  assert.equal(g1.isGlobal, true)
  assert.equal(g1.symbol, null)
})
await t('线程标题默认取标的或「研究主线」', () => {
  assert.equal(store.ensureThread('600519').title, 'SH600519')
  assert.equal(store.ensureThread(GLOBAL_THREAD).title, '研究主线')
})
await t('可改名，空标题被拒', () => {
  const th = store.ensureThread('600519')
  assert.equal(store.renameThread(th.id, '茅台的估值问题').title, '茅台的估值问题')
  assert.throws(() => store.renameThread(th.id, '   '), /标题不能为空/)
})

console.log('\n消息读写')
let th
await t('追加消息并自动递增 seq', () => {
  th = store.ensureThread('600519')
  const m1 = store.appendMessage(th.id, { role: 'user', content: '最近怎么回事？' })
  const m2 = store.appendMessage(th.id, { role: 'assistant', content: '先说事实：近 120 日 -46%…' })
  assert.equal(m1.seq, 1)
  assert.equal(m2.seq, 2)
  assert.equal(m1.role, 'user')
  assert.ok(m1.createdAt)
})
await t('messageCount 随之增加', () => {
  assert.equal(store.getThread(th.id).messageCount, 2)
})
await t('按时间正序读回', () => {
  const list = store.listMessages(th.id)
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((m) => m.seq), [1, 2])
  assert.equal(list[0].content, '最近怎么回事？')
})
await t('非法 role 被拒', () => {
  assert.throws(() => store.appendMessage(th.id, { role: 'robot', content: 'x' }), /role 必须是/)
  assert.throws(() => store.appendMessage(th.id, { role: '', content: 'x' }), /role 必须是/)
})
await t('content 必须是字符串', () => {
  assert.throws(() => store.appendMessage(th.id, { role: 'user', content: { a: 1 } }), /content 必须是字符串/)
})
await t('不存在的线程写入被拒', () => {
  assert.throws(() => store.appendMessage('nope', { role: 'user', content: 'x' }), /线程不存在/)
})
await t('toolCalls / meta 结构化存取', () => {
  const m = store.appendMessage(th.id, {
    role: 'tool',
    content: '工具返回摘要',
    toolCalls: [{ name: 'stock_research_snapshot', args: { symbol: '600519' }, ok: true }],
    meta: { provider: 'deepseek', model: 'x', tokens: 123 },
  })
  const back = store.getMessage(m.id)
  assert.equal(back.toolCalls[0].name, 'stock_research_snapshot')
  assert.equal(back.toolCalls[0].args.symbol, '600519')
  assert.equal(back.meta.tokens, 123)
})
await t('未传 toolCalls / meta 时存为 null（不是 undefined）', () => {
  const m = store.appendMessage(th.id, { role: 'user', content: 'x' })
  const back = store.getMessage(m.id)
  assert.equal(back.toolCalls, null)
  assert.equal(back.meta, null)
})
await t('tail 只取最近 N 条，但仍按正序返回', () => {
  const list = store.listMessages(th.id, { tail: 2, limit: 2 })
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((m) => m.seq), [3, 4], 'tail 应取最新且正序（便于直接渲染）')
})
await t('afterSeq 增量拉取（用于流式追加）', () => {
  const list = store.listMessages(th.id, { afterSeq: 2 })
  assert.deepEqual(list.map((m) => m.seq), [3, 4])
})

console.log('\n线程列表与活跃度')
await t('listActiveThreads 过滤掉空线程', () => {
  store.ensureThread('601318')            // 建了但没说话
  const all = store.listThreads({})
  const active = store.listActiveThreads({})
  assert.ok(all.length > active.length, '应有空线程被过滤')
  assert.ok(active.every((x) => x.messageCount > 0))
})
await t('按最近活跃排序', () => {
  const other = store.ensureThread('300750')
  store.appendMessage(other.id, { role: 'user', content: '宁德时代呢' })
  const active = store.listActiveThreads({})
  assert.equal(active[0].symbol, 'SZ300750', '刚说话的线程应排最前')
})

console.log('\n摘要与笔记关联')
await t('写入滚动摘要并记录摘要到哪一条', () => {
  const r = store.setSummary(th.id, '用户问了近期表现，助手给出了 120 日超额与三季报事实。', 3)
  assert.ok(r.summary.includes('120 日超额'))
  assert.equal(r.summarizedUpTo, 3)
})
await t('摘要可更新（不是只能写一次）', () => {
  const r = store.setSummary(th.id, '更新后的摘要', 10)
  assert.equal(r.summary, '更新后的摘要')
  assert.equal(r.summarizedUpTo, 10)
})
await t('关联研究笔记并去重', () => {
  store.linkNote(th.id, 'note-a')
  const r = store.linkNote(th.id, 'note-a')
  assert.deepEqual(r.noteIds, ['note-a'], '重复关联不应产生两条')
  assert.deepEqual(store.linkNote(th.id, 'note-b').noteIds, ['note-a', 'note-b'])
})
await t('不存在的线程不能写摘要/关联', () => {
  assert.throws(() => store.setSummary('nope', 'x'), /线程不存在/)
  assert.throws(() => store.linkNote('nope', 'n'), /线程不存在/)
})

console.log('\n删除与统计')
await t('删线程同时删消息（不留孤儿）', () => {
  const tmp = store.ensureThread('601318')
  store.appendMessage(tmp.id, { role: 'user', content: '会被一起删掉' })
  assert.equal(store.deleteThread(tmp.id), true)
  assert.equal(store.getThread(tmp.id), null)
  assert.equal(store.listMessages(tmp.id).length, 0)
})
await t('stats 反映线程与消息分布', () => {
  const s = store.stats()
  assert.ok(s.threads >= 3)
  assert.ok(s.messages >= 4)
  assert.ok(Array.isArray(s.byRole))
  const userRow = s.byRole.find((r) => r.role === 'user')
  assert.ok(userRow && userRow.n >= 3, '应有 user 消息统计')
})

console.log('\n懒创建：读路径绝不建线程')
// 用户明确要求：不该为每个标的预先建好对话等输入，而是真的开口了才建。
// 早期实现把读路径也做成了"确保存在"，于是**每浏览过一只股票就留下一个空线程**。
await t('findThread 对未聊过的标的不创建', () => {
  const before = store.listThreads({}).length
  const t1 = store.findThread('002594')
  const t2 = store.findThread('002594')
  assert.equal(t1, null)
  assert.equal(t2, null)
  assert.equal(store.listThreads({}).length, before, '不应该多出线程')
})
await t('findThread 对已有线程正常返回', () => {
  const th = store.ensureThread('600519')
  const found = store.findThread('600519')
  assert.equal(found.id, th.id)
})
await t('findThread 支持全局线程', () => {
  const g = store.ensureThread(GLOBAL_THREAD)
  assert.equal(store.findThread(GLOBAL_THREAD).id, g.id)
})
await t('浏览 50 个标的（只读）后线程数不变', () => {
  const before = store.listThreads({}).length
  for (let i = 0; i < 50; i++) {
    store.findThread(String(600000 + i))
  }
  assert.equal(store.listThreads({}).length, before, '只读不该产生任何线程')
})
await t('pruneEmptyThreads 清掉空线程并返回数量', () => {
  // 手工造几个空线程（ensureThread 会建）
  store.ensureThread('601398')
  store.ensureThread('601939')
  const all = store.listThreads({})
  const empty = all.filter((x) => x.messageCount === 0).length
  assert.ok(empty >= 2, '应有空线程可清，实际 ' + empty)
  const pruned = store.pruneEmptyThreads()
  assert.equal(pruned, empty)
  assert.equal(store.listThreads({}).filter((x) => x.messageCount === 0).length, 0)
})
await t('pruneEmptyThreads 不会误删有消息的线程', () => {
  const th = store.ensureThread('600519')
  store.appendMessage(th.id, { role: 'user', content: '有内容' })
  store.pruneEmptyThreads()
  assert.ok(store.getThread(th.id), '有消息的线程应保留')
})

console.log('\n持久化与约束')
await t('重开库数据仍在（含摘要与关联）', () => {
  store.close()
  const s2 = new ChatStore()
  const list = s2.listMessages(th.id)
  assert.ok(list.length >= 4)
  const t2 = s2.getThread(th.id)
  assert.equal(t2.summary, '更新后的摘要')
  assert.deepEqual(t2.noteIds, ['note-a', 'note-b'])
  s2.close()
})
await t('角色集合是预期的四种', () => {
  assert.deepEqual([...MESSAGE_ROLES].sort(), ['assistant', 'system', 'tool', 'user'])
})

cleanupTempDir(TEST_HOME)
console.log(`\n${passed} passed`)
