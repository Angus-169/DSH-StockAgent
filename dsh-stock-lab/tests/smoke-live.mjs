/**
 * smoke-live.mjs — 真实网络冒烟测试（打腾讯/新浪真实接口）
 * 运行：node tests/smoke-live.mjs
 */
import { MarketService } from '../src/services/market-service/index.js'

const m = new MarketService({ log: (s) => console.log('   [log] ' + s) })
const show = (label, v) => console.log(label, JSON.stringify(v, null, 2).slice(0, 700))

try {
  console.log('\n=== 1. 个股实时行情 (贵州茅台) ===')
  const q = await m.getQuote('600519')
  console.log(`  ${q.name} ${q.symbol}  现价 ${q.price}  涨跌 ${q.changePct}%  成交额 ${(q.amount / 1e8).toFixed(2)}亿  来源 ${q.source} @${q.timestamp}`)
  console.log(`  flags=${JSON.stringify(q.flags)} status=${q.status}`)
  // 字段正确性断言（防止腾讯字段下标再次错位）
  const assertLive = (cond, msg) => { if (!cond) { console.error('  ✗ 字段校验失败: ' + msg); process.exitCode = 1 } else console.log('  ✓ ' + msg) }
  assertLive(q.turnover !== null && q.turnover > 0 && q.turnover < 100, `换手率合理: ${q.turnover}%`)
  assertLive(q.amount !== null && q.amount > 1e9 && q.amount < 1e12, `成交额合理: ${(q.amount / 1e8).toFixed(2)}亿`)
  assertLive(q.pe !== null && q.pe > 0 && q.pe < 1000, `PE 合理: ${q.pe}`)
  assertLive(q.pb !== null && q.pb > 0 && q.pb < 100, `PB 合理: ${q.pb}`)
  assertLive(q.limitUp !== null && q.limitUp > q.price, `涨停价高于现价: ${q.limitUp}`)
  assertLive(q.totalMarketCap > 1e11, `总市值合理: ${(q.totalMarketCap / 1e8).toFixed(0)}亿`)

  console.log('\n=== 2. 指数行情 (沪深300) ===')
  const idx = await m.getQuote('IDX000300')
  console.log(`  ${idx.name} ${idx.symbol}  ${idx.price}  ${idx.changePct}%`)

  console.log('\n=== 3. 日K线 (茅台, qfq, 20根) ===')
  const bars = await m.getKline('600519', { timeframe: '1d', adjust: 'qfq', count: 20 })
  console.log(`  取到 ${bars.length} 根: ${bars[0].time} → ${bars.at(-1).time}`)
  console.log(`  最后一根 O=${bars.at(-1).open} H=${bars.at(-1).high} L=${bars.at(-1).low} C=${bars.at(-1).close} V=${bars.at(-1).volume}`)

  console.log('\n=== 4. 分时 ===')
  const min = await m.getMinute('600519')
  console.log(`  昨收=${min.prevClose}  点数=${min.points.length}  首点=${JSON.stringify(min.points[0])}`)

  console.log('\n=== 5. 搜索 ===')
  const s = await m.search('茅台')
  console.log(`  命中 ${s.results.length} 条: ${s.results.slice(0, 3).map((r) => `${r.symbol} ${r.name}`).join(' | ')}`)

  console.log('\n=== 6. 大盘概览 ===')
  const ov = await m.getMarketOverview()
  for (const i of ov.indices) console.log(`  ${i.name.padEnd(8)} ${String(i.price).padStart(10)}  ${i.changePct}%`)

  console.log('\n=== 7. 缓存生效验证 ===')
  const t0 = Date.now()
  await m.getQuote('600519')
  console.log(`  二次取行情耗时 ${Date.now() - t0}ms（应远小于首次，命中 3s TTL）`)

  console.log('\n✅ 全部冒烟通过')
} catch (e) {
  console.error('\n❌ 冒烟失败:', e.message)
  console.error(e.stack)
  process.exitCode = 1
}
