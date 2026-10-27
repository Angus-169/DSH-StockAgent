/**
 * tdx-functions.js — 通达信函数库（对序列逐 bar 求值）
 *
 * 约定：
 *   - 所有值都是「序列」：长度 = bar 数的数组，元素为 number 或 null（无效/未定义）
 *   - 常量由求值器广播成常序列，因此函数只需处理序列
 *   - null 表示"该 bar 上无有效值"：算术运算传播 null；逻辑上下文里 null 视为 false
 *
 * ⚠️ 与通达信的语义差异会被显式记录（见各函数注释），并有测试固定。
 *    宁可写清"这里与通达信可能有差异"，也不假装完全一致。
 */

/** 生成常序列 */
export function constant(value, n) {
  return new Array(n).fill(value)
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

/** 逐元素二元运算，null 传播 */
export function map2(a, b, fn) {
  const n = Math.max(a.length, b.length)
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    const x = i < a.length ? a[i] : null
    const y = i < b.length ? b[i] : null
    out[i] = (x === null || y === null) ? null : fn(x, y)
  }
  return out
}

/** 逐元素一元运算，null 传播 */
export function map1(a, fn) {
  return a.map((x) => (x === null ? null : fn(x)))
}

/** 逻辑上下文里把 null 当 false */
const truthy = (v) => v === 1 || v === true || (isNum(v) && v !== 0)
const bool = (b) => (b ? 1 : 0)

/** 取窗口 [i-len+1, i]，越界或含 null 返回 null */
function window(arr, i, len) {
  if (i - len + 1 < 0) return null
  const out = []
  for (let k = i - len + 1; k <= i; k++) {
    const v = arr[k]
    if (v === null) return null
    out.push(v)
  }
  return out
}

/** 周期参数：可能是常序列（同一值）或逐 bar 变化的序列 */
function periodAt(series, i, fallback) {
  if (series === undefined || series === null) return fallback
  if (typeof series === 'number') return series
  const v = series[i]
  return isNum(v) && v > 0 ? Math.floor(v) : fallback
}

// ─────────────────────────── 函数实现 ───────────────────────────

/** 简单移动平均。前 N-1 根无效（通达信一致） */
function MA(x, n) {
  const out = new Array(x.length).fill(null)
  for (let i = 0; i < x.length; i++) {
    const len = periodAt(n, i, 0)
    if (len <= 0) continue
    const w = window(x, i, len)
    if (!w) continue
    out[i] = w.reduce((a, b) => a + b, 0) / len
  }
  return out
}

/** 指数移动平均：alpha = 2/(N+1)，首值取首个有效值 */
function EMA(x, n) {
  const out = new Array(x.length).fill(null)
  let prev = null
  for (let i = 0; i < x.length; i++) {
    const len = periodAt(n, i, 0)
    const v = x[i]
    if (len <= 0 || v === null) { out[i] = prev; continue }
    const alpha = 2 / (len + 1)
    prev = prev === null ? v : v * alpha + prev * (1 - alpha)
    out[i] = prev
  }
  return out
}

/**
 * 通达信 SMA(X,N,M)：Y = (M*X + (N-M)*Y') / N
 * ⚠️ 首值处理各实现不一：此处取 Y(首个有效) = X，与多数通达信公式口径相同。
 */
function SMA(x, n, m) {
  const out = new Array(x.length).fill(null)
  let prev = null
  for (let i = 0; i < x.length; i++) {
    const len = periodAt(n, i, 0)
    const mm = periodAt(m, i, 1)
    const v = x[i]
    if (len <= 0 || v === null) { out[i] = prev; continue }
    prev = prev === null ? v : (mm * v + (len - mm) * prev) / len
    out[i] = prev
  }
  return out
}

/** 前 N 根的值：REF(X,N) */
function REF(x, n) {
  const out = new Array(x.length).fill(null)
  for (let i = 0; i < x.length; i++) {
    const k = periodAt(n, i, 1)
    const j = i - k
    out[i] = j >= 0 ? x[j] : null
  }
  return out
}

/** 过去 N 根最大值 */
function HHV(x, n) {
  const out = new Array(x.length).fill(null)
  for (let i = 0; i < x.length; i++) {
    const len = periodAt(n, i, 0)
    if (len <= 0) continue
    const w = window(x, i, len)
    if (w) out[i] = Math.max(...w)
  }
  return out
}

/** 过去 N 根最小值 */
function LLV(x, n) {
  const out = new Array(x.length).fill(null)
  for (let i = 0; i < x.length; i++) {
    const len = periodAt(n, i, 0)
    if (len <= 0) continue
    const w = window(x, i, len)
    if (w) out[i] = Math.min(...w)
  }
  return out
}

/** 过去 N 根求和；N=0 表示从首根累计 */
function SUM(x, n) {
  const out = new Array(x.length).fill(null)
  let acc = 0
  for (let i = 0; i < x.length; i++) {
    const len = periodAt(n, i, 0)
    if (len === 0) { // 累计
      if (x[i] === null) { out[i] = null; continue }
      acc += x[i]
      out[i] = acc
      continue
    }
    const w = window(x, i, len)
    if (w) out[i] = w.reduce((a, b) => a + b, 0)
  }
  return out
}

/**
 * 过去 N 根标准差。
 * ⚠️ 口径：使用**总体标准差**（除以 N），与通达信 STD 一致；
 *    总体 vs 样本的差异在此显式写明，测试固定为 ÷N。
 */
function STD(x, n) {
  const out = new Array(x.length).fill(null)
  for (let i = 0; i < x.length; i++) {
    const len = periodAt(n, i, 0)
    if (len <= 0) continue
    const w = window(x, i, len)
    if (!w) continue
    const mean = w.reduce((a, b) => a + b, 0) / len
    const varr = w.reduce((a, b) => a + (b - mean) ** 2, 0) / len
    out[i] = Math.sqrt(varr)
  }
  return out
}

/** A 上穿 B：当根 A>B 且前一根 A<=B */
function CROSS(a, b) {
  const out = new Array(Math.max(a.length, b.length)).fill(null)
  for (let i = 0; i < out.length; i++) {
    const a0 = i < a.length ? a[i] : null
    const b0 = i < b.length ? b[i] : null
    const a1 = i - 1 >= 0 && i - 1 < a.length ? a[i - 1] : null
    const b1 = i - 1 >= 0 && i - 1 < b.length ? b[i - 1] : null
    out[i] = (a0 === null || b0 === null || a1 === null || b1 === null)
      ? 0 : bool(a0 > b0 && a1 <= b1)
  }
  return out
}

/** 过去 N 根中条件为真的次数 */
function COUNT(cond, n) {
  const out = new Array(cond.length).fill(null)
  for (let i = 0; i < cond.length; i++) {
    const len = periodAt(n, i, 0)
    if (len <= 0) continue
    if (i - len + 1 < 0) continue
    let c = 0
    for (let k = i - len + 1; k <= i; k++) if (truthy(cond[k])) c++
    out[i] = c
  }
  return out
}

/** 过去 N 根条件是否全为真 */
function EVERY(cond, n) {
  const out = new Array(cond.length).fill(null)
  for (let i = 0; i < cond.length; i++) {
    const len = periodAt(n, i, 0)
    if (len <= 0 || i - len + 1 < 0) continue
    let all = true
    for (let k = i - len + 1; k <= i; k++) if (!truthy(cond[k])) { all = false; break }
    out[i] = bool(all)
  }
  return out
}

/** 过去 N 根条件是否存在为真 */
function EXIST(cond, n) {
  const out = new Array(cond.length).fill(null)
  for (let i = 0; i < cond.length; i++) {
    const len = periodAt(n, i, 0)
    if (len <= 0 || i - len + 1 < 0) continue
    let any = false
    for (let k = i - len + 1; k <= i; k++) if (truthy(cond[k])) { any = true; break }
    out[i] = bool(any)
  }
  return out
}

/** 上一次条件为真距今多少根；从未有时为 null */
function BARSLAST(cond) {
  const out = new Array(cond.length).fill(null)
  let last = -1
  for (let i = 0; i < cond.length; i++) {
    if (truthy(cond[i])) last = i
    out[i] = last < 0 ? null : i - last
  }
  return out
}

/** 距今满足条件的连续根数（等于 BARSLAST 的常用变体 FIRSTBARS 不实现） */
function BARSSINCE(cond) {
  const out = new Array(cond.length).fill(null)
  let first = -1
  for (let i = 0; i < cond.length; i++) {
    if (first < 0 && truthy(cond[i])) first = i
    out[i] = first < 0 ? null : i - first
  }
  return out
}

/** 条件选择：IF(COND, A, B) */
function IF(cond, a, b) {
  const n = Math.max(cond.length, a.length, b.length)
  const out = new Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    const c = i < cond.length ? cond[i] : 0
    out[i] = truthy(c)
      ? (i < a.length ? a[i] : null)
      : (i < b.length ? b[i] : null)
  }
  return out
}

/** 到当前 bar 为止的有效值个数（常用作总根数） */
function BARSCOUNT(x) {
  let c = 0
  return x.map((v) => { if (v !== null) c++; return c })
}

/** 函数注册表：name → { minArgs, maxArgs, impl, note? } */
export const FUNCTIONS = new Map()

function def(name, minArgs, maxArgs, impl, note) {
  FUNCTIONS.set(name, { name, minArgs, maxArgs, impl, note })
  FUNCTIONS.set(name.toLowerCase(), FUNCTIONS.get(name))
}

// 均线 / 平滑
def('MA', 1, 2, (x, n) => MA(x, n ?? 5))
def('EMA', 1, 2, (x, n) => EMA(x, n ?? 5))
def('SMA', 3, 3, (x, n, m) => SMA(x, n, m))
// 说明：MEMA / WMA / DMA / EXPMA 等其它平滑函数的通达信口径未能确认，
// 因此**不注册**——宁可报"不支持"，也不给一个"看起来像"的结果。
// 引用 / 位移
def('REF', 2, 2, (x, n) => REF(x, n))
def('BARSCOUNT', 1, 1, (x) => BARSCOUNT(x))
def('BARSLAST', 1, 1, (x) => BARSLAST(x))
def('BARSSINCE', 1, 1, (x) => BARSSINCE(x))
// 极值 / 求和 / 统计
def('HHV', 1, 2, (x, n) => HHV(x, n ?? 0))
def('LLV', 1, 2, (x, n) => LLV(x, n ?? 0))
def('SUM', 1, 2, (x, n) => SUM(x, n ?? 0))
def('STD', 2, 2, (x, n) => STD(x, n))
// 逻辑
def('CROSS', 2, 2, (a, b) => CROSS(a, b))
def('COUNT', 2, 2, (c, n) => COUNT(c, n))
def('EVERY', 2, 2, (c, n) => EVERY(c, n))
def('EXIST', 2, 2, (c, n) => EXIST(c, n))
def('IF', 3, 3, (c, a, b) => IF(c, a, b))
def('IFF', 3, 3, (c, a, b) => IF(c, a, b))
// 数学（逐元素）
def('ABS', 1, 1, (x) => map1(x, Math.abs))
def('MAX', 2, 2, (a, b) => map2(a, b, Math.max))
def('MIN', 2, 2, (a, b) => map2(a, b, Math.min))
def('SQRT', 1, 1, (x) => map1(x, (v) => (v < 0 ? null : Math.sqrt(v))))
def('POW', 2, 2, (a, b) => map2(a, b, (x, y) => x ** y))
def('LOG', 1, 1, (x) => map1(x, (v) => (v <= 0 ? null : Math.log(v))))
def('EXP', 1, 1, (x) => map1(x, Math.exp))
def('SIGN', 1, 1, (x) => map1(x, Math.sign))
def('ROUND', 1, 1, (x) => map1(x, Math.round))
def('INTPART', 1, 1, (x) => map1(x, Math.trunc))
def('CEILING', 1, 1, (x) => map1(x, Math.ceil))
def('FLOOR', 1, 1, (x) => map1(x, Math.floor))

/**
 * 未来函数：会让**历史信号随新数据改变**（重画历史，俗称"事后诸葛亮"）。
 * 用它们判断买卖信号会得到虚假的高胜率，因此解析到就警告、默认拒绝计算。
 *
 * 注意：这一类的判据是"会重画历史"，不是"我们没实现"。
 */
export const FUTURE_FUNCTIONS = new Set([
  'ZIG', 'PEAK', 'PEAKBARS', 'TROUGH', 'TROUGHBARS', 'BACKSET', 'REFDATE',
])

/**
 * 需要「非 K 线数据」的函数：财务 / 实时盘口 / 股本 / 自定义数据。
 *
 * ⚠️ 它们**不是未来函数**——不会重画历史。真正的限制是：本引擎只提供
 * K 线序列（O/H/L/C/V/AMOUNT），拿不到财务与实时快照，因此算不了。
 *
 * 之所以要单独一类：把「缺数据」说成「未来函数」，用户会以为是自己的公式
 * 有问题；而实际上大量真实选股公式都用 FINANCE/CAPITAL/DYNAINFO。
 * 必须让报错指向真正的原因。
 */
export const DATA_DEPENDENT_FUNCTIONS = new Set([
  'FINANCE', 'FINANCE_EX', 'DYNAINFO', 'CAPITAL', 'SELFDATA', 'HYBLOCK', 'INBLOCK',
])

/**
 * 同样需要「非 K 线数据」的**变量**（不是函数，因此单独一张表）。
 * 例：`CAPITAL` 在通达信里是流通股本（单位：手），是变量而非函数——
 * 早期只扫函数调用，导致这类公式落到"引用了未定义的变量"，指向了错误原因。
 */
export const DATA_DEPENDENT_VARS = new Set([
  'CAPITAL', 'TOTALCAPITAL', 'VOLINSTK', 'HKTOTAL', 'HKVOL',
])

/** 可实现但尚未实现（理论上只靠 K 线就能算，如筹码分布类） */
export const NOT_IMPLEMENTED_FUNCTIONS = new Set([
  'COST', 'WINNER', 'LWINNER', 'PPART', 'PWINNER',
])

/** 绘图指令：MVP 忽略，但要如实列出（不装作画出来了） */
export const DRAW_FUNCTIONS = new Set([
  'DRAWTEXT', 'DRAWICON', 'DRAWNUMBER', 'DRAWLINE', 'DRAWKLINE',
  'STICKLINE', 'POLYLINE', 'PARTLINE', 'DRAWBAND', 'DRAWRECTREL',
  'VERTLINE', 'HORLINE', 'DRAWGBK', 'DRAWTEXT_FIX', 'DRAWICON_FIX',
  'DRAWNUMBER_FIX', 'DRAWLINE_FIX', 'DRAWRECTREL_FIX',
])

/** 供错误提示用的支持列表（按类别） */
export function supportedFunctionNames() {
  const names = new Set()
  for (const [k, v] of FUNCTIONS) if (k === v.name) names.add(v.name)
  return [...names].sort()
}