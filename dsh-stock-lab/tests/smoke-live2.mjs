/**
 * smoke-live2.mjs — 东财数据源联调冒烟
 */
import { MarketService } from '../src/services/market-service/index.js'

const m = new MarketService({ log: (s) => console.log('   [log] ' + s) })

try {
  console.log('\n=== 1. 涨跌家数 ===')
  const b = await m.getMarketBreadth()
  console.log(`  上涨 ${b.up}  下跌 ${b.down}  平盘 ${b.flat}  合计 ${b.total}`)

  console.log('\n=== 2. 大盘概览（含情绪合成）===')
  const ov = await m.getMarketOverview()
  for (const i of ov.indices) console.log(`  ${i.name.padEnd(8)} ${String(i.price).padStart(9)}  ${String(i.changePct).padStart(6)}%  额 ${(i.amount / 1e8).toFixed(0)}亿`)
  console.log(`  两市成交额 ${(ov.totalAmount / 1e8).toFixed(0)} 亿`)
  console.log(`  市场情绪 ${JSON.stringify(ov.sentiment)}`)

  console.log('\n=== 3. 资金流 ===')
  const mf = await m.getMoneyFlow('600519')
  console.log(`  ${mf.name}  今日主力净流入 ${(mf.today.mainNetInflow / 1e8).toFixed(2)}亿  近5日 ${(mf.mainNetInflow5d / 1e8).toFixed(2)}亿`)
  console.log(`  今日: 超大单 ${(mf.today.superLargeNet / 1e8).toFixed(2)}亿  大单 ${(mf.today.largeNet / 1e8).toFixed(2)}亿  中单 ${(mf.today.mediumNet / 1e8).toFixed(2)}亿  小单 ${(mf.today.smallNet / 1e8).toFixed(2)}亿`)
  console.log(`  序列 ${mf.series.length} 日: ${mf.series.map((s) => s.date).join(' ')}`)

  console.log('\n=== 4. 财务 ===')
  const fin = await m.getFinancials('600519')
  if (fin.reports.length) {
    const r = fin.reports[0]
    console.log(`  最新报告期 ${r.reportDate}: 营收 ${(r.revenue / 1e8).toFixed(1)}亿 (同比 ${r.revenueYoY}%)  净利 ${(r.netProfit / 1e8).toFixed(1)}亿  ROE ${r.roe}%  毛利率 ${r.grossMargin}%  EPS ${r.eps}`)
    console.log(`  共 ${fin.reports.length} 期`)
  } else console.log('  ' + fin.note)

  console.log('\n=== 5. 公司概况 ===')
  const p = await m.getCompanyProfile('600519')
  console.log(`  ${p.name}  行业 ${p.industry}  总市值 ${(p.totalMarketCap / 1e8).toFixed(0)}亿  PE ${p.pe}  PB ${p.pb}`)

  console.log('\n=== 6. 新闻 ===')
  const news = await m.getNews('600519', { limit: 5 })
  console.log(`  取到 ${news.length} 条`)
  for (const n of news.slice(0, 3)) console.log(`  · ${n.time || ''} ${n.title.slice(0, 40)}`)

  console.log('\n✅ 东财链路全部通过')
} catch (e) {
  console.error('\n❌ 失败:', e.message)
  console.error(e.stack)
  process.exitCode = 1
}
