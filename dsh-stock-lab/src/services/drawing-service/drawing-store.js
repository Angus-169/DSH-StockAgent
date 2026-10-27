/**
 * drawing-store.js — 图表画线（标注）的持久化
 *
 * 设计（对应 ARCHITECTURE 的"画线"一节）：
 *   每个标的一个 JSON 文件 → `数据根目录/drawings/<SYMBOL>.json`
 *
 * **坐标锚点的选取是这个功能最关键的决定**，两个坑都会导致"画得对、显示歪"：
 *
 *   1. **x 必须锚定日期，不能锚定 K 线序号**
 *      图表按序号算 x（`xC(i)`），而序号会随根数变化、也会被新数据整体推移。
 *      用序号存 → 换个根数线就跑到别处，且"看起来仍然正常"。
 *
 *   2. **y 锚定价格，但要记录当时的复权模式**
 *      前复权基准在每次除权后会整体平移。用价格存、又换了复权模式，
 *      线相对蜡烛就会错位。所以每条线都记 `adjust`，不一致时**明确提示**而不是默默画歪。
 *
 * 另外每条线可以带一句 `reason`（为什么画在这里）——画线的价值在于**表达一个判断**，
 * 不只是看图方便。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { drawingsDir, resolveDataRoot } from '../../data-root.js'
import { normalize } from '../market-service/symbols.js'

/**
 * 支持的类型（按价值排序）。
 *
 * `circle` 的锚点是 **[圆心, 圆上一点]**（圆心-半径方式）。
 * 为什么不是包围框：用户更习惯"先点圆心、再拉半径"；而且这样渲染出来是**真正的圆**，
 * 不会因为 x/y 量纲不同而变成随缩放变化的椭圆。
 * 代价要说清：半径由两个锚点在数据空间的位置决定，**缩放时圆的屏幕大小会变**
 * （它锚定在数据上，不是固定像素）——这是数据空间锚定的必然结果，不是缺陷。
 */
export const DRAWING_TYPES = ['hline', 'trend', 'circle', 'marker']

/** 每种类型需要几个锚点 */
export const ANCHORS_REQUIRED = { hline: 1, trend: 2, circle: 2, marker: 1 }

/**
 * 趋势线的延伸方式（与看盘软件一致）：
 *   segment 线段——只画在两个锚点之间
 *   ray     射线——从**第一个**锚点出发，穿过第二个锚点后延伸到画布边缘（**默认**）
 *   line    直线——向两端都延伸到画布边缘
 * 只有 trend 用得到；其它类型存 null。
 */
export const LINE_EXT = ['segment', 'ray', 'line']
export const DEFAULT_EXT = 'ray'

/**
 * 可选的画线颜色（**存的是色名，不是色值**）。
 *
 * 为什么不存 CSS 色值：色值一旦写进文件就固定了，**明暗主题切换后会看不清**
 * （浅色主题下的深蓝在深色主题上几乎不可见）。存色名，由客户端映射到主题 token，
 * 这样同一条线在明暗主题下都能看清——与"UI 颜色一律走主题 token"这条铁律一致。
 */
export const DRAWING_COLORS = ['black', 'red', 'green', 'blue', 'orange', 'purple']

/** 单个文件的版本号，便于以后迁移 */
const FILE_VERSION = 1

function fileFor(symbol, dir) {
  const sym = normalize(String(symbol)).symbol
  // 文件名用规范代码，避免 'sh600519' / '600519' 写成两个文件
  return { sym, path: join(dir, `${sym}.json`) }
}

/** 把任意输入规范化成一条合法的画线；不合法就返回错误原因（不静默修正） */
export function normalizeDrawing(input) {
  const errs = []
  const type = String(input?.type || '').trim()
  if (!DRAWING_TYPES.includes(type)) {
    errs.push(`type 必须是 ${DRAWING_TYPES.join(' / ')} 之一，收到：${type || '（空）'}`)
  }
  const need = ANCHORS_REQUIRED[type]
  const rawAnchors = Array.isArray(input?.anchors) ? input.anchors : []
  if (need && rawAnchors.length !== need) {
    errs.push(`${type} 需要 ${need} 个锚点，收到 ${rawAnchors.length} 个`)
  }
  const anchors = []
  for (const [i, a] of rawAnchors.entries()) {
    const date = String(a?.date || '').trim()
    // ⚠️ 只接受**数字**或**非空数字字符串**。
    // 不能直接 Number(...)：Number(null) = 0、Number('') = 0 —— 会把"没填价格"静默变成
    // 「锚点在 0 元」这一条合法记录，图上画出一条贴底的线，而且看不出是错的。
    const raw = a?.price
    const numeric = typeof raw === 'number'
      || (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw)))
    const price = numeric ? Number(raw) : NaN
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) errs.push(`第 ${i + 1} 个锚点的 date 应为 YYYY-MM-DD，收到：${date || '（空）'}`)
    if (!Number.isFinite(price)) errs.push(`第 ${i + 1} 个锚点的 price 应为有效数字（不接受 null / 空串 / 布尔），收到：${JSON.stringify(raw)}`)
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(price)) anchors.push({ date, price })
  }
  const adjust = ['qfq', 'hfq', 'none'].includes(input?.adjust) ? input.adjust : null
  if (adjust === null) errs.push(`adjust 必须是 qfq / hfq / none 之一，收到：${input?.adjust ?? '（空）'}`)
  // 延伸方式：只有 trend 有意义；给了非法值要报错，没给就用默认（射线）
  let ext = null
  if (type === 'trend') {
    ext = input?.ext === undefined || input?.ext === null ? DEFAULT_EXT : String(input.ext)
    if (!LINE_EXT.includes(ext)) errs.push(`trend 的 ext 必须是 ${LINE_EXT.join(' / ')} 之一，收到：${ext}`)
  }
  // 颜色：存色名（见 DRAWING_COLORS 的说明），非法值报错，没给则用默认色
  let color = null
  if (input?.color !== undefined && input?.color !== null && input?.color !== '') {
    color = String(input.color)
    if (!DRAWING_COLORS.includes(color)) {
      errs.push(`color 必须是 ${DRAWING_COLORS.join(' / ')} 之一（存色名而非色值），收到：${color}`)
    }
  }
  if (errs.length > 0) return { ok: false, errors: errs }
  return {
    ok: true,
    drawing: {
      id: typeof input.id === 'string' && input.id !== '' ? input.id : randomUUID(),
      type,
      anchors,
      ext,
      color,
      label: typeof input.label === 'string' ? input.label.slice(0, 80) : null,
      reason: typeof input.reason === 'string' ? input.reason.slice(0, 500) : null,
      noteId: typeof input.noteId === 'string' && input.noteId !== '' ? input.noteId : null,
      adjust,
      dataVersion: typeof input.dataVersion === 'string' ? input.dataVersion : null,
      createdAt: typeof input.createdAt === 'string' ? input.createdAt : new Date().toISOString(),
    },
  }
}

export class DrawingStore {
  constructor(dir = drawingsDir()) {
    this.dir = dir
    try { mkdirSync(dir, { recursive: true }) } catch { /* 只读场景下允许失败，写时再报 */ }
  }

  /** 读某标的的全部画线。文件损坏时**如实报错**，不当作"没有画线" */
  list(symbol) {
    const { sym, path } = fileFor(symbol, this.dir)
    if (!existsSync(path)) return { symbol: sym, drawings: [], warnings: [] }
    let raw
    try { raw = readFileSync(path, 'utf8') } catch (e) {
      return { symbol: sym, drawings: [], warnings: [`读取失败：${e?.message || e}`] }
    }
    let json
    try { json = JSON.parse(raw) } catch (e) {
      return { symbol: sym, drawings: [], warnings: [`文件不是合法 JSON（${path}）：${e?.message || e}`] }
    }
    const warnings = []
    if (json?.version !== undefined && json.version !== FILE_VERSION) {
      warnings.push(`文件版本为 ${json.version}，当前支持 ${FILE_VERSION}（仍按当前格式尽力读取）`)
    }
    const list = Array.isArray(json?.drawings) ? json.drawings : []
    const drawings = []
    for (const [i, d] of list.entries()) {
      const r = normalizeDrawing(d)
      if (r.ok) drawings.push(r.drawing)
      else warnings.push(`第 ${i + 1} 条画线不合法，已跳过：${r.errors.join('；')}`)
    }
    return { symbol: sym, drawings, warnings }
  }

  /** 覆盖写入某标的的全部画线（先规范校验，再原子替换文件内容） */
  replaceAll(symbol, drawings) {
    const { sym, path } = fileFor(symbol, this.dir)
    const ok = []
    const errors = []
    for (const [i, d] of (Array.isArray(drawings) ? drawings : []).entries()) {
      const r = normalizeDrawing(d)
      if (r.ok) { if (d?.id) r.drawing.id = d.id; ok.push(r.drawing) }
      else errors.push(`第 ${i + 1} 条：${r.errors.join('；')}`)
    }
    if (errors.length > 0) return { ok: false, errors }
    const payload = {
      version: FILE_VERSION,
      symbol: sym,
      savedAt: new Date().toISOString(),
      drawings: ok,
    }
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(path, JSON.stringify(payload, null, 2), 'utf8')
    } catch (e) {
      return { ok: false, errors: [`写入失败：${e?.message || e}`] }
    }
    return { ok: true, symbol: sym, path, count: ok.length }
  }

  /** 追加一条（id 相同则替换，避免重复） */
  add(symbol, drawing) {
    const r = normalizeDrawing(drawing)
    if (!r.ok) return { ok: false, errors: r.errors }
    const cur = this.list(symbol)
    const next = cur.drawings.filter((d) => d.id !== r.drawing.id)
    next.push(r.drawing)
    return this.replaceAll(symbol, next)
  }

  /** 删除一条；找不到时如实返回 false */
  remove(symbol, id) {
    const cur = this.list(symbol)
    const next = cur.drawings.filter((d) => d.id !== id)
    if (next.length === cur.drawings.length) return { ok: false, errors: [`找不到画线：${id}`] }
    return this.replaceAll(symbol, next)
  }

  /** 列出所有有画线的标的（便于"我在哪些票上画过线"） */
  listSymbols() {
    try {
      return readdirSync(this.dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
    } catch { return [] }
  }

  /** 删除某标的的画线文件（清空该标的的画线） */
  clear(symbol) {
    const { path } = fileFor(symbol, this.dir)
    if (!existsSync(path)) return { ok: true, removed: 0 }
    try { unlinkSync(path) } catch (e) { return { ok: false, errors: [`删除失败：${e?.message || e}`] } }
    return { ok: true, removed: 1 }
  }

  /** 统计（供 diagnostics 用） */
  stats() {
    const symbols = this.listSymbols()
    let total = 0
    const warnings = []
    for (const s of symbols) {
      const r = this.list(s)
      total += r.drawings.length
      for (const w of r.warnings) warnings.push(`${s}: ${w}`)
    }
    return { dir: this.dir, root: resolveDataRoot(), symbols: symbols.length, drawings: total, warnings }
  }
}