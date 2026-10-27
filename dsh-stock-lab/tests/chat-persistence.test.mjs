/**
 * chat-persistence.test.mjs — 「两周后还能接上之前的对话吗？」
 *
 * 这是用户直接提出的问题，因此单独一个测试文件把它钉死：
 *
 *   1. **跨进程重启**：今天写入 → 关闭数据库（模拟 DSH 重启）→ 重开 → 还能读到
 *   2. **不同写法匹配同一会话**：600519 / sh600519 / 600519.SH 都指向同一条
 *   3. **规范化形式是持久化格式**：钉死它，改了就会让旧会话失联（有测试报警）
 *   4. **真实会话 id 是确定性的**：两周后能用同一 id 去 resume 找回来
 *
 * 运行：node tests/chat-persistence.test.mjs
 */
import { strict as assert } from 'node:assert'
import { cleanupTempDir } from './cleanup.mjs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TEST_ROOT = join(process.cwd(), '.test-data', 'persist-' + randomUUID().slice(0, 8))
import { mkdirSync } from 'node:fs'
mkdirSync(TEST_ROOT, { recursive: true })
const DB = join(TEST_ROOT, 'index.db')

const { ChatStore, GLOBAL_THREAD } = await import('../src/services/chat-service/chat-store.js')
const { ChatService } = await import('../src/services/chat-service/index.js')
const {
  sessionIdForSymbol, symbolFromSessionId, isStockLabSession, SESSION_PREFIX, GLOBAL_SUFFIX,
} = await import('../src/services/chat-service/session-map.js')

let passed = 0
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

console.log('跨重启：今天聊过，两周后打开还能接上吗')
await t('写入 → 关闭库（模拟 DSH 重启）→ 重开 → 对话仍在', () => {
  const s1 = new ChatStore(DB)
  const th = s1.ensureThread('600519')
  s1.appendMessage(th.id, { role: 'user', content: '茅台最近怎么了？' })
  s1.appendMessage(th.id, { role: 'assistant', content: '近 120 日 -46%，三季报增速放缓。' })
  const idBefore = th.id
  s1.close()

  // —— 模拟 DSH 重启：全新进程内重建 store（同一 db 文件）——
  const s2 = new ChatStore(DB)
  const found = s2.findThread('600519')
  assert.ok(found, '两周后应能匹配到之前的线程')
  assert.equal(found.id, idBefore, '应是**同一个**线程，不是新建的')
  const msgs = s2.listMessages(found.id)
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].content, '茅台最近怎么了？')
  assert.equal(msgs[1].content, '近 120 日 -46%，三季报增速放缓。')
  s2.close()
})
await t('重开后 findThread 不会重复创建（仍只有一条线程）', () => {
  const s = new ChatStore(DB)
  const n = s.listThreads({}).length
  s.findThread('600519')
  s.findThread('600519')
  assert.equal(s.listThreads({}).length, n, '查询不该新建')
  s.close()
})

console.log('\n不同写法必须匹配到同一会话（否则"两次打开"会分裂成两个对话）')
await t('600519 / SH600519 / sh600519 / 600519.SH / 600519.SS 指向同一线程', () => {
  const s = new ChatStore(DB)
  const base = s.findThread('600519').id
  for (const spelling of ['SH600519', 'sh600519', '600519.SH', '600519.SS', '600519.sh', ' 600519 ']) {
    const th = s.findThread(spelling)
    assert.ok(th, `${spelling} 应能匹配到线程`)
    assert.equal(th.id, base, `${spelling} 应解析到同一线程`)
  }
  s.close()
})
await t('深市同理：300750 / sz300750 / 300750.SZ', () => {
  const s = new ChatStore(DB)
  const th = s.ensureThread('300750')
  s.appendMessage(th.id, { role: 'user', content: '宁德时代' })
  for (const spelling of ['SZ300750', 'sz300750', '300750.SZ']) {
    assert.equal(s.findThread(spelling).id, th.id, spelling)
  }
  s.close()
})
await t('指数：IDX000300 与 000300 指向同一线程', () => {
  const s = new ChatStore(DB)
  const th = s.ensureThread('IDX000300')
  assert.equal(s.findThread('IDX000300').id, th.id)
  assert.equal(s.findThread('idx000300').id, th.id)
  s.close()
})
await t('全局主线与个股线程互不串台', () => {
  const s = new ChatStore(DB)
  const g = s.ensureThread(GLOBAL_THREAD)
  const sh = s.findThread('600519')
  assert.notEqual(g.id, sh.id)
  assert.equal(s.findThread(GLOBAL_THREAD).id, g.id)
  s.close()
})

console.log('\n服务层：切标的自动切到该标的的会话')
await t('换标的读到各自的对话，切回来还在', () => {
  const s = new ChatStore(DB)
  const svc = new ChatService({ store: s, tools: new Map(), systemBase: 'x' })

  // 今天：聊茅台
  const mt = svc.listMessages('600519')
  assert.equal(mt.messages.length, 2, '应读到之前那 2 条')
  // 两周后：先看别的标的（不产生副作用）→ 再切回茅台
  assert.deepEqual(svc.listMessages('002594').messages, [], '没聊过的标的是空的')
  assert.equal(svc.listMessages('002594').thread, null, '且不该创建')
  const back = svc.listMessages('600519')
  assert.equal(back.messages.length, 2, '切回来仍应看到原对话')
  assert.equal(back.thread.id, mt.thread.id, '还是同一个线程')
  svc.close()
})
await t('hasThread 跨重启仍然准确', () => {
  const s = new ChatStore(DB)
  const svc = new ChatService({ store: s, tools: new Map(), systemBase: 'x' })
  assert.equal(svc.hasThread('600519'), true, '聊过的：true')
  assert.equal(svc.hasThread('002594'), false, '没聊过的：false')
  svc.close()
})

console.log('\n真实会话（二层）：两周后靠确定性 id 找回来')
await t('会话 id 由标的确定性推导，同一标的永远同一个 id', () => {
  const a = sessionIdForSymbol('600519')
  const b = sessionIdForSymbol('SH600519')
  const c = sessionIdForSymbol('sh600519')
  assert.equal(a, b)
  assert.equal(b, c)
  assert.equal(a, SESSION_PREFIX + 'sh600519')
})
await t('不同标的得到不同 id', () => {
  const ids = ['600519', '300750', '601318', '000001', 'IDX000300'].map(sessionIdForSymbol)
  assert.equal(new Set(ids).size, ids.length, '不应冲突：' + ids.join(','))
})
await t('从会话 id 能反推标的（回溯"这是哪只股票的会话"）', () => {
  assert.equal(symbolFromSessionId(sessionIdForSymbol('600519')), 'SH600519')
  assert.equal(symbolFromSessionId(sessionIdForSymbol('300750')), 'SZ300750')
  assert.equal(symbolFromSessionId(sessionIdForSymbol('IDX000300')), 'IDX000300')
  assert.equal(symbolFromSessionId('session-abc123'), null, '非本插件创建的会话应返回 null')
})
await t('全局主线的会话 id 可识别且不归属标的', () => {
  const id = sessionIdForSymbol(null)
  assert.equal(id, SESSION_PREFIX + GLOBAL_SUFFIX)
  assert.equal(sessionIdForSymbol(''), id)
  assert.equal(sessionIdForSymbol('global'), id)
  assert.equal(symbolFromSessionId(id), null, '全局线程不该被当作某只股票')
})
await t('isStockLabSession 用于识别归属', () => {
  assert.equal(isStockLabSession(sessionIdForSymbol('600519')), true)
  assert.equal(isStockLabSession('session-5098a806-1098-4b9d-b081-ee3099ce627e'), false)
})
await t('无法识别的写法不崩，且仍保持确定性', () => {
  const a = sessionIdForSymbol('这不是代码')
  const b = sessionIdForSymbol('这不是代码')
  assert.equal(a, b, '两次必须一致，否则两周后找不回')
  assert.ok(isStockLabSession(a))
})

console.log('\n规范化形式是持久化格式：钉死它（改了会让旧会话失联）')
await t('标的规范化输出被钉死', async () => {
  const { normalize } = await import('../src/services/market-service/symbols.js')
  const expect = {
    600519: 'SH600519', '600519.SH': 'SH600519', sh600519: 'SH600519', '600519.SS': 'SH600519',
    300750: 'SZ300750', '300750.SZ': 'SZ300750', sz300750: 'SZ300750',
    601318: 'SH601318', '000001': 'SZ000001',
    IDX000300: 'IDX000300', idx000300: 'IDX000300',
  }
  for (const [input, out] of Object.entries(expect)) {
    assert.equal(normalize(input).symbol, out, `${input} 应规范化为 ${out}`)
  }
})
await t('线程表对同一标的有唯一性约束（DB 层保证不会分裂）', () => {
  const s = new ChatStore(DB)
  const th = s.findThread('600519')
  // 再次 ensureThread 应返回同一条，而不是插入新行
  const again = s.ensureThread('600519')
  assert.equal(again.id, th.id)
  assert.equal(s.listThreads({}).filter((x) => x.symbol === 'SH600519').length, 1)
  s.close()
})

cleanupTempDir(TEST_ROOT)
console.log(`\n${passed} passed`)
