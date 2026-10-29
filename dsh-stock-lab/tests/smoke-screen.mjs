/**
 * smoke-screen.mjs — 公式选股真实链路冒烟（需网络）
 *
 * 与自动测试分开：这里打**真实东财**取全市场标的池，并在**真实本地库**上跑一次选股。
 * 检查的是"链路通不通、数字合不合理"，不是统计正确性（那由 screen-service.test.mjs 覆盖）。
 *
 * 运行：node tests/smoke-screen.mjs
 */
import { MarketService } from '../src/services/market-service/index.js'
import { ScreenService } from '../src/services/screen-service/index.js'

let passed = 0
let failed = 0
function check(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name + (detail ? ' — ' + detail : '')) }
  else { failed++; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')) }
}

const market = new MarketService()
const screen = new ScreenService({ market })

console.log('全市场标的池（东财 clist，真实网络）')
const t0 = Date.now()
let uni
try {
  uni = await market.getStockUniverse()
} catch (e) {
  console.error('  ✗ 标的池抓取失败：' + e.message)
  process.exit(1)
}
const poolMs = Date.now() - t0
check('total > 4000', uni.total > 4000, `total=${uni.total}`)
check('fetched 覆盖 ≥ 95%', uni.fetched >= uni.total * 0.95, `fetched=${uni.fetched}/${uni.total}`)
check('耗时 < 60s', poolMs < 60000, `${poolMs} ms`)
check('标的形如 SH600519', uni.symbols.every((s) => /^(SH|SZ)\d{6}$/.test(s.symbol)), '样例 ' + uni.symbols[0]?.symbol)

console.log('\n真实本地库上的选股（CLOSE>MA20）')
const started = await screen.start({ text: 'XG:CLOSE>MA(CLOSE,20);', universe: 'market' })
const done = await screen.waitFor(started.id, 60000)
check('任务完成', done.state === 'done', `state=${done.state} error=${done.error || ''}`)
check('评估了本地有数据的标的', done.universe.evaluated > 0, `evaluated=${done.universe.evaluated}/${done.universe.total}`)
check('缺数据被如实计数', done.universe.missingData === done.universe.total - done.universe.evaluated,
  `missing=${done.universe.missingData}`)
check('结果字段完整', done.results.every((r) => r.symbol && typeof r.hitCount === 'number' && r.lastHitDate),
  `hits=${done.results.length}`)
if (done.results.length) {
  const r = done.results[0]
  console.log(`    首个命中：${r.symbol} ${r.name || ''} 命中 ${r.hitCount} 次，最近 ${r.lastHitDate}，收盘 ${r.close}`)
}
check('耗时 < 60s', done.elapsedMs < 60000, `${done.elapsedMs} ms`)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
