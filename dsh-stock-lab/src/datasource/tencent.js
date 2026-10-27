/**
 * tencent.js — 腾讯财经数据源适配器（仅被 market-service 引用）
 *
 * 端点：
 *   行情  https://qt.gtimg.cn/q=sh600519        （GBK 编码）
 *   K线   https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={code},{period},,{end},{count},{adjust}
 *   分时  https://web.ifzq.gtimg.cn/appstock/app/minute/query?code={code}
 *   搜索  https://proxy.finance.qq.com/ifzqgtimg/appstock/smartbox/search/get?q={q}
 *
 * 输出一律转成统一 schema（Quote/Bar），不暴露腾讯字段名。
 */

import { normalize, parseFlags, INDEX_MAP } from '../services/market-service/symbols.js'

const QUOTE_API = 'https://qt.gtimg.cn/q='
const KLINE_API = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get'
const MINUTE_API = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query'
const SEARCH_API = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/smartbox/search/get'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

async function fetchText(url, { timeoutMs = 10000, charset } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, referer: 'https://gu.qq.com/' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error('tencent HTTP ' + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  // qt.gtimg.cn 是 GBK；fqkline 是 UTF-8。按响应头 charset 解码，默认 utf8。
  const header = res.headers.get('content-type') || ''
  const enc = charset || (/gbk|gb2312/i.test(header) ? 'gbk' : 'utf8')
  if (enc === 'gbk') {
    // Node 22 自带 TextDecoder 支持 gbk
    return new TextDecoder('gbk').decode(buf)
  }
  return new TextDecoder('utf8').decode(buf)
}

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * 实时行情。输入内部 symbol 或指数。
 *
 * ⚠️ 腾讯 qt.gtimg.cn 字段布局（实测 sh600519，共 50+ 段）：
 *    0 市场标记  1 名称  2 代码  3 现价  4 昨收  5 今开
 *    6 成交量(手)  9~28 五档盘口  30 时间戳 31 涨跌额 32 涨跌幅(%)
 *    33 最高 34 最低 35 "价/量/额"  36 成交量(手) 37 成交额(万元)
 *    38 换手率(%) 39 PE(TTM) 41 最高 42 最低 43 振幅(%)
 *    44 流通市值(亿) 45 总市值(亿) 46 PB 47 涨停 48 跌停
 *
 * ⚠️ 指数与个股部分下标不同（实测 sh000001）：
 *    指数成交额也在 f37，但涨跌幅在 f38、无换手率；个股涨跌幅在 f32。
 *    因此按 kind 分支取值。
 *
 * @returns {Quote}
 */
export async function getQuote(input) {
  const info = normalize(input)
  const isIndex = info.kind === 'index'
  const code = isIndex ? (INDEX_MAP[info.symbol]?.tencent ?? info.tencent) : info.tencent
  if (!code) throw new Error('无腾讯代码：' + input)
  const text = await fetchText(QUOTE_API + code)
  const m = text.match(/="([^"]*)"/)
  if (!m) throw new Error('腾讯行情返回异常')
  const f = m[1].split('~')
  const name = f[1] || ''
  const price = num(f[3])
  const prevClose = num(f[4])
  const open = num(f[5])
  const volumeHand = num(f[6])
  const high = num(f[33])
  const low = num(f[34])
  // 个股：f31 涨跌额 / f32 涨跌幅 / f38 换手率 / f39 PE / f46 PB
  // 指数：f38 涨跌幅，无换手率
  const changeAmt = num(f[31])
  const changePct = isIndex ? num(f[38]) : num(f[32])
  const amountWan = num(f[37])      // 成交额（万元），个股与指数同位置
  const turnover = isIndex ? null : num(f[38])  // 换手率 %
  const pe = num(f[39])
  const pb = isIndex ? null : num(f[46])
  const amplitude = num(f[43])
  const floatCapYi = num(f[44])     // 流通市值（亿）
  const totalCapYi = num(f[45])     // 总市值（亿）
  // 指数没有涨跌停概念，腾讯返回 -1，需归一为 null（不把 -1 当真实价格传给上层）
  const limitUp = isIndex ? null : num(f[47])
  const limitDown = isIndex ? null : num(f[48])
  const cleanLimit = (v) => (v === null || v <= 0 ? null : v)
  const timeRaw = f[30] || ''
  const timestamp = timeRaw.length === 14
    ? `${timeRaw.slice(0, 4)}-${timeRaw.slice(4, 6)}-${timeRaw.slice(6, 8)}T${timeRaw.slice(8, 10)}:${timeRaw.slice(10, 12)}:${timeRaw.slice(12, 14)}+08:00`
    : new Date().toISOString()
  const suspended = !isIndex && (price === null || price === 0)
  return {
    symbol: info.symbol,
    name,
    market: info.market,
    kind: info.kind,
    price: suspended ? prevClose : price,
    change: changeAmt !== null ? changeAmt : (price !== null && prevClose !== null ? Math.round((price - prevClose) * 1000) / 1000 : null),
    changePct: suspended ? null : changePct,
    open, high, low, prevClose,
    amplitude,
    volume: volumeHand !== null ? volumeHand * 100 : null, // 手→股
    turnover,
    amount: amountWan !== null ? amountWan * 10000 : null, // 万元→元
    pe,
    pb,
    totalMarketCap: totalCapYi !== null ? totalCapYi * 1e8 : null,
    floatMarketCap: floatCapYi !== null ? floatCapYi * 1e8 : null,
    limitUp: cleanLimit(limitUp),
    limitDown: cleanLimit(limitDown),
    timestamp,
    status: suspended ? 'suspended' : 'trading',
    flags: parseFlags(name),
    source: 'tencent',
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * K线。
 * @param input 内部 symbol
 * @param opts { timeframe:'1d'|'1w'|'1M', adjust:'none'|'qfq'|'hfq', count:number, end:'YYYY-MM-DD' }
 */
export async function getKline(input, opts = {}) {
  const info = normalize(input)
  const code = info.kind === 'index' ? (INDEX_MAP[info.symbol]?.tencent ?? info.tencent) : info.tencent
  const period = { '1d': 'day', '1w': 'week', '1M': 'month' }[opts.timeframe || '1d']
  if (!period) throw new Error('tencent 不支持 timeframe：' + opts.timeframe)
  const adjust = opts.adjust === 'none' ? '' : (opts.adjust || 'qfq')
  const count = Math.min(Math.max(opts.count || 320, 1), 800)
  const end = (opts.end || '').replace(/-/g, '')
  const url = `${KLINE_API}?param=${code},${period},,${end},${count},${adjust}`
  const text = await fetchText(url)
  const json = JSON.parse(text)
  const data = json?.data?.[code]
  const key = adjust === '' ? period : (adjust + period)
  const rows = data?.[key] || data?.[period] || []
  return rows.map((r) => ({
    time: r[0],
    open: num(r[1]), close: num(r[2]), high: num(r[3]), low: num(r[4]),
    volume: num(r[5]) !== null ? num(r[5]) * 100 : null, // 手→股
    amount: null, // 腾讯该端点不给成交额
    adjust: opts.adjust || 'qfq',
    source: 'tencent',
  }))
}

/** 分时（仅当日） */
export async function getMinute(input) {
  const info = normalize(input)
  const code = info.kind === 'index' ? (INDEX_MAP[info.symbol]?.tencent ?? info.tencent) : info.tencent
  const text = await fetchText(`${MINUTE_API}?code=${code}&r=${Math.random()}`)
  const json = JSON.parse(text)
  const node = json?.data?.[code]
  // 上游点数形如 "0930 1311.84 1049 137612016.00"（时间 价格 累计量 累计额），是字符串数组
  const raw = node?.data?.data || []
  const points = raw.map((line) => {
    if (typeof line !== 'string') {
      // 容错：万一上游改成对象/数组形式
      if (Array.isArray(line)) return { time: String(line[0] ?? ''), price: num(line[1]), volume: num(line[2]) }
      return { time: String(line.time ?? ''), price: num(line.price), volume: num(line.volume) }
    }
    const p = line.trim().split(/\s+/)
    const hhmm = p[0] || ''
    return {
      time: hhmm.length === 4 ? `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}` : hhmm,
      price: num(p[1]),
      volume: num(p[2]),   // 累计成交量（手）
      amount: num(p[3]),   // 累计成交额（元）
    }
  }).filter((x) => x.price !== null)
  // 昨收取自 qt 数组第 4 位，缺省回退到首点前一根
  const prevClose = num(node?.qt?.[code]?.[4]) ?? num(node?.data?.preciousPrice) ?? (points[0]?.price ?? null)
  return { symbol: info.symbol, prevClose, points, source: 'tencent' }
}

/**
 * 全市场搜索（smartbox：A/北/港/美/指数/ETF）。
 * 上游 stock 字段是**数组的数组**：["sh","600519","贵州茅台","","GP-A"]
 * @returns {Array<{symbol,name,kind,market}>}
 */
export async function search(query) {
  const q = String(query || '').trim()
  if (q === '') return { results: [] }
  const text = await fetchText(`${SEARCH_API}?q=${encodeURIComponent(q)}`)
  const json = JSON.parse(text)
  const raw = json?.data?.stock
  const list = Array.isArray(raw) ? raw : (raw?.smartboxList || raw?.v2 || [])
  const results = []
  for (const it of list) {
    let prefix, code, name, type
    if (Array.isArray(it)) {
      // ["sh","600519","贵州茅台","","GP-A"]
      prefix = String(it[0] || '').toLowerCase()
      code = String(it[1] || '')
      name = String(it[2] || '')
      type = String(it[4] || '')
    } else {
      prefix = String(it.m === '1' ? 'sh' : it.m === '0' ? 'sz' : (it.prefix || '')).toLowerCase()
      code = String(it.c || it.code || '')
      name = String(it.n || it.name || '')
      type = String(it.t || '')
    }
    if (!code || !name) continue
    // 只保留 A 股/北交所/指数/ETF（排除港股 hk / 美股 us）
    if (prefix === 'hk' || prefix === 'us') continue
    let symbol = null
    let kind = 'stock'
    try {
      if (/^(sh|sz|bj)$/.test(prefix)) {
        const info = normalize(prefix.toUpperCase() + code.slice(0, 6))
        symbol = info.symbol
        kind = /指数|IDX/i.test(type) ? 'index' : info.kind
      } else if (/^\d{6}$/.test(code)) {
        const info = normalize(code)
        symbol = info.symbol
        kind = info.kind
      }
    } catch { continue }
    if (!symbol) continue
    results.push({ symbol, name, kind, market: symbol.slice(0, 2) })
  }
  // 同名去重（上游会把同一标的在多个分组重复返回）
  const seen = new Set()
  const unique = results.filter((r) => (seen.has(r.symbol) ? false : (seen.add(r.symbol), true)))
  return { results: unique.slice(0, 20), source: 'tencent' }
}
