/**
 * sina.js — 新浪日线备源（仅被 market-service 引用，腾讯 K 线失败时兜底）
 * 端点：https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=sh600519&scale=240&ma=no&datalen=320
 */

import { normalize, INDEX_MAP } from '../services/market-service/symbols.js'

const KLINE_API = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * @param opts { timeframe:'1d', count:number }  新浪该端点仅支持日线（scale=240）
 */
export async function getKline(input, opts = {}) {
  if ((opts.timeframe || '1d') !== '1d') throw new Error('sina 备源仅支持日线')
  const info = normalize(input)
  const code = info.kind === 'index' ? (INDEX_MAP[info.symbol]?.tencent ?? info.tencent) : info.tencent
  const count = Math.min(Math.max(opts.count || 320, 1), 1023)
  const url = `${KLINE_API}?symbol=${code}&scale=240&ma=no&datalen=${count}`
  const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error('sina HTTP ' + res.status)
  const text = await res.text()
  let rows
  try { rows = JSON.parse(text) } catch { throw new Error('sina 返回非 JSON') }
  if (!Array.isArray(rows)) throw new Error('sina 返回结构异常')
  return rows.map((r) => ({
    time: r.day,
    open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.close),
    volume: num(r.volume), // 新浪此端点单位为股
    amount: null,
    adjust: 'none', // 新浪备源为不复权
    source: 'sina',
  }))
}
