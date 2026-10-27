/**
 * watch.test.mjs — Watch Engine 测试（临时库 + 假 market，纯离线）
 * 运行：node tests/watch.test.mjs
 */
import { strict as assert } from 'node:assert'
import { cleanupTempDir } from './cleanup.mjs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TEST_HOME = join(process.cwd(), '.test-data', 'watch-' + randomUUID().slice(0, 8))
process.env.DSH_STOCK_LAB_HOME = TEST_HOME

const { WatchStore, WATCH_KINDS } = await import('../src/services/watch-service/watch-store.js')
const { evaluateRule, realizedVol, volumeRatio, retPct } = await import('../src/services/watch-service/evaluator.js')
const { WatchService } = await import('../src/services/watch-service/index.js')
const { ResearchStore } = await import('../src/services/research-service/research-store.js')

let passed = 0
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

/**
 * 登记所有打开的 SQLite 包装对象，收尾时统一关闭。
 *
 * 为什么需要：SQLite 连接不关，Windows 上临时目录就删不掉，
 * 而清理代码原来的空 catch 会把这个失败**静默吞掉**——目录越积越多（曾到 55 个）却看不出来。
 */
const OPEN_STORES = []
function track(store) { if (store && typeof store.close === 'function') OPEN_STORES.push(store); return store }

// ── 测试数据 ──
function makeBars(n, start = 100, step = 0.5, vol = 1000) {
  const bars = []
  for (let i = 0; i < n; i++) {
    const c = start + i * step
    bars.push({
      time: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      open: c - 1, high: c + 2, low: c - 2, close: c, volume: vol,
    })
  }
  return bars
}

const quote = (price, changePct, extra = {}) => ({
  symbol: 'SH600519', name: '贵州茅台', price, changePct,
  turnover: extra.turnover ?? 0.5, amount: 1e9, pe: 20, source: 'fake',
})

console.log('统计工具')
await t('realizedVol 计算正确（恒定收益 → 0 波动）', () => {
  const bars = []
  for (let i = 0; i < 30; i++) bars.push({ close: 100 * 1.01 ** i, volume: 1 })
  const v = realizedVol(bars, 20)
  assert.ok(v !== null && v < 1e-6, '恒定增长率波动应为 0，实际 ' + v)
})
await t('volumeRatio 正确', () => {
  const bars = makeBars(25, 100, 0.5, 1000)
  bars[bars.length - 1].volume = 3000
  assert.equal(volumeRatio(bars, 20), 3)
})
await t('retPct 正确', () => {
  const bars = [{ close: 100 }, { close: 110 }]
  assert.equal(Math.round(retPct(bars, 1) * 100) / 100, 10)
})

console.log('\n条件求值：价格阈值')
await t('>= 触发', () => {
  const r = evaluateRule({ kind: 'price_threshold', params: { op: '>=', value: 100 }, symbol: 'SH600519' },
    { quote: quote(105, 1.0) })
  assert.equal(r.fired, true)
  assert.equal(r.metrics.price, 105)
})
await t('未达阈值不触发', () => {
  const r = evaluateRule({ kind: 'price_threshold', params: { op: '>=', value: 200 }, symbol: 'SH600519' },
    { quote: quote(105, 1.0) })
  assert.equal(r.fired, false)
})
await t('参数非法时跳过而非误报', () => {
  const r = evaluateRule({ kind: 'price_threshold', params: {} }, { quote: quote(105, 1) })
  assert.equal(r.fired, false)
  assert.ok(r.skip)
})

console.log('\n条件求值：量能/波动/相对强弱')
await t('volume_anomaly 触发', () => {
  const bars = makeBars(25, 100, 0.5, 1000)
  bars[bars.length - 1].volume = 3000
  const r = evaluateRule({ kind: 'volume_anomaly', params: { n: 20, mult: 2 }, symbol: 'SH600519' }, { bars })
  assert.equal(r.fired, true)
  assert.equal(r.metrics.ratio, 3)
  assert.ok(r.title.includes('成交量异常') || r.title.includes('放量'))
})
await t('数据不足时跳过', () => {
  const r = evaluateRule({ kind: 'volume_anomaly', params: { n: 20, mult: 2 } }, { bars: makeBars(5) })
  assert.equal(r.fired, false)
  assert.match(r.skip, /不足/)
})
await t('volatility_breakout 触发', () => {
  const bars = makeBars(60, 100, 0.1, 1000)
  // 后 20 根制造剧烈波动
  for (let i = 40; i < 60; i++) bars[i].close = 100 + (i % 2 === 0 ? 15 : -15)
  const r = evaluateRule({ kind: 'volatility_breakout', params: { n: 20, ratio: 1.6 } }, { bars })
  assert.equal(r.fired, true, '应检出波动率突破: ' + JSON.stringify(r.metrics))
  assert.ok(r.metrics.ratio >= 1.6)
})
await t('relative_strength_shift 检出跑输', () => {
  const stock = makeBars(40, 100, -1, 1000)   // 下跌
  const bench = makeBars(40, 100, 0, 1000)    // 持平
  const r = evaluateRule(
    { kind: 'relative_strength_shift', params: { n: 20, threshold: 5, direction: 'underperform' }, symbol: 'SH600519' },
    { bars: stock, benchmarkBars: bench })
  assert.equal(r.fired, true)
  assert.ok(r.metrics.excess < 0)
})
await t('方向不匹配则不触发', () => {
  const stock = makeBars(40, 100, -1, 1000)
  const bench = makeBars(40, 100, 0, 1000)
  const r = evaluateRule(
    { kind: 'relative_strength_shift', params: { n: 20, threshold: 5, direction: 'outperform' } },
    { bars: stock, benchmarkBars: bench })
  assert.equal(r.fired, false)
})

console.log('\n条件求值：资金流 / 行业 / 假设到期')
await t('money_flow_anomaly 触发', () => {
  const r = evaluateRule(
    { kind: 'money_flow_anomaly', params: { days: 5, threshold: 5e8, direction: 'inflow' } },
    { moneyFlow: { series: [{ mainNetInflow: 3e8 }, { mainNetInflow: 4e8 }] } })
  assert.equal(r.fired, true)
  assert.equal(r.metrics.sum, 7e8)
})
await t('sector_relative 触发', () => {
  const r = evaluateRule(
    { kind: 'sector_relative', params: { threshold: 3, direction: 'underperform' } },
    { quote: quote(100, -5), stockSector: { sector: { name: '白酒Ⅱ', id: 'BK1277', changePct: 1.2 } } })
  assert.equal(r.fired, true)
  assert.equal(r.metrics.diff, -6.2)
})
await t('hypothesis_review_due 到期触发', () => {
  const r = evaluateRule(
    { kind: 'hypothesis_review_due', noteId: 'n1', symbol: 'SH600519' },
    { note: { id: 'n1', status: 'open', reviewDate: '2020-01-01', prediction: 'p', name: '贵州茅台' } })
  assert.equal(r.fired, true)
  assert.ok(r.detail.includes('预测'))
})
await t('已复盘/无复盘日不触发', () => {
  assert.equal(evaluateRule({ kind: 'hypothesis_review_due', noteId: 'n1' },
    { note: { id: 'n1', status: 'reviewed', reviewDate: '2020-01-01' } }).fired, false)
  assert.equal(evaluateRule({ kind: 'hypothesis_review_due', noteId: 'n1' },
    { note: { id: 'n1', status: 'open', reviewDate: null } }).fired, false)
})
await t('未关联笔记时跳过而非误报', () => {
  const r = evaluateRule({ kind: 'hypothesis_review_due' }, {})
  assert.equal(r.fired, false)
  assert.match(r.skip, /noteId/)
})
await t('未知条件类型跳过', () => {
  const r = evaluateRule({ kind: 'not_a_kind' }, {})
  assert.equal(r.fired, false)
  assert.match(r.skip, /未实现/)
})

console.log('\n规则存储')
const store = track(new WatchStore())
let rule
await t('创建规则并规范化 symbol', () => {
  rule = store.createRule({ symbol: '600519', name: '贵州茅台', kind: 'price_threshold', params: { op: '>=', value: 1400 }, reason: '测试' })
  assert.equal(rule.symbol, 'SH600519')
  assert.equal(rule.enabled, true)
  assert.equal(rule.cooldownMinutes, 240)
  assert.deepEqual(rule.params, { op: '>=', value: 1400 })
})
await t('非法 kind 被拒', () => {
  assert.throws(() => store.createRule({ symbol: '600519', kind: 'bogus' }), /不支持的 kind/)
})
await t('缺 symbol 被拒', () => {
  assert.throws(() => store.createRule({ kind: 'price_threshold' }), /缺少必填字段/)
})
await t('列表与过滤', () => {
  store.createRule({ symbol: '300750', kind: 'volume_anomaly', params: { n: 20, mult: 2 } })
  assert.ok(store.listRules({}).length >= 2)
  assert.equal(store.listRules({ symbol: '300750' }).length, 1)
  assert.equal(store.listRules({ enabledOnly: true }).length >= 2, true)
})
await t('禁用/启用', () => {
  store.setEnabled(rule.id, false)
  assert.equal(store.getRule(rule.id).enabled, false)
  store.setEnabled(rule.id, true)
  assert.equal(store.getRule(rule.id).enabled, true)
})
await t('触发记录写入并累计次数', () => {
  const tr = store.addTrigger({ ruleId: rule.id, symbol: 'SH600519', kind: 'price_threshold', severity: 'warning', title: 'T', detail: 'D', metrics: { a: 1 } })
  assert.ok(tr.id)
  assert.equal(store.getRule(rule.id).triggerCount, 1)
  assert.deepEqual(store.getTrigger(tr.id).metrics, { a: 1 })
})
await t('触发列表过滤与确认', () => {
  const list = store.listTriggers({ symbol: '600519' })
  assert.equal(list.length, 1)
  assert.equal(store.listTriggers({ unacknowledgedOnly: true }).length, 1)
  store.acknowledge(list[0].id, true)
  assert.equal(store.listTriggers({ unacknowledgedOnly: true }).length, 0)
})
await t('stats 反映规则与触发', () => {
  const s = store.stats()
  assert.ok(s.rules >= 2)
  assert.ok(s.triggers >= 1)
})
await t('删除规则', () => {
  const r2 = store.createRule({ symbol: '600519', kind: 'turnover_spike', params: { value: 5 } })
  assert.equal(store.deleteRule(r2.id), true)
  assert.equal(store.getRule(r2.id), null)
})

console.log('\nWatchService（假 market）')
const fakeMarket = {
  getQuote: async () => quote(1500, 9.5, { turnover: 3 }),
  getKline: async (s, o) => {
    const bars = makeBars(o?.count || 120, 100, 0.5, 1000)
    bars[bars.length - 1].volume = 5000
    return bars
  },
  getMoneyFlow: async () => ({ series: [{ mainNetInflow: 9e8 }] }),
  getStockSector: async () => ({ sector: { id: 'BK1277', name: '白酒Ⅱ', changePct: 1.0 } }),
}
const research = track(new ResearchStore())
const svc = track(new WatchService({ market: fakeMarket, research, log: () => {} }))

await t('hypothesis_review_due 必须关联存在的笔记', () => {
  // createRule 是同步方法（校验在写库前完成），用 throws 而非 rejects
  assert.throws(
    () => svc.createRule({ symbol: '600519', kind: 'hypothesis_review_due', noteId: 'nope' }),
    /研究笔记不存在/,
  )
  assert.throws(
    () => svc.createRule({ symbol: '600519', kind: 'hypothesis_review_due' }),
    /必须提供 noteId/,
  )
})
await t('关联真实笔记后创建成功且自动取 symbol', async () => {
  const note = research.create({ symbol: '300750', observation: 'o', hypothesis: 'h', reviewDate: '2020-01-01' })
  const r = svc.createRule({ kind: 'hypothesis_review_due', noteId: note.id })
  assert.equal(r.symbol, 'SZ300750')
  assert.equal(r.noteId, note.id)
})
await t('evaluateAll 汇总触发/跳过', async () => {
  const r = await svc.evaluateAll({})
  assert.ok(r.evaluated >= 1)
  assert.ok(Array.isArray(r.details))
  assert.ok(r.details.some((d) => d.fired), '应至少有一条触发（价格阈值 1500 已满足）')
})
await t('冷却期内不重复写触发记录', async () => {
  const before = svc.listTriggers({}).length
  await svc.evaluateAll({})
  const after = svc.listTriggers({}).length
  assert.equal(after, before, '冷却期内不应新增触发')
  const r = await svc.evaluateAll({})
  assert.ok(r.suppressedByCooldown >= 1, '应报告被冷却抑制')
})
await t('dryRun 不写触发记录', async () => {
  const before = svc.listTriggers({}).length
  await svc.evaluateAll({ dryRun: true })
  assert.equal(svc.listTriggers({}).length, before)
})
await t('trigger 回调被调用', async () => {
  let called = 0
  svc.onTrigger = () => { called++ }
  svc.listRules({}).forEach((r) => svc.store.db.prepare('UPDATE rules SET lastTriggeredAt = NULL WHERE id = ?').run(r.id))
  await svc.evaluateAll({})
  assert.ok(called >= 1, '回调应被调用')
})

console.log('\n持久化')
await t('重开 store 数据仍在', () => {
  store.close()
  const s2 = track(new WatchStore())
  assert.ok(s2.listRules({}).length >= 2)
  s2.close()
})

console.log('\nwatch_digest（待看清单）')
const watchTools = []
const toolCtx = { logger: { info() {}, warn() {}, error() {} }, tools: { register: (d) => watchTools.push(d) } }
const { registerWatchTools } = await import('../src/tools/watch-tools.js')
// 用一个干净的 service，避免受前面冷却状态影响
const svc2 = track(new WatchService({ market: fakeMarket, research, log: () => {} }))
const nTools = registerWatchTools(toolCtx, svc2)
const digestTool = watchTools.find((x) => x.name === 'watch_digest')

await t('注册了 5 个盯盘工具（含 digest）', () => assert.equal(nTools, 5))
await t('无任何触发时给出友好文案', async () => {
  // 限定到一个不存在任何规则/笔记的标的，保证是"空状态"
  const r = await digestTool.execute({ symbol: 'SZ999999' })
  assert.ok(r.digest.includes('暂无未确认触发'), '实际: ' + r.digest)
  assert.equal(r.counts.triggers, 0)
  assert.equal(r.counts.dueNotes, 0)
})
await t('有触发时按严重度分组并带依据数值', async () => {
  const rule = svc2.createRule({ symbol: '600519', name: '贵州茅台', kind: 'price_threshold', params: { op: '>=', value: 1300 } })
  await svc2.evaluateAll({ symbol: '600519' })
  const r = await digestTool.execute({})
  assert.ok(r.counts.triggers >= 1, '应有触发')
  assert.ok(r.digest.includes('盯盘触发'), 'digest 应含标题: ' + r.digest)
  assert.ok(r.digest.includes('1335') || r.digest.includes('价格'), 'digest 应含依据数值')
  assert.ok(r.triggers[0].metrics, '应返回 metrics 便于复核')
})
await t('到期的研究假设被单列并要求复盘', async () => {
  const note = research.create({
    symbol: '600519', name: '贵州茅台', observation: 'o', hypothesis: 'h',
    prediction: '未来5日继续走强', reviewDate: '2020-01-01',
  })
  svc2.createRule({ kind: 'hypothesis_review_due', noteId: note.id })
  const r = await digestTool.execute({})
  // 前面已有一条到期的宁德时代笔记，因此按 symbol 断言更稳
  assert.ok(r.counts.dueNotes >= 1, '应至少一条到期: ' + r.counts.dueNotes)
  assert.ok(r.digest.includes('到期的研究假设'), 'detect: ' + r.digest)
  assert.ok(r.digest.includes('未来5日继续走强'), '应复述当时的预测')
  assert.ok(r.digest.includes('复盘'), '应明确请用户复盘')
  assert.ok(r.dueNotes.some((n) => n.noteId === note.id), '应含刚创建的笔记')
})
await t('已复盘的假设不再列入到期', async () => {
  const note = research.list({ symbol: '600519' })[0]
  research.review(note.id, { verdict: 'correct', reviewNotes: 'x' })
  const r = await digestTool.execute({})
  assert.ok(!r.dueNotes.some((n) => n.noteId === note.id), '已复盘的笔记不应再出现在 dueNotes')
})
await t('提醒 AI 带依据数值而不只堆 JSON', async () => {
  const r = await digestTool.execute({})
  assert.ok(r.instruction.includes('依据数值'), 'instruction 应要求带数值')
  assert.ok(r.instruction.includes('复盘'), 'instruction 应要求引导复盘')
})


// 先把还开着的 SQLite 连接关掉，否则 Windows 上文件被占用、目录删不掉
for (const maybe of OPEN_STORES) {
  try { maybe?.close?.() } catch { /* ignore */ }
}
cleanupTempDir(TEST_HOME)
console.log(`\n${passed} passed`)
