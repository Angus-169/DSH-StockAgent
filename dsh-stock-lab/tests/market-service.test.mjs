/**
 * market-service.test.mjs — 离线单元测试（不依赖网络）
 * 运行：node tests/market-service.test.mjs
 */
import { strict as assert } from 'node:assert'
import { normalize, marketOf, parseFlags } from '../src/services/market-service/symbols.js'
import { TtlCache } from '../src/services/market-service/cache.js'

let passed = 0
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}
async function ta(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

console.log('symbols.normalize')
t('600519 → SH600519', () => {
  const r = normalize('600519')
  assert.equal(r.symbol, 'SH600519'); assert.equal(r.market, 'SH'); assert.equal(r.tencent, 'sh600519'); assert.equal(r.secid, '1.600519')
})
t('300750 → SZ300750', () => assert.equal(normalize('300750').symbol, 'SZ300750'))
t('430047 → BJ430047', () => assert.equal(normalize('430047').market, 'BJ'))
t('600519.SH / sh600519 / SH600519 等价', () => {
  for (const s of ['600519.SH', 'sh600519', 'SH600519']) assert.equal(normalize(s).symbol, 'SH600519')
})
t('IDX000300 → 指数 + 腾讯代码 sh000300', () => {
  const r = normalize('IDX000300')
  assert.equal(r.kind, 'index'); assert.equal(r.tencent, 'sh000300'); assert.equal(r.name, '沪深300')
})
t('裸 000001 按股票解析（与上证指数歧义时股票优先，指数需 IDX 前缀）', () => {
  const r = normalize('000001')
  assert.equal(r.kind, 'stock'); assert.equal(r.symbol, 'SZ000001') // 平安银行
  assert.equal(normalize('IDX000001').kind, 'index')                 // 上证指数
})
t('510300 识别为 ETF', () => assert.equal(normalize('510300').kind, 'etf'))
t('159915 识别为深 ETF', () => { const r = normalize('159915'); assert.equal(r.kind, 'etf'); assert.equal(r.market, 'SZ') })
t('非法输入抛错', () => { assert.throws(() => normalize('abc')); assert.throws(() => normalize('')) })
t('688981 科创板 → SH', () => assert.equal(normalize('688981').market, 'SH'))
t('920001 北交所新号段 → BJ', () => assert.equal(normalize('920001').market, 'BJ'))

console.log('parseFlags')
t('ST 标识', () => assert.deepEqual(parseFlags('ST某某'), { st: true }))
t('新股 N 前缀', () => assert.deepEqual(parseFlags('N新股'), { new: true }))
t('普通名称无标志', () => assert.deepEqual(parseFlags('贵州茅台'), {}))

console.log('marketOf')
t('号段归类', () => {
  assert.equal(marketOf('600519'), 'SH'); assert.equal(marketOf('000001'), 'SZ')
  assert.equal(marketOf('300750'), 'SZ'); assert.equal(marketOf('830799'), 'BJ')
  assert.equal(marketOf('123456'), null)
})

console.log('TtlCache')
await ta('命中缓存不重复加载', async () => {
  let calls = 0
  const c = new TtlCache()
  const loader = async () => { calls++; return 42 }
  await c.get('k', 1000, loader); await c.get('k', 1000, loader)
  assert.equal(calls, 1)
})
await ta('过期后重新加载', async () => {
  let t0 = 1000, calls = 0
  const c = new TtlCache(() => t0)
  const loader = async () => ++calls
  await c.get('k', 100, loader)
  t0 += 200
  await c.get('k', 100, loader)
  assert.equal(calls, 2)
})
await ta('并发合并 single-flight', async () => {
  let calls = 0
  const c = new TtlCache()
  const loader = () => new Promise((r) => setTimeout(() => { calls++; r(1) }, 20))
  await Promise.all([c.get('k', 1000, loader), c.get('k', 1000, loader), c.get('k', 1000, loader)])
  assert.equal(calls, 1)
})
await ta('失败不写缓存，下次重试', async () => {
  let calls = 0
  const c = new TtlCache()
  const bad = async () => { calls++; throw new Error('boom') }
  await assert.rejects(c.get('k', 1000, bad))
  await assert.rejects(c.get('k', 1000, bad))
  assert.equal(calls, 2)
})

console.log(`\n${passed} passed`)
