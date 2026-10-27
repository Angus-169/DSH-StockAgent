/**
 * eastmoney.js — 东方财富数据源适配器（仅被 market-service 引用）
 *
 * 端点：
 *   涨跌家数  https://push2.eastmoney.com/api/qt/ulist.np/get  fields=f104,f105,f106  secids=1.000001
 *   排行/资金 https://push2.eastmoney.com/api/qt/clist/get
 *   个股详情  https://push2.eastmoney.com/api/qt/stock/get
 *   财务      https://datacenter-web.eastmoney.com/api/data/v1/get
 *   建议搜索  https://searchapi.eastmoney.com/api/suggest/get
 *   新闻搜索  https://search-api-web.eastmoney.com/search/jsonp
 *
 * 输出统一 schema，不暴露东财字段名（f43/f57 这类编号只在本文档内出现）。
 */

import { normalize } from '../services/market-service/symbols.js'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const UA_HEADERS = { 'user-agent': UA, referer: 'https://quote.eastmoney.com/' }

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function getJson(url, { timeoutMs = 10000, headers } = {}) {
  const res = await fetch(url, { headers: headers || UA_HEADERS, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error('eastmoney HTTP ' + res.status)
  const text = await res.text()
  try { return JSON.parse(text) } catch { throw new Error('eastmoney 返回非 JSON') }
}

/**
 * 市场宽度（涨跌家数）。
 * ulist.np/get 的 f104/f105/f106 对 secids=1.000001 返回全市场统计。
 * @returns {{up:number,down:number,flat:number,total:number}}
 */
export async function getMarketBreadth() {
  const url = 'https://push2.eastmoney.com/api/qt/ulist.np/get?fields=f104,f105,f106&secids=1.000001'
  const json = await getJson(url)
  const row = json?.data?.diff?.[0] || {}
  const up = num(row.f104) ?? 0
  const down = num(row.f105) ?? 0
  const flat = num(row.f106) ?? 0
  return { up, down, flat, total: up + down + flat, source: 'eastmoney' }
}

/**
 * 全 A 股总数（用于校验宽度数据 / 市场概览）。
 */
export async function getUniverseSize() {
  const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=1&po=1&np=1&fltt=2&invt=2&fid=f3'
    + '&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048&fields=f12'
  const json = await getJson(url)
  return num(json?.data?.total) ?? null
}

/**
 * 个股资金流（近 N 日主力净流入，单位元）。
 * 用 fflow/kline 专用接口：每行 "日期,主力净流入,小单,中单,大单,超大单"
 * 注意 push2 stock/get 的 f62 只给瞬时近似值（常为 0），不可用。
 */
export async function getMoneyFlow(input, opts = {}) {
  const info = normalize(input)
  const days = Math.min(Math.max(opts.days || 5, 1), 60)
  const url = 'https://push2.eastmoney.com/api/qt/stock/fflow/kline/get'
    + `?secid=${info.secid}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56&klt=101&lmt=${days}`
  const json = await getJson(url, { headers: { ...UA_HEADERS, referer: 'https://data.eastmoney.com/' } })
  const rows = json?.data?.klines || []
  const series = rows.map((line) => {
    const p = String(line).split(',')
    return {
      date: p[0],
      mainNetInflow: num(p[1]),     // 主力净流入（元）
      smallNet: num(p[2]),          // 小单
      mediumNet: num(p[3]),         // 中单
      largeNet: num(p[4]),          // 大单
      superLargeNet: num(p[5]),     // 超大单
    }
  })
  const latest = series.at(-1) || {}
  const sum5 = series.slice(-5).reduce((a, r) => a + (r.mainNetInflow || 0), 0)
  return {
    symbol: info.symbol,
    name: json?.data?.name || null,
    today: latest,
    series,
    mainNetInflow5d: series.length ? Math.round(sum5) : null,
    timestamp: new Date().toISOString(),
    source: 'eastmoney',
  }
}

/**
 * 财务指标（东财 datacenter，最近 12 期主要指标）。
 * 注意：字段名是 REPORTDATE（无下划线），与部分文档里的 REPORT_DATE 不同。
 */
export async function getFinancials(input) {
  const info = normalize(input)
  const secucode = `${info.code}.${info.market}`
  const url = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
    + '?reportName=RPT_LICO_FN_CPD'
    + '&columns=ALL'
    + `&filter=(SECUCODE%3D%22${encodeURIComponent(secucode)}%22)`
    + '&pageSize=12&sortColumns=REPORTDATE&sortTypes=-1&source=WEB&client=WEB'
  const json = await getJson(url, { headers: { ...UA_HEADERS, referer: 'https://data.eastmoney.com/' } })
  const rows = json?.result?.data || []
  if (rows.length === 0) {
    return { symbol: info.symbol, reports: [], note: '暂无财务数据（可能是新股或数据源未覆盖）', source: 'eastmoney' }
  }
  const reports = rows.map((r) => ({
    reportDate: (r.REPORTDATE || '').slice(0, 10),
    revenue: num(r.TOTAL_OPERATE_INCOME),
    revenueYoY: num(r.YSTZ),
    netProfit: num(r.PARENT_NETPROFIT),
    netProfitYoY: num(r.SJLTZ),
    roe: num(r.WEIGHTAVG_ROE),
    grossMargin: num(r.XSMLL),
    netMargin: num(r.XSJLL),
    debtRatio: num(r.ZCFZL),
    eps: num(r.BASIC_EPS),
    bps: num(r.BPS),
  }))
  return { symbol: info.symbol, name: rows[0].SECURITY_NAME_ABBR || null, industry: rows[0].PUBLISHNAME || null, reports, source: 'eastmoney' }
}

/**
 * 公司概况（名称/行业/上市日期/市值/估值）。
 * 注意：push2 stock/get 的价格与估值字段是**放大 100 倍**的整数：
 *   f43 现价 133500 → 1335.00，f162 PE 1874 → 18.74，f167 PB 664 → 6.64
 */
export async function getCompanyProfile(input) {
  const info = normalize(input)
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${info.secid}`
    + '&fields=f57,f58,f84,f85,f116,f117,f127,f189,f162,f167'
  const json = await getJson(url)
  const d = json?.data || {}
  const div100 = (v) => { const n = num(v); return n === null ? null : Math.round(n) / 100 }
  return {
    symbol: info.symbol,
    code: d.f57 || info.code,
    name: d.f58 || null,
    industry: d.f127 || null,             // 行业
    totalShares: num(d.f84) ?? null,      // 总股本
    floatShares: num(d.f85) ?? null,      // 流通股
    totalMarketCap: num(d.f116) ?? null,  // 总市值（元）
    floatMarketCap: num(d.f117) ?? null,  // 流通市值（元）
    listDate: d.f189 ? String(d.f189) : null,
    pe: div100(d.f162),
    pb: div100(d.f167),
    source: 'eastmoney',
  }
}

/**
 * 行业/概念板块列表（东财 clist）。
 * fs: m:90+t:2 = 行业板块；m:90+t:3 = 概念板块；m:90+t:1 = 地域板块
 * @returns {Array<{id,name,changePct,mainNetInflow}>}
 */
export async function getSectorList(opts = {}) {
  const type = opts.type === 'concept' ? '3' : opts.type === 'region' ? '1' : '2'
  const limit = Math.min(Math.max(opts.limit || 50, 1), 200)
  const sort = opts.sort || 'changePct'
  const fid = sort === 'moneyFlow' ? 'f62' : sort === 'name' ? 'f14' : 'f3'
  const po = sort === 'name' ? 0 : 1
  const url = 'https://push2.eastmoney.com/api/qt/clist/get'
    + `?pn=1&pz=${limit}&po=${po}&np=1&fltt=2&invt=2&fid=${fid}&fs=m:90+t:${type}`
    + '&fields=f12,f14,f3,f62,f104,f105,f128,f136'
  const json = await getJson(url)
  const rows = json?.data?.diff || []
  return rows.map((r) => ({
    id: r.f12 || null,
    name: r.f14 || null,
    changePct: num(r.f3),
    mainNetInflow: num(r.f62),
    upCount: num(r.f104),
    downCount: num(r.f105),
    leaderName: r.f128 || null,
    leaderChangePct: num(r.f136),
    source: 'eastmoney',
  }))
}

/**
 * 某板块的行情（按板块代码 BKxxxx）。
 * ⚠️ 东财对**板块指数**的 f104/f105/f106 返回 0/0/100（那是板块指数本身的涨跌平状态，
 * 不是成分股家数），所以这里不采信，成分股家数由 getSectorMembers 自行统计。
 */
export async function getSectorQuote(sectorId) {
  const id = String(sectorId || '').toUpperCase()
  if (!/^BK\d{4}$/.test(id)) throw new Error('板块代码格式应为 BKxxxx，收到：' + sectorId)
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=90.${id}`
    + '&fields=f57,f58,f43,f169,f170,f46,f60,f44,f45,f47,f48'
  const json = await getJson(url)
  const d = json?.data
  if (!d) throw new Error('板块不存在：' + id)
  const div100 = (v) => { const n = num(v); return n === null ? null : Math.round(n) / 100 }
  return {
    id,
    name: d.f58 || null,
    price: div100(d.f43),
    change: div100(d.f169),
    changePct: div100(d.f170),
    open: div100(d.f46),
    prevClose: div100(d.f60),
    high: div100(d.f44),
    low: div100(d.f45),
    volume: num(d.f47),
    amount: num(d.f48),
    source: 'eastmoney',
  }
}

/**
 * 某板块的成分股（按涨跌幅排序）。
 */
export async function getSectorMembers(sectorId, opts = {}) {
  const id = String(sectorId || '').toUpperCase()
  if (!/^BK\d{4}$/.test(id)) throw new Error('板块代码格式应为 BKxxxx，收到：' + sectorId)
  const limit = Math.min(Math.max(opts.limit || 30, 1), 200)
  const url = 'https://push2.eastmoney.com/api/qt/clist/get'
    + `?pn=1&pz=${limit}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:${id}`
    + '&fields=f12,f13,f14,f2,f3,f62'
  const json = await getJson(url)
  const rows = json?.data?.diff || []
  return rows.map((r) => ({
    code: r.f12,
    name: r.f14,
    market: r.f13 === 1 ? 'SH' : r.f13 === 0 ? 'SZ' : null,
    price: num(r.f2),
    changePct: num(r.f3),
    mainNetInflow: num(r.f62),
    source: 'eastmoney',
  }))
}

/**
 * 个股所属行业板块代码（用于"个股 vs 行业"对比）。
 * 东财 f127 给行业名称（如"白酒Ⅱ"），需先在板块列表里按名称反查 BK 代码。
 */
export async function getStockSector(input) {
  const info = normalize(input)
  const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${info.secid}&fields=f57,f58,f127,f128`
  const json = await getJson(url)
  const d = json?.data || {}
  const industryName = d.f127 || null
  const regionName = d.f128 || null
  let sector = null
  if (industryName) {
    try {
      const all = await getSectorList({ type: 'industry', limit: 200 })
      const hit = all.find((s) => s.name === industryName)
      if (hit) sector = { id: hit.id, name: hit.name, changePct: hit.changePct, mainNetInflow: hit.mainNetInflow }
    } catch { /* 反查失败不影响主流程 */ }
  }
  return {
    symbol: info.symbol,
    name: d.f58 || null,
    industry: industryName,
    region: regionName,
    sector,
    source: 'eastmoney',
  }
}

/**
 * 新闻检索（东财站内搜索：媒体新闻 + 公告）。
 * @returns {Array<{time,title,url,source}>}
 */
export async function getNews(input, opts = {}) {
  const info = typeof input === 'string' && /^\d{6}$/.test(input.replace(/[A-Z]/gi, ''))
    ? normalize(input)
    : normalize(input)
  const limit = Math.min(Math.max(opts.limit || 10, 1), 50)
  const query = opts.query || info.code
  const param = JSON.stringify({
    uid: '',
    keyword: query,
    type: ['cmsArticleWebOld'],
    client: 'web',
    clientType: 'web',
    clientVersion: 'curr',
    param: { cmsArticleWebOld: { searchScope: 'default', sort: 'default', pageIndex: 1, pageSize: limit } },
  })
  const url = `https://search-api-web.eastmoney.com/search/jsonp?cb=cb&param=${encodeURIComponent(param)}`
  const res = await fetch(url, { headers: UA_HEADERS, signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error('eastmoney news HTTP ' + res.status)
  const text = await res.text()
  const m = text.match(/^cb\((.*)\)$/s)
  const json = m ? JSON.parse(m[1]) : JSON.parse(text)
  const items = json?.result?.cmsArticleWebOld || json?.result?.cmsArticleWeb || []
  return items.map((it) => ({
    time: it.date || it.showTime || null,
    title: (it.title || '').replace(/<[^>]+>/g, ''),
    summary: (it.content || '').replace(/<[^>]+>/g, '').slice(0, 200) || null,
    url: it.url || it.articleUrl || null,
    media: it.mediaName || null,
    source: 'eastmoney',
  }))
}
