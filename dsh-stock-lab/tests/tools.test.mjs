/**
 * tools.test.mjs — Tools 层计算逻辑测试（用假 market，不联网、不需 DSH 宿主）
 * 运行：node tests/tools.test.mjs
 */
import { strict as assert } from 'node:assert'
import { registerStockTools } from '../src/tools/index.js'

let passed = 0
const api = []; const pending = []
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

// 造假 market
function makeBars(n, start = 100, step = 1, vol = 1000) {
  const bars = []
  for (let i = 0; i < n; i++) {
    const c = start + i * step
    bars.push({ time: `2026-01-${String(i % 28 + 1).padStart(2, '0')}`, open: c - 1, high: c + 2, low: c - 2, close: c, volume: vol })
  }
  return bars
}
const fakeMarket = {
  getQuotes: async (ss) => ss.map((s) => ({ symbol: s, price: 100, changePct: 1.5, source: 'fake' })),
  getQuote: async (s) => ({ symbol: s, price: 100, changePct: 1.5, source: 'fake' }),
  getKline: async (s, o) => {
    if (String(s).startsWith('IDX')) return makeBars(o?.count || 120, 100, 0.5, 5000)
    return makeBars(o?.count || 120, 100, 1, 1000)
  },
  // 溯源接口（tools 用它报告数据来源与可复现性）
  // 用 this.getKline 而非 fakeMarket.getKline：这样在测试里覆写 getKline 的
  // 变体（如异常检测用的 anomalMarket）能自动被 getKlineInfo 沿用。
  getKlineInfo: async function (s, o) {
    return {
      symbol: s,
      timeframe: o?.timeframe || '1d',
      adjust: o?.adjust || 'qfq',
      bars: await this.getKline(s, o),
      provenance: {
        dataSource: '本地历史库', sourceKey: 'local', upstreamSource: 'tencent',
        collectedAt: '2026-10-23T10:00:00Z', localRows: 500,
        localRange: '2024-09-25 ~ 2026-10-23',
        dataVersion: 'deadbeefdeadbeef', reproducible: true,
      },
    }
  },
  normalizeSymbol: (s) => ({ symbol: String(s).toUpperCase() }),
  getLocalDataStatus: () => ({
    dataDir: '/tmp/data',
    symbols: [{ symbol: 'SH600519' }],
    available: true,
  }),
  getDataVersion: () => 'deadbeefdeadbeef',
  getMarketOverview: async () => ({ indices: [{ symbol: 'IDX000001', price: 3600, changePct: 1 }], breadth: { up: 3000, down: 1500, flat: 100, total: 4600 }, totalAmount: 1e12, sentiment: { score: 70, label: '偏强' } }),
  getCompanyProfile: async (s) => ({ symbol: s, name: '测试股', industry: '测试行业', pe: 20, pb: 3 }),
  getFinancials: async (s) => ({ symbol: s, reports: [{ reportDate: '2026-06-30', revenue: 1e10, netProfit: 2e9, roe: 15 }] }),
  getMoneyFlow: async (s) => ({ symbol: s, today: { date: '2026-10-23', mainNetInflow: 1e8 }, mainNetInflow5d: 5e8, series: [] }),
  getNews: async (s) => [{ time: '2026-10-20', title: '测试新闻' }],
  search: async (q) => ({ results: [{ symbol: 'SH600519', name: '贵州茅台' }] }),
  // 行业板块（snapshot 会调用）
  getStockSector: async (s) => ({
    symbol: s, name: '测试股', industry: '测试行业', region: '测试地域',
    sector: { id: 'BK0001', name: '测试行业', changePct: 1.2, mainNetInflow: 1e7 },
  }),
  getSectorMembers: async () => [
    { code: '600001', name: '甲', changePct: 3.1 },
    { code: '600002', name: '乙', changePct: 1.0 },
    { code: '600003', name: '丙', changePct: -1.5 },
  ],
  getSector: async (id) => ({ id, name: '测试行业', changePct: 1.2, upCount: 2, downCount: 1 }),
  getSectorList: async () => [{ id: 'BK0001', name: '测试行业', changePct: 1.2, mainNetInflow: 1e7 }],
}

// 假 ctx 收集注册的工具
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register: (def) => { api.push(def) } },
  effect: (fn) => fn(),
  set() {},
  webServer: { register: () => {} },
}
registerStockTools(ctx, fakeMarket)

const byName = (n) => api.find((a) => a.name === n)
const call = async (n, args) => byName(n).execute(args || {})

console.log('tool 注册')
t('注册 9 个行情类工具', () => assert.equal(api.length, 9))
t('含核心快照工具', () => assert.ok(byName('stock_research_snapshot')))
t('含行业板块工具', () => assert.ok(byName('sector_overview')))
t('每个工具都有 parameters 与 description', () => {
  for (const a of api) {
    assert.equal(a.parameters.type, 'object', a.name + ' 缺 parameters')
    assert.ok(a.description && a.description.length > 10, a.name + ' description 过短')
  }
})
t('参数 schema 有 additionalProperties:false', () => {
  for (const a of api) assert.equal(a.parameters.additionalProperties, false, a.name)
})

console.log('\nstock_kline 统计量')
let klineResult
t('返回统计量且为数字', async () => {})
;(async () => {
  klineResult = await call('stock_kline', { symbol: '600519', count: 120 })
  try {
    assert.equal(klineResult.count, 120)
    assert.equal(klineResult.bars.length, 60, 'bars 应截断到 60 根控 token')
    assert.ok(typeof klineResult.stats.return20d === 'number', 'return20d 应为数字')
    assert.ok(klineResult.stats.realizedVol20d !== null, 'realizedVol20d 不为 null')
    // 溯源：必须说明数据从哪来、是否可复现
    assert.ok(klineResult.provenance, 'K线工具应返回 provenance')
    assert.equal(klineResult.provenance.sourceKey, 'local')
    assert.equal(klineResult.provenance.reproducible, true)
    assert.equal(klineResult.provenance.dataVersion, 'deadbeefdeadbeef')
    passed++; console.log('  ✓ stats 返回正确（含溯源信息）')
  } catch (e) { console.error('  ✗ stats —— ' + e.message); process.exitCode = 1 }

  // 快照
  const snap = await call('stock_research_snapshot', { symbol: '600519' })
  try {
    assert.ok(snap.meta && snap.meta.symbol === '600519')
    assert.ok(snap.stock.quote)
    assert.ok(snap.market.sentiment.score === 70)
    assert.ok(snap.relativePerformance.d20, '应有 20 日相对表现')
    assert.ok(typeof snap.relativePerformance.d20.excess === 'number')
    assert.ok(Array.isArray(snap.anomalies))
    assert.ok(snap.financials.latest.reportDate === '2026-06-30')
    // 行业维度（Phase 2 新增）
    assert.equal(snap.sector.name, '测试行业')
    assert.equal(snap.sector.id, 'BK0001')
    assert.equal(snap.sector.memberCount, 3)
    assert.equal(snap.sector.memberUpCount, 2)
    assert.equal(snap.sector.memberDownCount, 1)
    assert.ok(typeof snap.sector.stockVsSectorToday === 'number', '个股 vs 板块当日差应为数字')
    // 长窗口 + 溯源（T2.4b）
    assert.ok(snap.meta.barsUsed >= 120, '应用长窗口取数，实际 ' + snap.meta.barsUsed)
    assert.ok(snap.meta.provenance?.stock, 'snapshot 应带 K 线溯源')
    assert.ok(snap.priceBehavior.rangeStart && snap.priceBehavior.rangeEnd, '应给出数据区间')
    assert.ok('return120d' in snap.priceBehavior, '应含 120 日收益')
    assert.ok('realized60d' in snap.volatility, '应含 60 日波动率')
    assert.ok('d120' in snap.relativePerformance, '应含 120 日相对表现')
    passed++; console.log('  ✓ snapshot 结构完整（含行业维度 + 长窗口 + 溯源）')
  } catch (e) { console.error('  ✗ snapshot —— ' + e.message); process.exitCode = 1 }

  // 异常检测：构造明显异常
  const anomalMarket = {
    ...fakeMarket,
    getKline: async (s, o) => {
      const n = o?.count || 120
      if (String(s).startsWith('IDX')) return makeBars(n, 100, 0.1, 1000) // 基准几乎不动
      const bars = makeBars(n, 100, 1, 1000)
      // 最后一天暴涨 + 巨量
      bars[bars.length - 1] = { ...bars[bars.length - 1], close: bars[bars.length - 1].close * 1.15, volume: 100000 }
      return bars
    },
  }
  const ctx2 = { logger: ctx.logger, tools: { register: (d) => api.push(d) }, effect: (f) => f(), set() {} }
  const api2 = []
  ctx2.tools = { register: (d) => api2.push(d) }
  registerStockTools(ctx2, anomalMarket)
  const snap2 = await api2.find((a) => a.name === 'stock_research_snapshot').execute({ symbol: '600519' })
  try {
    assert.ok(snap2.anomalies.length >= 2, '应检出多个异常，实际 ' + snap2.anomalies.length)
    const kinds = snap2.anomalies.map((a) => a.kind)
    assert.ok(kinds.includes('volume'), '应检出 volume 异常: ' + kinds.join(','))
    assert.ok(kinds.includes('relativeStrength'), '应检出相对强弱异常: ' + kinds.join(','))
    passed++; console.log('  ✓ 异常检测生效: ' + kinds.join(', '))
  } catch (e) { console.error('  ✗ 异常检测 —— ' + e.message); process.exitCode = 1 }

  // 错误处理
  const badMarket = { ...fakeMarket, getMarketOverview: async () => { throw new Error('timeout of 5000ms exceeded') } }
  const api3 = []
  const ctx3 = { logger: ctx.logger, tools: { register: (d) => api3.push(d) }, effect: (f) => f(), set() {} }
  registerStockTools(ctx3, badMarket)
  try {
    await api3.find((a) => a.name === 'market_overview').execute({})
    console.error('  ✗ 错误翻译 —— 应抛错'); process.exitCode = 1
  } catch (e) {
    try {
      assert.match(e.message, /超时/, '错误应翻译成人话: ' + e.message)
      passed++; console.log('  ✓ 错误翻译成人话: ' + e.message)
    } catch (e2) { console.error('  ✗ 错误翻译 —— ' + e2.message); process.exitCode = 1 }
  }

  await t('相对强弱用长窗口并报告双端溯源', async () => {
  const rs = await call('stock_relative_strength', { symbol: '600519' })
  assert.ok(rs.periods?.d60, '应含 60 日相对表现')
  assert.ok(rs.provenance, '应报告溯源')
  assert.ok(rs.provenance.stock && rs.provenance.benchmark, '个股与基准都要有溯源')
  assert.equal(rs.provenance.stock.reproducible, true)
})

console.log(`\n${passed} passed`)
})()
