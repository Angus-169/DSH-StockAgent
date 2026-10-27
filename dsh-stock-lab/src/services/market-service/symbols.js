/**
 * symbols.js — A股代码规范化
 *
 * 统一内部格式：
 *   股票  SH600519 / SZ300750 / BJ430047
 *   指数  IDX000001（上证）IDX399001（深证）IDX399006（创业板）IDX000300（沪深300）
 *
 * 接受输入：600519 / 600519.SH / sh600519 / SH600519 / 00700(HK 暂不在此层处理)
 * 同时产出腾讯行情代码（sh600519）与东财 secid（1.600519 / 0.300750）。
 */

export const MARKET = { SH: 'SH', SZ: 'SZ', BJ: 'BJ' }

/** 6 位代码 → 交易所（按号段规则，覆盖主板/创业板/科创板/北交所） */
export function marketOf(code6) {
  if (!/^\d{6}$/.test(code6)) return null
  const n = code6.slice(0, 3)
  // 北交所：43/83/87/92 开头
  if (/^(43|83|87|92)/.test(code6)) return MARKET.BJ
  // 上海：600/601/603/605 主板，688 科创，900 B股
  if (/^(600|601|603|605|688|689|900)/.test(code6)) return MARKET.SH
  // 深圳：000/001/002/003 主板，300/301 创业板，200 B股
  if (/^(000|001|002|003|300|301|302|200|201)/.test(code6)) return MARKET.SZ
  // 指数/其他交由调用方判断
  if (/^(510|511|512|513|515|518|560|588)/.test(code6)) return MARKET.SH // ETF
  if (/^(159|160)/.test(code6)) return MARKET.SZ // ETF
  return null
}

/** 知名指数映射（腾讯代码） */
export const INDEX_MAP = {
  IDX000001: { tencent: 'sh000001', name: '上证指数' },
  IDX399001: { tencent: 'sz399001', name: '深证成指' },
  IDX399006: { tencent: 'sz399006', name: '创业板指' },
  IDX000300: { tencent: 'sh000300', name: '沪深300' },
  IDX000905: { tencent: 'sh000905', name: '中证500' },
  IDX000852: { tencent: 'sh000852', name: '中证1000' },
}

/**
 * 规范化任意输入为内部 symbol。
 * @returns {{symbol:string, market:string|null, code:string, kind:'stock'|'index'|'etf'|'unknown', tencent:string, secid:string|null}}
 */
export function normalize(input) {
  if (typeof input !== 'string') throw new Error('symbol 必须是字符串')
  let s = input.trim()
  if (s === '') throw new Error('空 symbol')

  // 指数：IDX 前缀或已知指数代码
  if (/^IDX\d{6}$/i.test(s)) {
    const key = s.toUpperCase()
    const idx = INDEX_MAP[key]
    return { symbol: key, market: null, code: key.slice(3), kind: 'index', tencent: idx ? idx.tencent : null, secid: null, name: idx ? idx.name : undefined }
  }

  // 去掉交易所后缀/前缀
  let m = s.match(/^(\d{6})\.(SH|SZ|BJ|SS)$/i)
  if (m) s = m[2].toUpperCase().replace('SS', 'SH') + m[1]
  m = s.match(/^(sh|sz|bj)(\d{6})$/i)
  if (m) s = m[1].toUpperCase() + m[2]
  m = s.match(/^\d{6}$/)
  if (m) {
    const market = marketOf(s)
    if (market === null) {
      // 可能是指数代码（000001 上证、399001 深证等）
      const idxKey = 'IDX' + s
      if (INDEX_MAP[idxKey]) return normalize(idxKey)
      throw new Error('无法识别代码所属市场：' + s)
    }
    s = market + s
  }
  m = s.match(/^(SH|SZ|BJ)(\d{6})$/i)
  if (!m) throw new Error('无法解析的 symbol：' + input)
  const market = m[1].toUpperCase()
  const code = m[2]
  const symbol = market + code
  const tencent = market.toLowerCase() + code
  const secid = (market === 'SH' ? '1.' : market === 'SZ' ? '0.' : '0.') + code
  // ETF 号段
  const kind = /^(510|511|512|513|515|518|560|588|159|160)/.test(code) ? 'etf' : 'stock'
  return { symbol, market, code, kind, tencent, secid }
}

/** symbol → 腾讯行情代码（sh600519） */
export function toTencent(input) { return normalize(input).tencent }

/** 是否 ST / 名称标志从行情名称字段解析 */
export function parseFlags(name) {
  const flags = {}
  if (typeof name === 'string') {
    if (/ST/i.test(name)) flags.st = true
    if (/^N/.test(name)) flags.new = true // 新股首日 N 前缀
    if (/^C/.test(name)) flags.new = true // 次新 C 前缀
  }
  return flags
}
