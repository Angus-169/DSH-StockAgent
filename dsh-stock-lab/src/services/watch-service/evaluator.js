/**
 * evaluator.js — Watch Engine 条件求值器
 *
 * 每个条件类型实现一个纯函数：把「当前市场数据 + 规则参数」映射成
 *   { fired: boolean, severity, title, detail, metrics }
 *
 * 设计原则：
 *   - 判定全部由代码完成，LLM 不参与（原则 3）
 *   - 每个条件都返回判断所依据的具体数值（metrics），便于用户复核
 *   - 无法判定时不假装触发（返回 fired:false 并给出 skip 原因）
 */

// ── 小型统计工具（与 tools/index.js 保持一致的口径） ──

export function realizedVol(bars, n = 20) {
  if (!Array.isArray(bars) || bars.length < n + 1) return null
  const slice = bars.slice(-(n + 1))
  const rets = []
  for (let i = 1; i < slice.length; i++) {
    const a = slice[i - 1].close, b = slice[i].close
    if (a && b) rets.push((b - a) / a)
  }
  if (rets.length < 2) return null
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length
  const varr = rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (rets.length - 1)
  return Math.sqrt(varr) * Math.sqrt(252)
}

export function volumeRatio(bars, n = 20) {
  if (!Array.isArray(bars) || bars.length < n + 2) return null
  const vols = bars.slice(-(n + 1), -1).map((b) => b.volume).filter((v) => v !== null)
  if (vols.length < 5) return null
  const mean = vols.reduce((a, b) => a + b, 0) / vols.length
  const today = bars.at(-1).volume
  if (!mean || today === null) return null
  return today / mean
}

export function retPct(bars, n) {
  if (!Array.isArray(bars) || bars.length < n + 1) return null
  const last = bars.at(-1).close
  const prev = bars.at(-(n + 1)).close
  if (!prev) return null
  return ((last - prev) / prev) * 100
}

const cmpFns = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
}
const cmpLabel = { '>': '高于', '>=': '不低于', '<': '低于', '<=': '不高于' }

/**
 * 求值一个规则。
 * @param rule 规则记录（含 kind/params/symbol/noteId）
 * @param ctxData { quote, bars, benchmarkBars, moneyFlow, sector, note }
 * @returns {{fired:boolean, severity?:string, title?:string, detail?:string, metrics?:object, skip?:string}}
 */
export function evaluateRule(rule, ctxData) {
  const p = rule.params || {}
  const { quote, bars, benchmarkBars, moneyFlow, stockSector, note } = ctxData

  switch (rule.kind) {
    // ── 价格阈值 ──
    case 'price_threshold': {
      const op = p.op || '>='
      const target = Number(p.value)
      if (!cmpFns[op]) return { fired: false, skip: '不支持的比较符：' + op }
      if (!Number.isFinite(target)) return { fired: false, skip: '缺少有效的 value 参数' }
      if (!quote || quote.price === null) return { fired: false, skip: '无行情数据' }
      const fired = cmpFns[op](quote.price, target)
      return {
        fired,
        severity: 'info',
        title: `${quote.name || rule.symbol} 价格${cmpLabel[op]} ${target}`,
        detail: `现价 ${quote.price}，阈值 ${op} ${target}，当日 ${quote.changePct}%`,
        metrics: { price: quote.price, target, op, changePct: quote.changePct },
      }
    }

    // ── 当日涨跌幅 ──
    case 'daily_change_pct': {
      const threshold = Number(p.value)
      const op = p.op || '>='
      if (!cmpFns[op]) return { fired: false, skip: '不支持的比较符：' + op }
      if (!Number.isFinite(threshold)) return { fired: false, skip: '缺少有效的 value 参数' }
      if (!quote || quote.changePct === null || quote.changePct === undefined) {
        return { fired: false, skip: '无涨跌幅数据' }
      }
      const fired = cmpFns[op](quote.changePct, threshold)
      return {
        fired,
        severity: Math.abs(quote.changePct) >= 7 ? 'critical' : 'warning',
        title: `${quote.name || rule.symbol} 当日涨跌 ${quote.changePct}%`,
        detail: `当日涨跌幅 ${quote.changePct}%，规则要求 ${op} ${threshold}%`,
        metrics: { changePct: quote.changePct, threshold, op, price: quote.price },
      }
    }

    // ── 成交量异常 ──
    case 'volume_anomaly': {
      const n = Number(p.n) || 20
      const mult = Number(p.mult) || 2
      const ratio = volumeRatio(bars, n)
      if (ratio === null) return { fired: false, skip: `历史数据不足 ${n + 1} 根` }
      const fired = ratio >= mult
      return {
        fired,
        severity: ratio >= mult * 1.5 ? 'critical' : 'warning',
        title: `${rule.name || rule.symbol} 成交量异常放大`,
        detail: `当日成交量为前 ${n} 日均量的 ${ratio.toFixed(2)} 倍（阈值 ${mult} 倍）`,
        metrics: { ratio: Math.round(ratio * 100) / 100, mult, window: n, todayVolume: bars.at(-1)?.volume ?? null },
      }
    }

    // ── 换手率骤升 ──
    case 'turnover_spike': {
      const target = Number(p.value)
      if (!Number.isFinite(target)) return { fired: false, skip: '缺少有效的 value（换手率 %）' }
      if (!quote || quote.turnover === null || quote.turnover === undefined) {
        return { fired: false, skip: '该标的无换手率数据（指数/港股可能没有）' }
      }
      const fired = quote.turnover >= target
      return {
        fired,
        severity: quote.turnover >= target * 1.5 ? 'critical' : 'warning',
        title: `${quote.name || rule.symbol} 换手率 ${quote.turnover}%`,
        detail: `换手率 ${quote.turnover}%，阈值 ${target}%`,
        metrics: { turnover: quote.turnover, threshold: target },
      }
    }

    // ── 波动率突破 ──
    case 'volatility_breakout': {
      const n = Number(p.n) || 20
      const ratioLimit = Number(p.ratio) || 1.6
      if (!Array.isArray(bars) || bars.length < n * 2 + 2) {
        return { fired: false, skip: `历史数据不足（需 ${n * 2 + 2} 根，实际 ${bars?.length ?? 0}）` }
      }
      const cur = realizedVol(bars, n)
      const prev = realizedVol(bars.slice(0, -n), n)
      if (cur === null || prev === null || prev <= 0) return { fired: false, skip: '波动率无法计算' }
      const ratio = cur / prev
      const fired = ratio >= ratioLimit
      return {
        fired,
        severity: ratio >= ratioLimit * 1.3 ? 'critical' : 'warning',
        title: `${rule.name || rule.symbol} 波动率突破`,
        detail: `${n} 日年化波动率 ${(cur * 100).toFixed(1)}%，为前一期 ${(prev * 100).toFixed(1)}% 的 ${ratio.toFixed(2)} 倍（阈值 ${ratioLimit} 倍）`,
        metrics: {
          current: Math.round(cur * 10000) / 100,
          previous: Math.round(prev * 10000) / 100,
          ratio: Math.round(ratio * 100) / 100,
          limit: ratioLimit,
        },
      }
    }

    // ── 相对强弱突变 ──
    case 'relative_strength_shift': {
      const n = Number(p.n) || 20
      const threshold = Number(p.threshold) || 5
      const dir = p.direction || 'underperform' // underperform | outperform | any
      if (!Array.isArray(bars) || !Array.isArray(benchmarkBars) || bars.length < n + 1 || benchmarkBars.length < n + 1) {
        return { fired: false, skip: '个股或基准历史数据不足' }
      }
      const bMap = new Map(benchmarkBars.map((b) => [b.time, b.close]))
      const aligned = bars.filter((b) => bMap.has(b.time))
      if (aligned.length < n + 1) return { fired: false, skip: '对齐后交易日不足' }
      const sRet = retPct(aligned, n)
      const bRet = retPct(aligned.map((x) => ({ close: bMap.get(x.time) })), n)
      if (sRet === null || bRet === null) return { fired: false, skip: '收益无法计算' }
      const excess = sRet - bRet
      let fired = false
      if (dir === 'underperform') fired = excess <= -Math.abs(threshold)
      else if (dir === 'outperform') fired = excess >= Math.abs(threshold)
      else fired = Math.abs(excess) >= Math.abs(threshold)
      return {
        fired,
        severity: Math.abs(excess) >= Math.abs(threshold) * 1.5 ? 'critical' : 'warning',
        title: `${rule.name || rule.symbol} ${n} 日相对强弱${excess > 0 ? '走强' : '走弱'}`,
        detail: `近 ${n} 日个股 ${sRet.toFixed(2)}% vs 基准 ${bRet.toFixed(2)}%，超额 ${excess >= 0 ? '+' : ''}${excess.toFixed(2)}pp（阈值 ${threshold}pp，方向 ${dir}）`,
        metrics: {
          stockReturn: Math.round(sRet * 100) / 100,
          benchmarkReturn: Math.round(bRet * 100) / 100,
          excess: Math.round(excess * 100) / 100,
          threshold, direction: dir, window: n,
        },
      }
    }

    // ── 资金流异常 ──
    case 'money_flow_anomaly': {
      const days = Number(p.days) || 5
      const threshold = Number(p.threshold)
      const dir = p.direction || 'inflow' // inflow | outflow | any
      if (!Number.isFinite(threshold)) return { fired: false, skip: '缺少有效的 threshold（元）' }
      if (!moneyFlow) return { fired: false, skip: '无资金流数据' }
      const series = Array.isArray(moneyFlow.series) ? moneyFlow.series.slice(-days) : []
      if (series.length === 0) return { fired: false, skip: '资金流序列为空' }
      const sum = series.reduce((a, r) => a + (r.mainNetInflow || 0), 0)
      let fired = false
      if (dir === 'inflow') fired = sum >= Math.abs(threshold)
      else if (dir === 'outflow') fired = sum <= -Math.abs(threshold)
      else fired = Math.abs(sum) >= Math.abs(threshold)
      const yi = (v) => (v / 1e8).toFixed(2) + '亿'
      return {
        fired,
        severity: Math.abs(sum) >= Math.abs(threshold) * 1.5 ? 'critical' : 'warning',
        title: `${rule.name || rule.symbol} 主力资金${sum >= 0 ? '净流入' : '净流出'} ${yi(Math.abs(sum))}`,
        detail: `近 ${days} 日主力累计净${sum >= 0 ? '流入' : '流出'} ${yi(Math.abs(sum))}（阈值 ${yi(Math.abs(threshold))}，方向 ${dir}）`,
        metrics: { sum: Math.round(sum), days, threshold, direction: dir, sampleSeries: series.slice(-3) },
      }
    }

    // ── 个股与行业背离 ──
    case 'sector_relative': {
      const threshold = Number(p.threshold) || 3
      const dir = p.direction || 'any'
      if (!quote || quote.changePct === null || quote.changePct === undefined) {
        return { fired: false, skip: '无个股涨跌幅' }
      }
      if (!stockSector || !stockSector.sector || stockSector.sector.changePct === null) {
        return { fired: false, skip: '未取到所属行业板块行情' }
      }
      const diff = quote.changePct - stockSector.sector.changePct
      let fired = false
      if (dir === 'underperform') fired = diff <= -Math.abs(threshold)
      else if (dir === 'outperform') fired = diff >= Math.abs(threshold)
      else fired = Math.abs(diff) >= Math.abs(threshold)
      return {
        fired,
        severity: 'warning',
        title: `${rule.name || rule.symbol} 与行业 ${stockSector.sector.name} 背离`,
        detail: `个股 ${quote.changePct}% vs 行业 ${stockSector.sector.changePct}%，差 ${diff >= 0 ? '+' : ''}${diff.toFixed(2)}pp（阈值 ${threshold}pp）`,
        metrics: {
          stockChangePct: quote.changePct,
          sectorChangePct: stockSector.sector.changePct,
          sectorName: stockSector.sector.name,
          sectorId: stockSector.sector.id,
          diff: Math.round(diff * 100) / 100, threshold, direction: dir,
        },
      }
    }

    // ── 研究假设到期 / 失效提醒（与 Notebook 联动）──
    case 'hypothesis_review_due': {
      if (!note) return { fired: false, skip: '规则未关联研究笔记（noteId）' }
      if (note.status === 'reviewed') return { fired: false, skip: '该笔记已复盘' }
      if (!note.reviewDate) return { fired: false, skip: '该笔记未设置复盘日' }
      const today = new Date().toISOString().slice(0, 10)
      const fired = note.reviewDate <= today
      return {
        fired,
        severity: 'info',
        title: `研究假设到了复盘日：${note.name || note.symbol || rule.symbol}`,
        detail: `笔记创建于 ${String(note.createdAt).slice(0, 10)}，复盘日 ${note.reviewDate}。`
          + `预测："${note.prediction || '（未填写）'}"。请对照实际走势判断该假设成立、部分成立还是被推翻。`,
        metrics: { noteId: note.id, reviewDate: note.reviewDate, prediction: note.prediction || null, confidence: note.confidence },
      }
    }

    default:
      return { fired: false, skip: '未实现的条件类型：' + rule.kind }
  }
}

/** 严重度排序，用于汇总展示 */
export const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 }