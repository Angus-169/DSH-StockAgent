/**
 * client.js — dsh-stock-lab 客户端 bundle
 *
 * 挂载：
 *   main[key=stock-lab]              → 工作台整页
 *   sidebar.panellist[id=stock-lab]  → 侧栏入口图标
 *
 * 数据一律经 Host 的 /stock-lab/* 路由（UI 不直连任何行情 API）。
 * 主题只用 dsw token，不硬编码颜色。
 */
window.__ModuleLoader__.load({
  id: 'dsh-stock-lab',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, useMemo } = React

    // ─────────────────────────── 常量 ───────────────────────────
    const API = '/stock-lab'
    const BARS = 20
    const INDEX_KEYS = ['IDX000001', 'IDX399001', 'IDX399006', 'IDX000300']
    const TIMEFRAMES = [
      { k: '1d', label: '日' }, { k: '1w', label: '周' }, { k: '1M', label: '月' },
    ]
    const ADJUSTS = [{ k: 'qfq', label: '前复权' }, { k: 'none', label: '不复权' }, { k: 'hfq', label: '后复权' }]

    /** 画线颜色（**存色名、不存色值**，由这里映射到主题 token，明暗主题都不会看不清） */
    const DRAW_COLORS = [
      { k: 'black', label: '黑' },
      { k: 'red', label: '红' },
      { k: 'green', label: '绿' },
      { k: 'blue', label: '蓝' },
      { k: 'orange', label: '橙' },
      { k: 'purple', label: '紫' },
    ]
    /**
     * 色名 → 主题 token。
     * 紫色没有对应的别名 token（主题只提供品牌色与四种状态色），所以用 `color-mix()`
     * 由**两个 token 派生**（红 + 蓝）——仍然跟随明暗主题，也没有硬编码色值。
     */
    const DRAW_COLOR_CSS = {
      black: 'var(--dsw-alias-label-primary)',
      red: 'var(--dsw-alias-state-error-primary)',
      green: 'var(--dsw-alias-state-success-primary)',
      blue: 'var(--dsw-alias-link)',
      orange: 'var(--dsw-alias-state-warn-primary)',
      purple: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 45%, var(--dsw-alias-link))',
    }
    const drawingColorCss = (key) => DRAW_COLOR_CSS[key] || null

    /** 工具清单：画线工具 + 选择 + 测幅（与宿主侧 DRAWING_TYPES 对应，后两个不落库） */
    const DRAW_TOOLS = [
      { k: 'hline', label: '水平线', tip: '画水平线：在图上按下并拖动（会吸附到最近的 K 线高低点）' },
      { k: 'trend', label: '趋势线', tip: '画趋势线：按下拖到另一点松开；默认画成**射线**，画好后可切成线段/直线' },
      { k: 'circle', label: '圆', tip: '画圆：先点圆心、再拖出半径（真圆，不随横纵比例变形）' },
      { k: 'marker', label: '标记', tip: '标记某一天：在图上单击或拖动（吸附到最近的 K 线）' },
    ]
    /** 不落库的工具（只在图上临时显示） */
    const VIEW_TOOLS = [
      { k: 'select', label: '选择', tip: '选择模式：点线选中一条；在图上拖动可框选多条，然后按 Delete 批量删除' },
      {
        k: 'measure', label: '测幅',
        tip: '测幅：在图上拖出两个点（或点两下），显示两点之间的涨跌幅、价差与相隔根数',
      },
    ]
    const DRAW_TOOL_LABEL = Object.fromEntries(DRAW_TOOLS.map((t) => [t.k, t.label]))
    /** 趋势线的延伸方式（与宿主侧 LINE_EXT 对应） */
    const LINE_EXTS = [
      { k: 'segment', label: '线段' },
      { k: 'ray', label: '射线' },
      { k: 'line', label: '直线' },
    ]
    const LS_WATCH = 'stock-lab:watchlist'
    const LS_LAST = 'stock-lab:last'
    const LS_RIGHT = 'stock-lab:rightPane'
    /** 默认自选股：localStorage 尚未写入时侧栏展示这三只；公式选股的「自选股」池也复用同一默认值 */
    const DEFAULT_WATCH = [
      { symbol: 'SH600519', name: '贵州茅台' },
      { symbol: 'SZ300750', name: '宁德时代' },
      { symbol: 'SZ000001', name: '平安银行' },
    ]

    // 右栏尺寸约束：不同显示器与 DSH 窗口尺寸差异很大，因此宽度由用户拖拽决定。
    // 上限同时受容器宽度限制（见 clampPaneWidth），避免在窄窗口里把图表挤没。
    const RIGHT_PANE = {
      default: 380,
      min: 260,
      // 容器宽度占比上限：右栏最多占 55%，保证中间图表区始终可用
      maxRatio: 0.55,
      hardMax: 900,
      collapseBelow: 880,   // 容器窄于此宽度时，右栏默认收起为竖条
      step: 24,             // 键盘微调步长（px）
      sizeHintMs: 3000,     // 宽度提示在"停手"后保留多久（毫秒）
      storageKey: LS_RIGHT,
    }

    /**
     * 对话输入框的高度规则。
     *
     * 为什么不用原生 textarea 的 resize：那个手柄长在**右下角**，是个小三角箭头，
     * 用户的原话是"感觉很怪"——它也和"拖动上边缘上下移动"这种直接操作不一致。
     * 因此关掉原生 resize，改在**上边缘**放一个拖拽条：往上拖变高，往下拖变矮，
     * 边缘跟着指针走（这才是直接操作该有的手感）。
     */
    const COMPOSER = {
      default: 64,
      min: 56,
      max: 360,
      // 同时受面板高度约束：输入框不该吃掉整块对话区
      maxRatioOfPane: 0.6,
      step: 24,
      storageKey: 'stock-lab:composerHeight',
    }

    /** 夹取输入框高度（纯函数） */
    function clampComposerHeight(requested, paneHeight, cfg = COMPOSER) {
      if (typeof requested !== 'number' || !Number.isFinite(requested)) return cfg.default
      const usable = typeof paneHeight === 'number' && Number.isFinite(paneHeight) && paneHeight > 0
      const ratioMax = usable ? Math.floor(paneHeight * cfg.maxRatioOfPane) : cfg.max
      const max = Math.max(cfg.min, Math.min(cfg.max, ratioMax))
      return Math.min(max, Math.max(cfg.min, Math.round(requested)))
    }

    /** 从某个元素往上找到右栏，量它的高度（拿不到就返回 null，由 clamp 退化处理） */
    function paneHeightOf(el) {
      try {
        const pane = el && el.closest ? el.closest('.sl-right') : null
        const h = pane && pane.getBoundingClientRect ? pane.getBoundingClientRect().height : null
        return typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : null
      } catch { return null }
    }

    /**
     * 输入框高度的拖拽状态。
     * 语义与右栏分隔条一致：拖动中跟手、键盘可调、双击复位、结果持久化。
     */
    function useComposerResize(handleRef) {
      const [stored, setStored] = useLocal(COMPOSER.storageKey, COMPOSER.default)
      const [draft, setDraft] = useState(null)
      const [dragging, setDragging] = useState(false)
      const startRef = useRef({ y: 0, h: 0 })

      const height = clampComposerHeight(draft ?? stored, paneHeightOf(handleRef.current))

      const commit = (px) => setStored(clampComposerHeight(px, paneHeightOf(handleRef.current)))

      const onPointerDown = (e) => {
        try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* ignore */ }
        startRef.current = { y: e.clientY, h: height }
        setDragging(true)
        setDraft(height)
      }
      const onPointerMove = (e) => {
        if (!dragging) return
        // 上边缘跟手：指针往上（clientY 变小）→ 变高
        const next = startRef.current.h + (startRef.current.y - e.clientY)
        setDraft(clampComposerHeight(next, paneHeightOf(handleRef.current)))
      }
      const endDrag = () => {
        if (!dragging) return
        setDragging(false)
        if (draft !== null) commit(draft)
        setDraft(null)
      }
      const onKeyDown = (e) => {
        const step = e.shiftKey ? COMPOSER.step * 4 : COMPOSER.step
        if (e.key === 'ArrowUp') { e.preventDefault(); commit(height + step) }
        else if (e.key === 'ArrowDown') { e.preventDefault(); commit(height - step) }
        else if (e.key === 'Home') { e.preventDefault(); commit(COMPOSER.min) }
        else if (e.key === 'End') { e.preventDefault(); commit(COMPOSER.max) }
        else if (e.key === 'Enter') { e.preventDefault(); commit(COMPOSER.default) }
      }

      return { height, dragging, onPointerDown, onPointerMove, endDrag, onKeyDown, reset: () => commit(COMPOSER.default) }
    }

    /**
     * K 线的**可视窗口**（缩放 / 平移）。
     *
     * 为什么不继续用"根数预设"：
     *   证券软件的缩放与平移是**同一张数据上的窗口**——必须能往回看历史。
     *   而"根数预设"只能看最新 N 根，**根本没有向左平移的能力**，
     *   这正是它与真实看盘软件手感差距最大的地方。
     *
     * 所以改成：一次取足够长的**缓冲区**，在其上维护窗口 `{ count, end }`
     *   count = 可见根数（缩放）
     *   end   = 窗口右边缘在缓冲区里的下标（平移；默认 = 最新一根）
     */
    const BARS_BUFFER = 800          // 与 /kline 的 count 上限一致
    /**
     * 图表几何常量（**模块级**，因为缩放/滚轮要按指针位置反算"这是哪一根 K 线"，
     * 不能让图表和交互层各写一份——那样容器宽度一变就会算偏）。
     * SVG 用固定 viewBox 宽度再缩放到容器，所以指针坐标必须先换算到 viewBox 单位。
     */
    const CHART_GEO = { W: 900, PAD_L: 8, PAD_R: 56, PAD_T: 10, PRICE_H: 240 }

    /**
     * 主图价格比例尺（纯函数，图表与交互层共用）。
     * 把主图叠加线一起纳入范围——否则均线一旦跑到价格区间外就会被裁掉。
     */
    function computePriceScale(bars, overlay = []) {
      const highs = (bars || []).map((b) => b.high).filter((v) => typeof v === 'number')
      const lows = (bars || []).map((b) => b.low).filter((v) => typeof v === 'number')
      let maxP = highs.length ? Math.max(...highs) : 1
      let minP = lows.length ? Math.min(...lows) : 0
      for (const o of overlay) {
        for (const v of o.values || []) {
          if (typeof v !== 'number') continue
          if (v > maxP) maxP = v
          if (v < minP) minP = v
        }
      }
      const span = (maxP - minP) || 1
      return { maxP, minP, span }
    }

    /** 指针 y（viewBox 单位）→ 价格（纯函数，与图表的 yP 互逆） */
    function priceAtY(svgY, scale, geo) {
      const h = geo.priceH
      if (!(h > 0)) return null
      const frac = 1 - (svgY - geo.padT) / h
      return scale.minP + frac * scale.span
    }

    /**
     * 把一笔"指针位置"解析成吸附后的锚点（纯函数）。
     *
     * 吸附是必须的：手画的线永远对不准 K 线高低点，没有吸附的线只能"看个大概"。
     * 规则：先吸附到最近的 K 线，再把价格吸附到那根 K 线的 **高 / 低 / 收** 三者里最近的一个。
     * 找不到合适目标时保留原始值（不硬掰）。
     *
     * 返回的 `date` 是该 K 线的交易日——**锚点存日期而不是下标**，
     * 所以调用方不需要窗口起点做换算（曾经的签名里有个用不到的 windowStart，反而引发过一次缺陷）。
     */
    function snapAnchor(bars, rawIndex, rawPrice, enabled = true) {
      if (!Array.isArray(bars) || bars.length === 0 || !Number.isFinite(rawIndex)) {
        return { i: rawIndex, price: rawPrice, snapped: false, date: null }
      }
      const i = Math.max(0, Math.min(bars.length - 1, Math.round(rawIndex)))
      const b = bars[i]
      if (!b) return { i: rawIndex, price: rawPrice, snapped: false, date: null }
      // 吸附关闭时只对齐到 K 线的时间轴，价格用原始值（想画"半路"价位时用得上）
      if (enabled === false) return { i, price: rawPrice, snapped: false, date: b.time || null }
      // 四个价位都要能吸上：开高低收（曾漏掉 open，表现为"一根 K 线只能吸 3 个点"）
      let best = null
      for (const [kind, v] of [['open', b.open], ['low', b.low], ['high', b.high], ['close', b.close]]) {
        if (typeof v !== 'number' || !Number.isFinite(v)) continue
        const d = Math.abs(v - rawPrice)
        if (best === null || d < best.d) best = { kind, price: v, d }
      }
      if (best === null) return { i, price: rawPrice, snapped: false, date: b.time || null }
      return { i, price: best.price, snapped: true, kind: best.kind, date: b.time || null }
    }

    /**
     * 命中测试：指针是否落在某条画线上（纯函数）。
     * 用于"点一下选中"——没有它就只能靠删除按钮，手感差很多。
     * @returns 命中的画线 id，没有则 null
     */
    function hitTestDrawings(shapes, svgX, svgY, tolerance, geo, scale) {
      const xC = (i) => geo.padL + (geo.plotW / geo.n) * (i + 0.5)
      const yP = (p) => geo.padT + (1 - (p - scale.minP) / scale.span) * geo.priceH
      const rect = { x0: geo.padL, x1: geo.padL + geo.plotW, y0: geo.padT, y1: geo.padT + geo.priceH }
      let best = null
      for (const s of shapes || []) {
        let d = null
        if (s.type === 'hline') {
          d = Math.abs(svgY - yP(s.price))
        } else if (s.type === 'marker' && s.points && s.points.length === 1) {
          const p = s.points[0]
          d = Math.hypot(svgX - xC(p.i), svgY - yP(p.price))
        } else if (s.type === 'trend' && s.points && s.points.length === 2) {
          // 必须按**延伸后的实际可见线段**判定：射线/直线延长出去的部分同样要能点中，
          // 否则"改成射线后只有原来那一小段能选中"（踩过）。
          const seg = extendLine(
            xC(s.points[0].i), yP(s.points[0].price),
            xC(s.points[1].i), yP(s.points[1].price),
            rect, s.ext || 'segment')
          if (seg) d = distanceToSegment(svgX, svgY, seg.x1, seg.y1, seg.x2, seg.y2)
        } else if (s.type === 'circle' && s.points && s.points.length === 2) {
          // 圆的判定：到**圆周**的距离，或落在圆心附近（空心圆内部不抢点击）
          const [c, e] = s.points
          const cx = xC(c.i); const cy = yP(c.price)
          const r = Math.abs(yP(e.price) - cy)
          const dist = Math.hypot(svgX - cx, svgY - cy)
          d = Math.min(Math.abs(dist - r), dist <= tolerance * 2 ? 0 : Infinity)
          if (!Number.isFinite(d)) d = Infinity
        }
        if (d === null || !Number.isFinite(d)) continue
        if (d <= tolerance && (best === null || d < best.d)) best = { id: s.id, d }
      }
      return best ? best.id : null
    }

    /**
     * 矩形框选：返回与框相交的图形 id 列表（纯函数）。
     *
     * 判定用"图形的包围盒与选框相交"，而不是逐点命中——
     * 框选的用途是**批量删除**，宁可多选一点也不要漏（漏了用户还得一个个点）。
     */
    function hitTestRect(shapes, rect, geo, scale) {
      const xC = (i) => geo.padL + (geo.plotW / geo.n) * (i + 0.5)
      const yP = (p) => geo.padT + (1 - (p - scale.minP) / scale.span) * geo.priceH
      const x0 = Math.min(rect.x0, rect.x1); const x1 = Math.max(rect.x0, rect.x1)
      const y0 = Math.min(rect.y0, rect.y1); const y1 = Math.max(rect.y0, rect.y1)
      const plot = { x0: geo.padL, x1: geo.padL + geo.plotW, y0: geo.padT, y1: geo.padT + geo.priceH }
      const out = []
      for (const s of shapes || []) {
        let box = null
        if (s.type === 'hline') {
          const y = yP(s.price)
          box = { x0: plot.x0, x1: plot.x1, y0: y, y1: y }
        } else if (s.type === 'marker' && s.points && s.points.length === 1) {
          const x = xC(s.points[0].i); const y = yP(s.points[0].price)
          box = { x0: x, x1: x, y0: y, y1: y }
        } else if (s.type === 'trend' && s.points && s.points.length === 2) {
          const seg = extendLine(
            xC(s.points[0].i), yP(s.points[0].price),
            xC(s.points[1].i), yP(s.points[1].price), plot, s.ext || 'segment')
          if (!seg) continue
          box = { x0: Math.min(seg.x1, seg.x2), x1: Math.max(seg.x1, seg.x2), y0: Math.min(seg.y1, seg.y2), y1: Math.max(seg.y1, seg.y2) }
        } else if (s.type === 'circle' && s.points && s.points.length === 2) {
          const cx = xC(s.points[0].i); const cy = yP(s.points[0].price)
          const r = Math.abs(yP(s.points[1].price) - cy)
          box = { x0: cx - r, x1: cx + r, y0: cy - r, y1: cy + r }
        }
        if (!box) continue
        // 包围盒与选框相交（含接触）
        if (box.x1 < x0 || box.x0 > x1 || box.y1 < y0 || box.y0 > y1) continue
        out.push(s.id)
      }
      return out
    }

    /** 点到线段的距离（纯函数） */
    function distanceToSegment(px, py, x1, y1, x2, y2) {
      const dx = x2 - x1
      const dy = y2 - y1
      const len2 = dx * dx + dy * dy
      if (len2 === 0) return Math.hypot(px - x1, py - y1)
      let t = ((px - x1) * dx + (py - y1) * dy) / len2
      t = Math.max(0, Math.min(1, t))
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
    }
    const CHART_VIEW = {
      min: 20,                       // 再少看不出结构
      max: BARS_BUFFER,
      default: 120,
      keyFactor: 1.25,               // 键盘缩放倍率（更明显）
      wheelFactor: 1.12,             // 滚轮缩放倍率（更细腻）
      pageRatio: 0.5,                // PageUp/Down 平移比例（半屏）
      countKey: 'stock-lab:chartCount',   // 记住缩放级别（证券软件也会记住）
    }

    /**
     * 把窗口夹进合法范围（纯函数）。
     * @param total 缓冲区实际根数
     */
    function clampView(view, total, cfg = CHART_VIEW) {
      const n = Number(total)
      if (!Number.isFinite(n) || n <= 0) return { count: 0, end: -1 }
      const want = Number(view && view.count)
      const hardMin = Math.min(cfg.min, n)
      const hardMax = Math.min(cfg.max, n)
      let count = Number.isFinite(want) ? Math.round(want) : Math.min(cfg.default, n)
      count = Math.min(hardMax, Math.max(hardMin, count))
      const wantEnd = Number(view && view.end)
      const end = Number.isFinite(wantEnd) ? Math.round(wantEnd) : n - 1
      // 右边缘至少要留下 count 根，且不能越过缓冲区末尾
      return { count, end: Math.min(n - 1, Math.max(count - 1, end)) }
    }

    /**
     * 把"用户意图"解成有效窗口（纯函数）。
     *
     * end < 0 是**哨兵值**，表示"跟随最新"：
     *   用户在最右端时不该钉死一个绝对下标，否则新交易日进来后画面就停在旧位置。
     *   只有在用户主动往左平移过之后，才记下绝对下标。
     */
    function resolveView(countWanted, endWanted, total) {
      const n = Number(total)
      const atLatest = !(Number.isFinite(endWanted) && endWanted >= 0)
      return clampView({ count: countWanted, end: atLatest ? (n > 0 ? n - 1 : -1) : endWanted }, total)
    }

    /** 窗口覆盖的下标区间（含两端，纯函数） */
    function sliceRange(view, total) {
      const v = clampView(view, total)
      if (v.count === 0) return { start: 0, end: -1 }
      return { start: Math.max(0, v.end - v.count + 1), end: v.end }
    }

    /** 把一条序列按窗口切片（纯函数，长度与可见根数一致） */
    function sliceSeries(arr, view, total) {
      const r = sliceRange(view, total)
      return Array.isArray(arr) ? arr.slice(r.start, r.end + 1) : []
    }

    /**
     * 缩放（纯函数）。
     * @param factor >1 缩小（看更多根），<1 放大（看更少根）
     * @param anchor 缩放的锚点下标（绝对值）。默认锚定右边缘；
     *               滚轮时锚定指针所在那根，这样"鼠标指着哪里，哪里就不动"——与看盘软件一致。
     */
    function zoomView(view, factor, total, anchor = null, cfg = CHART_VIEW) {
      const v = clampView(view, total)
      if (v.count === 0) return v
      const nextCount = Math.min(
        Math.min(cfg.max, total),
        Math.max(Math.min(cfg.min, total), Math.round(v.count * factor)),
      )
      if (nextCount === v.count) return v
      const at = Number.isFinite(anchor) ? Math.min(v.end, Math.max(v.end - v.count + 1, Math.round(anchor))) : v.end
      // 锚点相对右边缘的位置，在缩放前后按比例保持
      const distFromEnd = v.end - at
      const nextEnd = at + Math.round(distFromEnd * (nextCount / v.count))
      return clampView({ count: nextCount, end: nextEnd }, total)
    }

    /** 平移（纯函数）：delta 为正表示往更近（右）走 */
    function panView(view, delta, total, cfg = CHART_VIEW) {
      const v = clampView(view, total)
      if (v.count === 0) return v
      return clampView({ count: v.count, end: v.end + Math.round(delta) }, total)
    }

    /** 跳到最新 / 跳到最早（纯函数）。参数顺序与 panView/zoomView 保持一致：(view, 参数, total) */
    function jumpView(view, where, total) {
      const v = clampView(view, total)
      if (v.count === 0) return v
      const n = Number(total)
      return clampView({ count: v.count, end: where === 'first' ? v.count - 1 : n - 1 }, total)
    }

    /**
     * 画线的问题码（每条都要能被解释，不能静默丢弃）
     */
    const DRAW_ISSUE = {
      ADJUST: 'adjust-mismatch',      // 画线时的复权模式与当前图表不一致
      NO_DATE: 'date-not-found',      // 锚点日期不在当前数据范围内
      BAD: 'invalid',                 // 数据不合法
    }

    /**
     * 日期 → 缓冲区下标（精确匹配；找不到返回 -1）。
     * 之所以**不用序号**存锚点：序号会随根数变化、也会被新数据推移，
     * 用序号存的线换个根数就跑到别处，而且"看起来仍然正常"。
     */
    function indexOfDate(bars, date) {
      if (!Array.isArray(bars) || typeof date !== 'string') return -1
      for (let i = 0; i < bars.length; i++) {
        if (bars[i] && bars[i].time === date) return i
      }
      return -1
    }

    /**
     * 把两点确定的直线按延伸方式裁剪到画布矩形（纯函数）。
     *
     * 三种模式统一成"参数的取值范围"，再对矩形做 slab 裁剪：
     *   segment t∈[0,1] · ray t∈[0,∞) · line t∈(-∞,∞)
     * 返回裁剪后的两端点；完全不在画布内时返回 null（不画，而不是画到天外）。
     *
     * 为什么要裁剪：锚点投影后可能落在画布外（平移走了、或缩放到别处），
     * 不裁的话 SVG 里会出现一条坐标极端的线，部分浏览器渲染异常。
     */
    function extendLine(x1, y1, x2, y2, rect, mode = 'segment') {
      const dx = x2 - x1
      const dy = y2 - y1
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null
      let tMin = mode === 'segment' ? 0 : (mode === 'ray' ? 0 : -Infinity)
      let tMax = mode === 'segment' ? 1 : (mode === 'ray' ? Infinity : Infinity)
      // slab 裁剪：对 x 与 y 两个方向分别求 t 的允许区间，取交集
      const slabs = [[x1, dx, rect.x0, rect.x1], [y1, dy, rect.y0, rect.y1]]
      for (const [p, d, lo, hi] of slabs) {
        if (Math.abs(d) < 1e-9) {
          if (p < lo || p > hi) return null          // 平行且在界外 → 不相交
          continue
        }
        let t1 = (lo - p) / d
        let t2 = (hi - p) / d
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp }
        tMin = Math.max(tMin, t1)
        tMax = Math.min(tMax, t2)
      }
      if (!(tMax > tMin)) return null                 // 区间为空 → 不可见
      return {
        x1: x1 + dx * tMin, y1: y1 + dy * tMin,
        x2: x1 + dx * tMax, y2: y1 + dy * tMax,
      }
    }

    /** 构造草稿形状。**水平线必须同时带 price**——图表画 hline 用的是 s.price，
    只给 points 会得到 yP(undefined)=NaN、线根本不可见（这是踩过的 bug）。 */
    function draftFromPoint(type, points) {
      const d = { type, points, preview: true, ext: type === 'trend' ? 'ray' : null }
      if (type === 'hline' && points[0]) d.price = points[0].price
      return d
    }

    /** 幽灵提示：把"如果现在松手"的形状算出来（纯函数）。trend/circle 还差一个点，所以只显示吸附点。 */
    function ghostFromPoint(tool, p) {
      if (!tool || !p || !p.date || !Number.isFinite(p.price)) return null
      if (tool === 'hline') return { type: 'hline', price: p.price, ghost: true, points: [p] }
      // marker / trend / circle 的第一个点：只标出会吸附到哪根 K 线
      return { type: 'marker', points: [p], ghost: true }
    }

    /**
     * 浮动调色板的位置（纯函数）：贴着选中图形放，而不是丢在图表下方。
     * 各类型取一个"贴着它"的锚点，最后夹进画布内（免得跑到图外）。
     */
    function paletteAnchor(shape, geo, scale) {
      if (!shape) return null
      const xC = (i) => CHART_GEO.PAD_L + (geo.plotW / geo.n) * (i + 0.5)
      const yP = (p) => CHART_GEO.PAD_T + (1 - (p - scale.minP) / scale.span) * CHART_GEO.PRICE_H
      const OFF = 22          // 离图形上方多少（viewBox 单位，与 SVG 同一坐标系）
      let x = CHART_GEO.PAD_L + 8
      let y = CHART_GEO.PAD_T + OFF
      if (shape.type === 'hline') {
        y = yP(shape.price) - OFF
      } else if (shape.type === 'trend' && shape.points && shape.points.length === 2) {
        const [a, b] = shape.points
        x = (xC(a.i) + xC(b.i)) / 2 - PALETTE_W / 2
        y = (yP(a.price) + yP(b.price)) / 2 - OFF
      } else if (shape.type === 'circle' && shape.points && shape.points.length === 2) {
        const c = shape.points[0]
        x = xC(c.i) - PALETTE_W / 2
        y = yP(c.price) - Math.abs(yP(shape.points[1].price) - yP(c.price)) - OFF
      } else if (shape.type === 'marker' && shape.points && shape.points.length === 1) {
        x = xC(shape.points[0].i) + 12
        y = yP(shape.points[0].price) - OFF
      }
      const x0 = CHART_GEO.PAD_L + 2
      const x1 = CHART_GEO.PAD_L + geo.plotW - PALETTE_W
      const y0 = CHART_GEO.PAD_T + 2
      const y1 = CHART_GEO.PAD_T + CHART_GEO.PRICE_H - 16
      return { x: Math.min(Math.max(x, x0), x1), y: Math.min(Math.max(y, y0), y1) }
    }
    /** 浮动调色板宽度（viewBox 单位）：6 个色块 + 内边距 */
    const PALETTE_W = 108

    /** 把调色板位置夹进画布（纯函数，免得跑出图外点不到） */
    function clampPalette(pt, geo) {
      const x0 = CHART_GEO.PAD_L + 2
      const x1 = CHART_GEO.PAD_L + geo.plotW - PALETTE_W
      const y0 = CHART_GEO.PAD_T + 2
      const y1 = CHART_GEO.PAD_T + CHART_GEO.PRICE_H - 16
      return {
        x: Math.min(Math.max(pt.x, x0), Math.max(x0, x1)),
        y: Math.min(Math.max(pt.y, y0), Math.max(y0, y1)),
      }
    }

    /**
     * 把测幅的两点解析到当前窗口（纯函数）。
     *
     * ⚠️ 测幅点必须**按日期存、按日期解析**——和画线同一个道理。
     * 曾经存的是窗口下标，于是缩放/平移后同一下标指向另一根 K 线，**位置会漂**。
     * 日期不在当前缓冲区里就不画（不硬掰到别的日子）。
     */
    function resolveMeasure(measure, bars, windowStart) {
      if (!measure || !measure.a || !measure.b) return null
      const ia = indexOfDate(bars, measure.a.date)
      const ib = indexOfDate(bars, measure.b.date)
      if (ia < 0 || ib < 0) return null
      if (!Number.isFinite(measure.a.price) || !Number.isFinite(measure.b.price)) return null
      return {
        a: { i: ia - windowStart, price: measure.a.price, date: measure.a.date },
        b: { i: ib - windowStart, price: measure.b.price, date: measure.b.date },
      }
    }

    /**
     * 把画线解析成"可绘制的几何"（纯函数）。
     *
     * ⚠️ **必须把所有会影响渲染的字段都透传**（`color` / `ext` 曾在这里被丢掉，
     * 导致「颜色改了不变色」「趋势线预览是射线、画出来却是线段」「切换延伸方式没反应」
     * 三个症状——存都存对了，是渲染前被丢的）。
     * 新增字段时**同时**加一条"透传"测试，否则会静默失效。
     */
    function resolveDrawings(bars, windowStart, drawings, adjust) {
      const shapes = []
      const issues = []
      const list = Array.isArray(drawings) ? drawings : []
      /** 会参与渲染的附加字段，集中在一处透传，避免以后又漏 */
      const carry = (d) => ({
        label: d.label, reason: d.reason, color: d.color || null,
        ext: d.ext || null, noteId: d.noteId || null,
      })
      for (const d of list) {
        const label = d.label || d.type
        if (!d || !Array.isArray(d.anchors) || d.anchors.length === 0) {
          issues.push({ id: d && d.id, label, code: DRAW_ISSUE.BAD, message: '缺少锚点' })
          continue
        }
        // 复权模式不一致：**照画但明确标注**。
        // 不画会让人以为线丢了；不标注会让人以为它还对得上——两种都比标注更糟。
        const staleAdjust = d.adjust && adjust && d.adjust !== adjust
        if (staleAdjust) {
          issues.push({
            id: d.id, label, code: DRAW_ISSUE.ADJUST,
            message: `这条线是在「${d.adjust === 'qfq' ? '前复权' : d.adjust === 'hfq' ? '后复权' : '不复权'}」下画的，`
              + '当前图表用的是另一种复权模式，位置可能对不上',
          })
        }

        // hline 只需要价格（日期只是"什么时候画的"），所以日期缺失不影响它
        if (d.type === 'hline') {
          const price = Number(d.anchors[0] && d.anchors[0].price)
          if (!Number.isFinite(price)) {
            issues.push({ id: d.id, label, code: DRAW_ISSUE.BAD, message: '价格不合法' })
            continue
          }
          shapes.push({
            id: d.id, type: 'hline', price, staleAdjust, ...carry(d),
            anchors: [{ date: d.anchors[0].date, price }],
          })
          continue
        }

        // trend / circle / marker：每个锚点都要能定位到 K 线
        const pts = []
        let failed = false
        for (const a of d.anchors) {
          const abs = indexOfDate(bars, a && a.date)
          if (abs < 0) {
            issues.push({
              id: d.id, label, code: DRAW_ISSUE.NO_DATE,
              message: `锚点日期 ${a && a.date} 不在当前数据范围内（${bars.length} 根：${bars[0] ? bars[0].time : '-'} ~ ${bars.length ? bars.at(-1).time : '-'}）`,
            })
            failed = true
            break
          }
          pts.push({ i: abs - windowStart, price: Number(a.price), date: a.date })
        }
        if (failed) continue
        if (pts.some((p) => !Number.isFinite(p.price))) {
          issues.push({ id: d.id, label, code: DRAW_ISSUE.BAD, message: '价格不合法' })
          continue
        }
        shapes.push({
          id: d.id, type: d.type, points: pts, staleAdjust, ...carry(d),
          anchors: d.anchors,
        })
      }
      return { shapes, issues }
    }

    /** 把问题汇总成一句能读的话（供图表下方显示） */
    function summarizeDrawingIssues(issues) {
      const list = Array.isArray(issues) ? issues : []
      if (list.length === 0) return null
      const stale = list.filter((x) => x.code === DRAW_ISSUE.ADJUST).length
      const missing = list.filter((x) => x.code === DRAW_ISSUE.NO_DATE).length
      const bad = list.filter((x) => x.code === DRAW_ISSUE.BAD).length
      const parts = []
      if (missing) parts.push(`${missing} 条因锚点日期不在当前数据范围内未显示`)
      if (bad) parts.push(`${bad} 条数据不合法未显示`)
      if (stale) parts.push(`${stale} 条是在别的复权模式下画的（位置可能对不上）`)
      return parts.length ? parts.join('；') : `${list.length} 条画线有问题`
    }

    /**
     * 宽度提示是否显示（**纯函数，且被 useTransientHint 真正使用**）。
     *
     * 规则：拖动中一直显示；键盘微调时也显示；最后一次变化过去 sizeHintMs 之后隐藏。
     * 用户的要求是"别常驻、别一直灰着抢注意力"，所以初始状态（从未调整过）必须是**不显示**。
     */
    function shouldShowSizeHint(dragging, changedAt, now, delayMs) {
      if (dragging === true) return true
      if (!changedAt) return false          // 从未调整过 → 不显示
      return (now - changedAt) < delayMs
    }

    /**
     * "短暂显示"状态：调整时出现，停手 delayMs 后消失。
     * 计时器只负责在到点时触发一次重渲染，**判定本身走 shouldShowSizeHint**，
     * 避免出现"测试在测一条生产代码没用的规则"这种假覆盖。
     */
    function useTransientHint(active, value, delayMs) {
      const [changedAt, setChangedAt] = useState(0)
      const [, tick] = useState(0)
      const first = useRef(true)

      // 任何一次调整（拖动位移或键盘步进）都刷新时间戳；首次挂载不显示
      useEffect(() => {
        if (first.current) { first.current = false; return }
        setChangedAt(Date.now())
      }, [active, value])

      // 到点后重算一次，让提示消失
      useEffect(() => {
        if (active === true || !changedAt) return undefined
        const remain = Math.max(delayMs - (Date.now() - changedAt), 0)
        const t = setTimeout(() => tick((n) => n + 1), remain + 40)
        return () => clearTimeout(t)
      }, [active, changedAt, delayMs])

      return shouldShowSizeHint(active === true, changedAt, Date.now(), delayMs)
    }

    /**
     * 夹取右栏宽度（**纯函数**，便于离线测试）。
     *
     * 规则：
     *   1. 非有限数 → 回退到默认宽度
     *   2. 上限 = min(hardMax, 容器宽度 × maxRatio)；容器宽度未知时用 hardMax
     *   3. 上限不会低于 min（否则窄容器里会出现 min > max 的矛盾，导致宽度抖动）
     *   4. 结果夹在 [min, 上限] 之间，取整
     *
     * @param requested 期望宽度（px）
     * @param containerWidth 容器实际宽度（px，null/0 表示未知）
     */
    function clampPaneWidth(requested, containerWidth, cfg = RIGHT_PANE) {
      if (typeof requested !== 'number' || !Number.isFinite(requested)) return cfg.default
      const usable = typeof containerWidth === 'number' && Number.isFinite(containerWidth) && containerWidth > 0
      const ratioMax = usable ? Math.floor(containerWidth * cfg.maxRatio) : cfg.hardMax
      const max = Math.max(cfg.min, Math.min(cfg.hardMax, ratioMax))
      return Math.min(max, Math.max(cfg.min, Math.round(requested)))
    }

    /**
     * 首次进入时是否应自动收起右栏（纯函数，便于离线测试）。
     *
     * 条件（全部满足才收起）：
     *   1. 容器宽度已知且 > 0
     *   2. 容器宽度 < collapseBelow（默认 880px，此时三栏挤不下）
     *   3. 用户**从未**调整过（userAdjusted 不为真）
     *   4. 当前不是已经收起状态
     *
     * 为什么要第 3 条：窗口尺寸会变，若每次都自动收起，用户手动展开后
     * 一调整窗口就又收起来，会显得"它自己乱动"。
     */
    function shouldAutoCollapse(containerWidth, stored, cfg = RIGHT_PANE) {
      if (typeof containerWidth !== 'number' || !Number.isFinite(containerWidth) || containerWidth <= 0) return false
      if (containerWidth >= cfg.collapseBelow) return false
      if (stored && stored.userAdjusted) return false
      if (stored && stored.collapsed) return false
      return true
    }

    // 公式线的配色：**只用 DSH 主题 token**，不硬编码颜色 ——
    // 这样切换明暗主题时线色自动跟随（客户端测试也断言了代码里没有硬编码色值）。
    const FORMULA_COLORS = [
      'var(--dsw-alias-brand-primary)',
      'var(--dsw-alias-state-warn-primary)',
      'var(--dsw-alias-state-idle-primary)',
      'var(--dsw-alias-state-success-primary)',
      'var(--dsw-alias-state-error-primary)',
      'var(--dsw-alias-label-primary)',
    ]

    /**
     * 通达信绘图属性 → 主题 token。
     *
     * 注意：主题提供的可用颜色 token 是有限的（品牌色 + 四种状态色 + 两级文字色），
     * 因此通达信里的部分同义色会落到同一 token。这是**如实映射**，不是色相精确还原——
     * 想要精确还原通达信色板就得硬编码色值，那会破坏主题跟随，取舍后选择跟随主题。
     */
    const TDX_COLOR_ATTRS = {
      COLORRED: 'var(--dsw-alias-state-error-primary)',
      COLORGREEN: 'var(--dsw-alias-state-success-primary)',
      COLORYELLOW: 'var(--dsw-alias-state-warn-primary)',
      COLORBLUE: 'var(--dsw-alias-brand-primary)',
      COLORMAGENTA: 'var(--dsw-alias-brand-primary)',
      COLORCYAN: 'var(--dsw-alias-state-idle-primary)',
      COLORWHITE: 'var(--dsw-alias-label-primary)',
      COLORBLACK: 'var(--dsw-alias-label-secondary)',
      COLORGRAY: 'var(--dsw-alias-label-secondary)',
    }

    /** 通达信里"柱状/棒状"类绘图属性 → 用直方图渲染（如 MACD 的 COLORSTICK） */
    const HISTOGRAM_ATTRS = new Set(['COLORSTICK', 'VOLSTICK', 'STICKLINE', 'BARSTICK'])

    const CSS = `
.sl-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.sl-top{display:flex;align-items:center;gap:14px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;overflow-x:auto;white-space:nowrap}
.sl-idx{display:flex;flex-direction:column;gap:1px;min-width:96px}
.sl-idx-name{font-size:11px;color:var(--dsw-alias-label-secondary)}
.sl-idx-val{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}
.sl-idx-chg{font-size:11px;font-variant-numeric:tabular-nums}
.sl-sep{width:1px;height:28px;background:var(--dsw-alias-border-l1);flex:0 0 auto}
.sl-metric{display:flex;flex-direction:column;gap:1px;min-width:74px}
.sl-metric span{font-size:11px;color:var(--dsw-alias-label-secondary)}
.sl-metric b{font-size:13px;font-weight:600;font-variant-numeric:tabular-nums}
.sl-body{display:flex;flex:1 1 auto;min-height:0}
.sl-side{width:236px;flex:0 0 auto;border-right:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0}
.sl-search{padding:8px;border-bottom:1px solid var(--dsw-alias-border-l1);position:relative}
.sl-in{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 9px;font-size:12px}
.sl-sugg{position:absolute;left:8px;right:8px;top:100%;z-index:20;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;margin-top:3px;max-height:280px;overflow:auto;box-shadow:0 8px 24px rgba(0,0,0,.2)}
.sl-sugg-row{display:flex;justify-content:space-between;gap:8px;padding:6px 10px;cursor:pointer}
.sl-sugg-row:hover{background:var(--dsw-alias-bg-layer-2)}
.sl-list{flex:1 1 auto;overflow:auto;padding:6px}
.sl-item{display:flex;justify-content:space-between;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;cursor:pointer}
.sl-item:hover{background:var(--dsw-alias-bg-layer-2)}
.sl-item-on{background:var(--dsw-alias-bg-layer-2);outline:1px solid var(--dsw-alias-border-l2)}
.sl-code{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.sl-del{opacity:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;padding:0 3px}
.sl-item:hover .sl-del{opacity:1}
.sl-main{flex:1 1 auto;min-width:0;overflow:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}
/* ── 可拖拽的右栏（宽度用户自定：显示器与窗口尺寸各异） ── */
/* 热区 9px：太细不好抓；视觉线用 ::after 居中画细，做到「热区宽、线条细」 */
.sl-split{flex:0 0 auto;width:9px;cursor:col-resize;border:0;padding:0;background:transparent;position:relative;touch-action:none}
.sl-split::after{content:'';position:absolute;top:0;bottom:0;left:50%;transform:translateX(-50%);width:1px;background:var(--dsw-alias-border-l1)}
.sl-split:hover::after,.sl-split-on::after{background:var(--dsw-alias-brand-primary);width:2px}
.sl-split:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.sl-right{flex:0 0 auto;border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-layer-1);position:relative}
.sl-right-head{display:flex;align-items:center;gap:6px;padding:8px 8px 8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto;color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxs-12-font-size,12px);line-height:var(--dsw-font-xxs-12-line-height,16px)}
.sl-right-head b{font-weight:600;color:var(--dsw-alias-label-primary);font-size:var(--dsw-font-xs-strong-13-font-size,13px)}
.sl-right-body{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 12px}
.sl-right-foot{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1);padding:8px 10px}
.sl-rail{flex:0 0 auto;width:26px;border-left:1px solid var(--dsw-alias-border-l1);display:flex;flex-direction:column;align-items:center;padding-top:8px;background:var(--dsw-alias-bg-layer-1)}
.sl-rail-btn{border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:14px;padding:4px 2px;border-radius:4px}
.sl-rail-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.sl-dragging{user-select:none}
.sl-dragging *{cursor:col-resize!important}
.sl-drag-hint{font-size:10px;color:var(--dsw-alias-label-secondary);text-align:center;padding:2px 0}
.sl-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.sl-name{font-size:17px;font-weight:600}
.sl-px{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}
.sl-toolbar{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
/* 「画图」展开后的工具组：与周期/复权同处一行、靠右延续，用一条细分隔线划开 */
.sl-tool-palette{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding-left:8px;border-left:1px solid var(--dsw-alias-border-l1)}
/* 图表交互层：可聚焦以接键盘，并给出可见焦点环 */
.sl-stage{position:relative;outline:none}
.sl-stage:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,transparent);outline-offset:2px;border-radius:var(--dsw-radius-xs,4px)}
/* 画线模式下用十字光标（看盘软件的画线工具也是这个手感），并禁用文字选择免得拖动时选中文本 */
.sl-stage-draw{cursor:crosshair}
.sl-stage-draw,.sl-stage-draw *{user-select:none}
/* 画线说明编辑（选中一条线时出现） */
.sl-draw-edit{display:flex;gap:6px;align-items:center;margin:6px 0}
.sl-draw-input{
  box-sizing:border-box;padding:4px 8px;border-radius:var(--dsw-radius-sm,6px);
  border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);
  color:var(--dsw-alias-label-primary);
  font-size:var(--dsw-font-xxs-12-font-size,12px);
  font-family:var(--dsw-font-markdown-base-font-family,inherit);
}
.sl-draw-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.sl-draw-edit .sl-draw-input:not([style]){flex:1 1 auto;min-width:0}
/* 颜色色块：当前选中的加一圈边 */
.sl-swatch{
  width:16px;height:16px;padding:0;border-radius:999px;cursor:pointer;
  border:1px solid var(--dsw-alias-border-l2);
}
.sl-swatch-on{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
/* 可见根数：只在缩放/平移后短暂出现（常驻会持续分散注意力，与右栏宽度提示同一处理） */
.sl-view-hint{
  position:absolute;top:4px;left:10px;z-index:5;pointer-events:none;
  padding:2px 8px;border-radius:var(--dsw-radius-xl,16px);
  background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-primary);
  font-size:var(--dsw-font-xxxs-11-font-size,11px);
  line-height:var(--dsw-font-xxxs-11-line-height,16px);
  transition:opacity 200ms ease;
}
.sl-view-hint-off{opacity:0}
/* 非最新位置时的提示：看盘软件会告诉你"你正在看历史"。
   用次要文字色（而非警示色）：它是**常驻**的，用警示色会一直抢注意力；
   而它只在用户主动平移离开最新之后才出现，低调也不会被忽略。 */
.sl-view-sub{
  position:absolute;top:4px;right:10px;z-index:5;pointer-events:none;
  padding:2px 8px;border-radius:var(--dsw-radius-xl,16px);
  background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-secondary);
  font-size:var(--dsw-font-xxxs-11-font-size,11px);
  line-height:var(--dsw-font-xxxs-11-line-height,16px);
}
.sl-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 9px;cursor:pointer;font-size:12px}
.sl-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.sl-btn-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.sl-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}
.sl-card h4{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.sl-up{color:var(--dsw-alias-state-error-primary)}
.sl-down{color:var(--dsw-alias-state-success-primary)}
.sl-flat{color:var(--dsw-alias-label-secondary)}
.sl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:8px 14px}
.sl-m{display:flex;flex-direction:column;gap:1px}
.sl-m span{font-size:11px;color:var(--dsw-alias-label-secondary)}
.sl-m b{font-size:14px;font-weight:600;font-variant-numeric:tabular-nums}
.sl-note{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.7}
.sl-err{font-size:12px;color:var(--dsw-alias-state-error-primary);padding:8px 0}
.sl-anom{display:flex;gap:8px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:12px;line-height:1.6}
.sl-anom:last-child{border-bottom:0}
.sl-anom-kind{flex:0 0 auto;font-weight:600;color:var(--dsw-alias-state-warn-primary)}
/* ── 右栏 AI 对话 ──
 *
 * 目标是**与 DSH 原生对话界面观感一致**。做法不是自己编数值，而是直接用主题
 * 真正在用的那套词汇（这些变量由 dsh-client-ui-theme 的 client.js 定义，随用户
 * 字号等设置变化）：
 *   --dsw-font-markdown-*      助手消息的排版（与原生 markdown 渲染同一套）
 *   --dsw-font-xxs-12 / -xxxs-11
 *   --dsw-specific-bubble            对话气泡底色
 *   --dsw-specific-input-major       输入框底色
 *   --dsw-alias-button-info-fill     DSH 的蓝(#4176e6)，用于发送按钮
 *   --dsw-radius-md/lg/xl            圆角
 *   --dsw-alias-markdown-code-block  代码块底色
 *
 * ⚠️ 官方 Theme 契约只承诺 14 个 --dsw-alias-*；其余 400 个是主题包的内部词汇。
 *    因此除颜色外一律写 var(--token, 兜底值)：token 哪天改名，样式**退化为兜底值**
 *    而不是整体失效。颜色不写兜底（硬编码色值被测试禁止，且必须跟随明暗主题）。
 */
.sl-right-body.sl-chat-wrap{display:flex;flex-direction:column;overflow:hidden;padding:0}
/* 右栏**不加底色**，跟随 .sl-right 原来的 bg-layer-1(#fff)。
   曾试过用 --dsw-specific-sidebar-fill(#f9fafb) 模仿原生侧栏，
   但那一层浅灰会让用户气泡(#edf3fe)显得不够突出——去掉。 */
.sl-chat-log{flex:1 1 auto;min-height:0;overflow-y:auto;padding:var(--sl-chat-pad,12px);display:flex;flex-direction:column;gap:var(--sl-chat-gap,16px)}
.sl-chat-empty{padding:8px 2px;display:flex;flex-direction:column;gap:10px}
.sl-chat-sug{display:flex;flex-wrap:wrap;gap:8px}
.sl-chat-sug button{
  border:1px solid var(--dsw-alias-border-l1);background:transparent;
  color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-xl,16px);
  padding:6px 12px;cursor:pointer;text-align:left;
  font-size:var(--dsw-font-xxs-12-font-size,12px);
  line-height:var(--dsw-font-xxs-12-line-height,16px);
}
.sl-chat-sug button:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.sl-msg{display:flex;flex-direction:column;gap:6px}
/* 助手消息：与原生 markdown 正文同一套排版（含行高），因此看起来"像同一个应用" */
.sl-msg-body{
  font-family:var(--dsw-font-markdown-base-font-family,inherit);
  font-size:var(--dsw-font-markdown-base-font-size,13px);
  line-height:var(--dsw-font-markdown-base-line-height,20px);
  font-weight:var(--dsw-font-markdown-base-font-weight,400);
  white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary);
}
/* 用户消息：**右对齐**（与原生 DSH 一致），左侧刻意留出空白；不上角色标签 */
.sl-msg-user{align-items:flex-end}
.sl-msg-user .sl-msg-body{
  background:var(--dsw-specific-bubble);
  border-radius:var(--dsw-radius-lg,12px);
  padding:8px 12px;
  /* 收缩到内容宽度、但不撑满整行 —— 左边自然留出距离 */
  max-width:82%;
}
.sl-msg-assistant .sl-msg-body{padding:0 2px}
/* 工具调用摘要：一行、默认收起。保持"可审计"，但不挡在回答前面 */
.sl-turn{display:flex;flex-direction:column;gap:6px}
.sl-tools{display:flex;flex-direction:column;gap:6px}
.sl-tools-head{
  display:flex;align-items:center;gap:6px;width:100%;text-align:left;
  padding:3px 2px;border:0;background:transparent;cursor:pointer;
  color:var(--dsw-alias-label-tertiary);
  font-size:var(--dsw-font-xxxs-11-font-size,11px);
  line-height:var(--dsw-font-xxxs-11-line-height,16px);
}
.sl-tools-head:hover{color:var(--dsw-alias-label-secondary)}
.sl-tools-warn{color:var(--dsw-alias-state-warn-primary)}
.sl-tools-toggle{margin-left:auto;flex:0 0 auto;color:var(--dsw-alias-link)}
.sl-tools-body{display:flex;flex-direction:column;gap:6px;padding-left:2px}
.sl-tools-live{
  display:flex;align-items:center;gap:6px;
  color:var(--dsw-alias-label-tertiary);
  font-size:var(--dsw-font-xxxs-11-font-size,11px);
  line-height:var(--dsw-font-xxxs-11-line-height,16px);
}
/* 工具明细块 */
.sl-tool{
  border:1px solid var(--dsw-alias-border-l1);
  border-radius:var(--dsw-radius-md,8px);
  background:var(--dsw-alias-bg-layer-1);overflow:hidden;
}
.sl-tool-head{
  display:flex;align-items:center;gap:6px;padding:6px 10px;cursor:pointer;user-select:none;
  font-size:var(--dsw-font-xxxs-11-font-size,11px);
  line-height:var(--dsw-font-xxxs-11-line-height,16px);
}
.sl-tool-name{font-weight:600;color:var(--dsw-alias-brand-primary)}
.sl-tool-status{margin-left:auto;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.sl-tool-err{color:var(--dsw-alias-state-error-primary)}
.sl-tool-pre{
  margin:0;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-markdown-code-block);
  font-family:var(--dsw-font-markdown-code-block-font-family,ui-monospace,Consolas,monospace);
  font-size:var(--dsw-font-markdown-code-block-font-size,11px);
  line-height:var(--dsw-font-markdown-code-block-line-height,1.5);
  color:var(--dsw-alias-label-secondary);
  white-space:pre-wrap;word-break:break-all;max-height:240px;overflow:auto;
}
.sl-stream-cursor{
  display:inline-block;width:6px;height:calc(var(--dsw-font-markdown-base-line-height,20px) - 6px);
  background:var(--dsw-alias-brand-primary);vertical-align:-2px;
  animation:sl-blink 1s steps(2,start) infinite;
}
@keyframes sl-blink{to{visibility:hidden}}
.sl-chat-status{
  display:flex;align-items:center;gap:6px;min-height:16px;
  font-size:var(--dsw-font-xxxs-11-font-size,11px);
  line-height:var(--dsw-font-xxxs-11-line-height,16px);
  color:var(--dsw-alias-label-tertiary);
}
.sl-chat-foot{display:flex;flex-direction:column;gap:8px}
.sl-chat-input{
  width:100%;box-sizing:border-box;
  /* 关掉原生 resize：它的手柄是右下角的小三角，既别扭又与"拖上边缘"的直接操作不一致 */
  resize:none;
  padding:8px 10px;
  border-radius:var(--dsw-radius-lg,12px);
  border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-specific-input-major);
  color:var(--dsw-alias-label-primary);
  font-family:var(--dsw-font-markdown-base-font-family,inherit);
  font-size:var(--dsw-font-markdown-base-font-size,13px);
  line-height:var(--dsw-font-markdown-base-line-height,20px);
}
.sl-chat-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) var(--dsw-focus-ring-color,transparent)}
.sl-chat-input:disabled{opacity:.6;cursor:not-allowed}
/* 复合输入框：外层定位，按钮绝对定位在右下角内侧（与原生一致的"箭头在框里"） */
.sl-composer{position:relative;display:block}
.sl-composer .sl-chat-input{padding-right:44px}
/* 上边缘拖拽条：平时是一条很淡的短横线，hover/拖动时变亮；往上拖 = 变高（边缘跟手） */
.sl-composer-grip{
  height:10px;display:flex;align-items:center;justify-content:center;
  cursor:row-resize;touch-action:none;border-radius:var(--dsw-radius-xs,4px);
}
.sl-composer-grip::after{
  content:'';width:30px;height:2px;border-radius:999px;
  background:var(--dsw-alias-border-l2);transition:background 200ms ease,width 200ms ease;
}
.sl-composer-grip:hover::after,.sl-composer-grip-on::after{background:var(--dsw-alias-brand-primary);width:44px}
.sl-composer-grip:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,transparent);outline-offset:-2px}
.sl-composer-btn{
  position:absolute;right:8px;bottom:8px;
  width:30px;height:30px;padding:0;border:0;
  display:flex;align-items:center;justify-content:center;
  border-radius:999px;cursor:pointer;
  /*
   * 用 --dsw-alias-button-info-fill(#4176e6) —— 这才是 DSH 的蓝。
   * 之前用 button-primary-fill 是错的：它在本主题里解析成 brand-primary = #0f1115(近黑)，
   * 而原生发送按钮是 DeepSeek 蓝。名字叫"primary"不代表它就是那个蓝，必须查实际值。
   * 前景固定用静态白(#fff)：蓝底白图标在明暗主题下都成立。
   */
  background:var(--dsw-alias-button-info-fill,var(--dsw-alias-link));
  color:var(--dsw-static-neutral-bluish-00,#fff);
  transition:background 200ms ease,color 200ms ease;
}
.sl-composer-btn:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,var(--dsw-alias-button-info-fill))}
/*
 * 禁用态：**必须同时改前景色与背景色**，而且要按实际色值挑，不能凭 token 名字猜。
 *
 * 踩过两次坑（都表现为"按钮不清晰"）：
 *   1) 只换背景不改 color → 白箭头(#fff) 画在浅灰圆(#ebeef2) 上
 *   2) 改用 --dsw-alias-label-dimmed → 它是 #e1e5ee，与背景 #ebeef2 **几乎同色**，
 *      对比度只有 1.10，等于完全看不见。
 *      （这个 token 是给"浅色背景/遮罩"用的，不是给文字用的——名字看不出来，只能查值）
 *
 * 现在用 --dsw-alias-label-secondary(#61666b)：在 #ebeef2 上对比度 ≈4.97，清晰可读；
 * 同时仍比启用态（白箭头 + 近黑圆 #0f1115）低调，两种状态一眼能区分。
 */
.sl-composer-btn:disabled{
  background:var(--dsw-alias-button-primary-dimmed);
  color:var(--dsw-alias-label-secondary);
  cursor:not-allowed;opacity:1;
}
.sl-composer-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,transparent);outline-offset:2px}

/* ── markdown 渲染（助手消息）：拿到原生排版 token，同时给出必要结构 ── */
.sl-msg-body > *:first-child{margin-top:0}
.sl-md-p{margin:0 0 8px}
.sl-md-p:last-child{margin-bottom:0}
.sl-md-h{font-weight:600;margin:10px 0 6px;color:var(--dsw-alias-label-primary)}
.sl-md-h1{font-size:calc(var(--dsw-font-markdown-base-font-size,13px) + 4px)}
.sl-md-h2{font-size:calc(var(--dsw-font-markdown-base-font-size,13px) + 2px)}
.sl-md-h3,.sl-md-h4{font-size:var(--dsw-font-markdown-base-font-size,13px)}
.sl-md-ul,.sl-md-ol{margin:0 0 8px;padding-left:20px}
.sl-md-ul li,.sl-md-ol li{margin:2px 0}
.sl-md-quote{
  margin:0 0 8px;padding:4px 10px;border-left:2px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-secondary);
}
.sl-md-hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:10px 0}
.sl-md-code{
  padding:1px 5px;border-radius:var(--dsw-radius-xs,4px);
  background:var(--dsw-alias-markdown-inline-code);
  font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,Consolas,monospace);
  font-size:var(--dsw-font-markdown-code-font-size,12px);
}
.sl-md-pre{
  margin:0 0 8px;padding:8px 10px;overflow:auto;
  border-radius:var(--dsw-radius-md,8px);
  background:var(--dsw-alias-markdown-code-block);
  font-family:var(--dsw-font-markdown-code-block-font-family,ui-monospace,Consolas,monospace);
  font-size:var(--dsw-font-markdown-code-block-font-size,11px);
  line-height:var(--dsw-font-markdown-code-block-line-height,1.5);
}
.sl-md-table{border-collapse:collapse;margin:0 0 8px;width:100%;font-size:var(--dsw-font-xxs-12-font-size,12px)}
.sl-md-table th,.sl-md-table td{border:1px solid var(--dsw-alias-border-l1);padding:3px 7px;text-align:left}
.sl-md-table th{background:var(--dsw-alias-bg-layer-2);font-weight:600}
.sl-md-link{color:var(--dsw-alias-link)}
.sl-md-link:hover{text-decoration:underline}
.sl-chat-disclaimer{
  font-size:var(--dsw-font-xxxs-11-font-size,11px);
  line-height:var(--dsw-font-xxxs-11-line-height,16px);
  color:var(--dsw-alias-label-tertiary);
}
/* 宽度提示：只在拖动/键盘调整时出现，停手 3 秒后淡出（不做常驻，避免持续分散注意力） */
.sl-pane-size{
  position:absolute;top:6px;right:10px;z-index:5;pointer-events:none;
  padding:2px 8px;border-radius:var(--dsw-radius-xl,16px);
  background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);
  color:var(--dsw-alias-label-primary);
  font-size:var(--dsw-font-xxxs-11-font-size,11px);
  line-height:var(--dsw-font-xxxs-11-line-height,16px);
  transition:opacity 200ms ease;
}
.sl-pane-size-off{opacity:0}
/* ── 公式选股（T5.7）：进度条与结果表 ──
 * 只用主题 token：进度条轨道/填充都跟随明暗主题，不写死颜色。 */
.sl-screen-bar{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin:4px 0 8px}
.sl-screen-bar-fill{height:100%;background:var(--dsw-alias-brand-primary);border-radius:999px;transition:width 200ms ease}
.sl-screen-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}
.sl-screen-table th{text-align:left;font-weight:600;color:var(--dsw-alias-label-secondary);font-size:11px;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap}
.sl-screen-table td{padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums}
.sl-screen-table tbody tr{cursor:pointer}
.sl-screen-table tbody tr:hover{background:var(--dsw-alias-bg-layer-2)}
`

    // ─────────────────────────── 工具函数 ───────────────────────────
    async function apiFetch(path, params) {
      const qs = params ? '?' + new URLSearchParams(params).toString() : ''
      const res = await fetch(API + path + qs, { headers: { accept: 'application/json' } })
      const json = await res.json()
      if (!json.ok) throw new Error(json.error || '请求失败')
      return json.data
    }
    const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(d))
    const fmtPct = (v) => (v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%')
    const fmtBig = (v) => {
      if (v === null || v === undefined) return '—'
      const n = Math.abs(v)
      if (n >= 1e12) return (v / 1e12).toFixed(2) + '万亿'
      if (n >= 1e8) return (v / 1e8).toFixed(2) + '亿'
      if (n >= 1e4) return (v / 1e4).toFixed(2) + '万'
      return String(Math.round(v))
    }
    const cls = (v) => (v > 0 ? 'sl-up' : v < 0 ? 'sl-down' : 'sl-flat')

    function useLocal(key, initial) {
      const [v, setV] = useState(() => {
        try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : initial } catch { return initial }
      })
      const set = useCallback((next) => {
        setV(next)
        try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* ignore */ }
      }, [key])
      return [v, set]
    }

    // ─────────────────────────── 可拖拽右栏 ───────────────────────────
    /**
     * 右栏宽度：用户可拖拽 / 键盘调整 / 双击复位，并跨会话记住。
     *
     * 之所以做成可调而不是固定：显示器宽度千差万别，DSH 窗口也未必最大化，
     * 固定宽度在窄窗口里会把中间的图表挤得没法看，在超宽屏上又浪费空间。
     *
     * @param bodyRef 容器引用（用于按容器宽度夹取上限）
     */
    function useResizablePane(bodyRef) {
      const [stored, setStored] = useLocal(RIGHT_PANE.storageKey, {
        width: RIGHT_PANE.default,
        collapsed: false,
      })
      const [dragging, setDragging] = useState(false)
      // 拖动过程中的临时宽度（不落盘，避免每帧写 localStorage）
      const [draft, setDraft] = useState(null)

      const containerWidth = () => {
        try {
          const el = bodyRef?.current
          if (!el || typeof el.getBoundingClientRect !== 'function') return null
          const w = el.getBoundingClientRect().width
          return w > 0 ? w : null
        } catch { return null }
      }

      /** 按容器宽度与硬上限夹取（纯逻辑见 clampPaneWidth） */
      const clamp = useCallback((px) => {
        let cw = null
        try {
          const el = bodyRef?.current
          if (el && typeof el.getBoundingClientRect === 'function') {
            const w = el.getBoundingClientRect().width
            if (w > 0) cw = w
          }
        } catch { cw = null }
        return clampPaneWidth(px, cw)
      }, [bodyRef])

      const width = clamp(draft ?? stored.width)

      const persisted = {
        width,
        collapsed: stored.collapsed === true,
        dragging,
        containerWidth: containerWidth(),
      }

      const commit = (px) => setStored({ ...stored, width: clamp(px), userAdjusted: true })
      const setCollapsed = (v) => setStored({ ...stored, collapsed: v === true, userAdjusted: true })
      const reset = () => setStored({ ...stored, width: RIGHT_PANE.default, userAdjusted: true })

      /**
       * 首次进入且容器很窄时自动收起右栏（用户可以再展开）。
       *
       * 只做一次、且**只在用户从未调整过时**做：一旦用户自己拖过或收展过
       * （`userAdjusted`），就绝不再自动改变，免得"它自己变来变去"。
       * 逻辑抽成纯函数 `shouldAutoCollapse` 以便离线测试。
       */
      useEffect(() => {
        if (stored.userAdjusted) return
        if (stored.collapsed) return
        const cw = containerWidth()
        if (!shouldAutoCollapse(cw, stored)) return
        setStored({ ...stored, collapsed: true, autoCollapsed: true })
      }, [])

      /** 指针拖拽：以容器右边缘为基准换算宽度（右栏贴右，拖的是它的左边界） */
      const onPointerDown = (e) => {
        try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* ignore */ }
        setDragging(true)
        setDraft(width)
      }
      const onPointerMove = (e) => {
        if (!dragging) return
        const cw = containerWidth()
        if (!cw) return
        try {
          const rect = bodyRef.current.getBoundingClientRect()
          setDraft(clamp(rect.right - e.clientX))
        } catch { /* ignore */ }
      }
      const endDrag = () => {
        if (!dragging) return
        setDragging(false)
        if (draft !== null) commit(draft)
        setDraft(null)
      }
      const onKeyDown = (e) => {
        const step = e.shiftKey ? RIGHT_PANE.step * 4 : RIGHT_PANE.step
        if (e.key === 'ArrowLeft') { e.preventDefault(); commit(width + step) }
        else if (e.key === 'ArrowRight') { e.preventDefault(); commit(width - step) }
        else if (e.key === 'Home') { e.preventDefault(); commit(RIGHT_PANE.min) }
        else if (e.key === 'End') { e.preventDefault(); commit(RIGHT_PANE.hardMax) }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reset() }
      }

      return { ...persisted, onPointerDown, onPointerMove, endDrag, onKeyDown, reset, setCollapsed, min: RIGHT_PANE.min, max: RIGHT_PANE.hardMax, defaultWidth: RIGHT_PANE.default }
    }

    /** 右栏与分隔条。collapsed 时收成一条竖条，只留展开按钮。 */
    // ─────────────────────────── 右栏 AI 对话 ───────────────────────────
    //
    // 设计要点（与宿主侧 chat-service 对应）：
    //   · 右栏是**当前标的会话的一个视图**：切标的就切会话；没有会话就显示"还没有对话"，
    //     绝不预建（懒创建）。
    //   · 流式通过 /chat/stream 的 SSE 逐段显示；工具调用单独成块，能看出"调了什么、拿到什么"。
    //   · 切标的时**不打断**正在进行的回答：它属于上一个标的，服务端会照样落库，
    //     切回去就能看到。这里只停止显示并如实提示。
    //   · 免责声明常驻，不是每条消息重复。

    const CHAT_SUGGESTIONS = [
      '这只股票最近怎么了？',
      '它和大盘比是强还是弱？',
      '最近资金是流入还是流出？',
      '有哪些值得注意的异常？',
    ]

    /** 解析 SSE：缓冲区切帧，逐条 data: 交给回调 */
    function makeSseParser(onEvent) {
      let buf = ''
      return (chunkText) => {
        buf += chunkText
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            const raw = line.slice(5).trim()
            if (raw === '') continue
            try { onEvent(JSON.parse(raw)) } catch { /* 无法解析的帧就跳过，不让它中断整个流 */ }
          }
        }
      }
    }

    /**
     * 行内 markdown → React 元素。
     *
     * 处理顺序很重要：**先代码，再图片/链接，再粗体，最后斜体**。
     * 否则 `` `a **b** c` `` 里的 `**` 会被误当作粗体标记。
     *
     * 不支持的内容**原样作为文本输出**，绝不吞掉——宁可少渲染，不可丢内容。
     */
    function renderInline(text, keyPrefix = 'i') {
      const out = []
      let rest = String(text ?? '')
      let n = 0
      const push = (node) => { out.push(node) }

      while (rest !== '') {
        // 找出各标记里"最早出现"的那个，保证按原文顺序切分
        const cands = []
        const codeM = /`([^`]+)`/.exec(rest)
        if (codeM) cands.push({ at: codeM.index, kind: 'code', m: codeM })
        const linkM = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest)
        if (linkM) cands.push({ at: linkM.index, kind: 'link', m: linkM })
        const boldM = /\*\*([^*]+)\*\*/.exec(rest)
        if (boldM) cands.push({ at: boldM.index, kind: 'bold', m: boldM })
        // 斜体：用 lookbehind/lookahead 排除 ** 与 _word_ 这类误匹配
        // （早期版本用"吞掉前一个字符"的办法处理前导，结果切片偏移算错、会多吃一个字符）
        const italM = /(?<!\*)\*([^*\n]+)\*(?!\*)/.exec(rest)
        if (italM) cands.push({ at: italM.index, kind: 'ital', m: italM })
        const underM = /(?<![\w*])_([^_\n]+)_(?![\w*])/.exec(rest)
        if (underM) cands.push({ at: underM.index, kind: 'ital', m: underM })

        if (cands.length === 0) break
        cands.sort((a, b) => a.at - b.at)
        const c = cands[0]
        if (c.at > 0) push(rest.slice(0, c.at))

        const k = keyPrefix + 'n' + (n++)
        if (c.kind === 'code') {
          push(h('code', { key: k, className: 'sl-md-code' }, c.m[1]))
        } else if (c.kind === 'link') {
          const href = c.m[2]
          // 只允许 http/https：模型给的其它协议（如 javascript:）不生成可点击链接
          const safe = /^https?:\/\//i.test(href)
          push(safe
            ? h('a', { key: k, className: 'sl-md-link', href, target: '_blank', rel: 'noreferrer noopener' },
              renderInline(c.m[1], k + 't'))
            : h('span', { key: k }, c.m[0]))          // 不安全就原样显示，不丢内容
        } else if (c.kind === 'bold') {
          push(h('strong', { key: k }, renderInline(c.m[1], k + 't')))
        } else {
          push(h('em', { key: k }, renderInline(c.m[1], k + 't')))
        }
        rest = rest.slice(c.at + c.m[0].length)
      }
      if (rest !== '') push(rest)
      return out
    }

    /** 表格行：`| a | b |` / `|---|---|` */
    const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line)
    const isTableSep = (line) => /^\s*\|[\s:|-]+\|\s*$/.test(line)
    const splitRow = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim())

    /**
     * 极简 markdown → React 元素数组。
     *
     * 为什么自己写：客户端 bundle 只能 require('react')（没有 UI 组件库可复用），
     * 而**绝不能用 dangerouslySetInnerHTML**——模型输出属于不可信内容，拼 HTML 会引入注入风险。
     * 因此只覆盖助手实际会输出的子集，并且**认不出来的行原样输出**。
     */
    function renderMarkdown(text) {
      const src = String(text ?? '')
      const lines = src.split('\n')
      const blocks = []
      let i = 0
      let key = 0
      const K = () => 'md' + (key++)

      while (i < lines.length) {
        const line = lines[i]

        // 围栏代码块
        const fence = /^\s*```(\w*)\s*$/.exec(line)
        if (fence) {
          const lang = fence[1] || ''
          const buf = []
          i++
          while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i++ }
          i++   // 跳过收尾围栏
          blocks.push(h('pre', { key: K(), className: 'sl-md-pre' },
            h('code', null, buf.join('\n'))))
          void lang
          continue
        }

        // 标题
        const head = /^(#{1,4})\s+(.*)$/.exec(line)
        if (head) {
          const lv = head[1].length
          blocks.push(h('div', { key: K(), className: 'sl-md-h sl-md-h' + lv }, renderInline(head[2], 'h')))
          i++
          continue
        }

        // 分隔线
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          blocks.push(h('hr', { key: K(), className: 'sl-md-hr' }))
          i++
          continue
        }

        // 表格：表头 + 分隔行 + 数据行
        if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
          const head = splitRow(line)
          i += 2
          const rows = []
          while (i < lines.length && isTableRow(lines[i])) { rows.push(splitRow(lines[i])); i++ }
          blocks.push(h('table', { key: K(), className: 'sl-md-table' },
            h('thead', null, h('tr', null, head.map((c, ci) => h('th', { key: 'th' + ci }, renderInline(c, 'th' + ci))))),
            h('tbody', null, rows.map((r, ri) => h('tr', { key: 'tr' + ri },
              r.map((c, ci) => h('td', { key: 'td' + ci }, renderInline(c, 'td' + ci))))))
          ))
          continue
        }

        // 引用
        if (/^\s*>\s?/.test(line)) {
          const buf = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
          blocks.push(h('div', { key: K(), className: 'sl-md-quote' }, renderInline(buf.join(' '), 'q')))
          continue
        }

        // 无序列表
        if (/^\s*[-*+]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++
          }
          blocks.push(h('ul', { key: K(), className: 'sl-md-ul' },
            items.map((it, ii) => h('li', { key: 'li' + ii }, renderInline(it, 'li' + ii)))))
          continue
        }

        // 有序列表
        if (/^\s*\d+[.)]\s+/.test(line)) {
          const items = []
          while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*\d+[.)]\s+/, '')); i++
          }
          blocks.push(h('ol', { key: K(), className: 'sl-md-ol' },
            items.map((it, ii) => h('li', { key: 'li' + ii }, renderInline(it, 'li' + ii)))))
          continue
        }

        // 空行：跳过（段间距由 CSS 的 gap 提供）
        if (/^\s*$/.test(line)) { i++; continue }

        // 普通段落：连续的普通行合成一段，段内保留换行
        const buf = []
        while (i < lines.length
          && !/^\s*$/.test(lines[i])
          && !/^\s*```/.test(lines[i])
          && !/^(#{1,4})\s+/.test(lines[i])
          && !/^\s*>\s?/.test(lines[i])
          && !/^\s*[-*+]\s+/.test(lines[i])
          && !/^\s*\d+[.)]\s+/.test(lines[i])
          && !isTableRow(lines[i])) {
          buf.push(lines[i]); i++
        }
        const joined = buf.join('\n')
        const kids = renderInline(joined, 'p')
        if (kids.length > 0) blocks.push(h('p', { key: K(), className: 'sl-md-p' }, kids))
      }

      return blocks
    }

    /** 每条工具记录：展开/折叠看完整返回 */
    function ToolCall({ item }) {
      const [open, setOpen] = useState(false)
      const argsText = item.argsRaw || (item.args ? JSON.stringify(item.args) : '')
      return h('div', { className: 'sl-tool' },
        h('div', {
          className: 'sl-tool-head', onClick: () => setOpen(!open),
          title: open ? '收起' : '展开查看工具返回',
        },
          h('span', null, item.pending ? '⏳' : item.isError ? '⚠️' : '🔧'),
          h('span', { className: 'sl-tool-name' }, item.name),
          h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: '10.5px' } },
            argsText.length > 60 ? argsText.slice(0, 60) + '…' : argsText),
          h('span', { className: 'sl-tool-status' + (item.isError ? ' sl-tool-err' : '') },
            item.pending ? '调用中…' : item.isError ? '失败（已回灌给模型）' : (open ? '收起' : '展开'))
        ),
        open && item.text
          ? h('pre', { className: 'sl-tool-pre' }, item.text)
          : null
      )
    }

    /**
     * 把落库的消息按"轮次"分组：一条用户提问 + 其间的工具调用 + 助手回答。
     *
     * 为什么必须分组：工具返回是**中间过程**，不是给用户看的内容——
     * 直接铺在回答前面就是噪音（用户的反馈）。但它也不能完全丢掉：
     * "数字来自工具调用"是本项目的信任基础，而且**工具失败必须看得见**。
     * 所以把同一轮的工具折进助手回答下面的一行摘要（默认收起、可展开看明细）。
     */
    function groupMessages(msgs) {
      const groups = []
      let cur = null
      for (const m of msgs || []) {
        if (m.role === 'user') {
          cur = { id: 'g' + (m.id || m.seq), user: m, tools: [], assistant: null }
          groups.push(cur)
          continue
        }
        if (cur === null) {
          // 历史里第一条不是用户消息（例如只有助手回答）：也单独成组，不丢内容
          cur = { id: 'g' + (m.id || m.seq), user: null, tools: [], assistant: null }
          groups.push(cur)
        }
        if (m.role === 'tool') cur.tools.push(m)
        else if (m.role === 'assistant') cur.assistant = m
      }
      return groups
    }

    /** 把落库的工具消息映射成 ToolCall 需要的形状 */
    function toolItemOf(m) {
      const tc = Array.isArray(m.toolCalls) && m.toolCalls.length ? m.toolCalls[0] : null
      return {
        name: tc ? tc.name : '(未知工具)',
        argsRaw: tc ? (tc.argsRaw || (tc.args ? JSON.stringify(tc.args) : '')) : '',
        isError: tc ? tc.isError === true : false,
        text: m.content,
      }
    }

    /**
     * 工具调用摘要：**一行、默认收起**。
     * 只有用户主动点"明细"才展开参数与原始返回——保持"可审计"但不挡路。
     */
    function ToolGroup({ tools }) {
      const [open, setOpen] = useState(false)
      if (!tools || tools.length === 0) return null
      const items = tools.map(toolItemOf)
      const failed = items.filter((x) => x.isError).length
      // 不列举工具名：点"明细"就能看到是哪些工具（含参数与原始返回）。
      // 放在这一行里只是重复信息，还把这一行撑长了。
      return h('div', { className: 'sl-tools' },
        h('button', {
          className: 'sl-tools-head' + (failed > 0 ? ' sl-tools-warn' : ''),
          onClick: () => setOpen(!open),
          title: open ? '收起工具明细' : '查看工具明细（哪些工具、参数与原始返回）',
        },
          h('span', { 'aria-hidden': 'true' }, '🔧'),
          h('span', null, failed > 0
            ? `使用了 ${items.length} 个工具，其中 ${failed} 个失败`
            : `使用了 ${items.length} 个工具`),
          h('span', { className: 'sl-tools-toggle' }, open ? '收起' : '明细')
        ),
        open
          ? h('div', { className: 'sl-tools-body' },
            items.map((it, i) => h(ToolCall, { key: 'ti' + i, item: it })))
          : null
      )
    }

    /** 停止按钮与发送按钮共用配色（原生也是同一个按钮换图标），只换图形 */
    function SendGlyph({ stopping }) {
      return stopping
        ? h('svg', { viewBox: '0 0 12 12', width: 12, height: 12, 'aria-hidden': 'true' },
          h('rect', { x: 3, y: 3, width: 6, height: 6, rx: 1.2, fill: 'currentColor' }))
        : h('svg', { viewBox: '0 0 12 12', width: 14, height: 14, 'aria-hidden': 'true' },
          h('path', {
            d: 'M6 10V2.6M2.8 5.6L6 2.4l3.2 3.2',
            fill: 'none', stroke: 'currentColor', strokeWidth: 1.7,
            strokeLinecap: 'round', strokeLinejoin: 'round',
          }))
    }

    function MessageBlock({ m }) {
      // **不再标角色**：用户消息是右对齐气泡、助手是左对齐正文，一眼可分，
      // 再加一行"我 / AI 研究助手"只是噪音（用户明确要求去掉）。
      const isUser = m.role === 'user'
      return h('div', { className: 'sl-msg sl-msg-' + m.role },
        h('div', { className: 'sl-msg-body' },
          // 助手回答按 markdown 渲染（模型就是这么输出的）；
          // 用户消息保持纯文本 —— 用户打的是普通文字，当 markdown 解析会误伤（比如下划线、星号）
          isUser ? m.content : renderMarkdown(m.content))
      )
    }

    function ChatPane({ symbol, symbolName, pane }) {
      const [msgs, setMsgs] = useState([])          // 已落库的消息（服务端为权威）
      const [loaded, setLoaded] = useState(false)
      const [draft, setDraft] = useState('')
      const [run, setRun] = useState(null)          // { runId, symbol }
      const [live, setLive] = useState('')          // 正在流式输出的文本
      const [tools, setTools] = useState([])        // 本轮工具调用
      const [error, setError] = useState(null)
      const [info, setInfo] = useState(null)        // 模型 / 工具数
      const [note, setNote] = useState(null)        // 非错误提示（如"上一个标的仍在回答"）
      const logRef = useRef(null)
      const abortRef = useRef(null)
      const runSymbolRef = useRef(null)
      const composerRef = useRef(null)
      const composer = useComposerResize(composerRef)

      // 实例能力（模型、工具数）——如实展示"是谁在回答、能用哪些工具"
      useEffect(() => {
        let alive = true
        apiFetch('/chat/info').then((d) => { if (alive) setInfo(d) }).catch(() => { })
        return () => { alive = false }
      }, [])

      // 换标的 → 载入该标的的会话。**只是读取，不创建**（懒创建）
      useEffect(() => {
        let alive = true
        setError(null); setLive(''); setTools([]); setLoaded(false)
        apiFetch('/chat/messages', { symbol, limit: 200 })
          .then((d) => {
            if (!alive) return
            setMsgs(d.messages || [])
            setNote(d.thread ? null : null)
          })
          .catch((e) => { if (alive) setError(e.message) })
          .finally(() => { if (alive) setLoaded(true) })
        return () => { alive = false }
      }, [symbol])

      // 自动滚到底（新消息 / 流式增量时）
      useEffect(() => {
        const el = logRef.current
        if (el) el.scrollTop = el.scrollHeight
      }, [msgs, live, tools])

      const streaming = run !== null
      const runForThisSymbol = streaming && run.symbol === symbol
      const backgroundSymbol = streaming && run.symbol !== symbol ? run.symbol : null

      /** 发送：先乐观显示用户消息，再开 SSE 收流 */
      const send = async (textOverride) => {
        const text = String(textOverride ?? draft).trim()
        if (text === '' || streaming) return
        setDraft('')
        setError(null)
        setNote(null)
        setLive('')
        setTools([])
        // 乐观显示（服务端也会落库，最终以服务端为准重新载入）
        setMsgs((prev) => [...prev, { id: 'pending-' + Date.now(), role: 'user', content: text, seq: -1, pending: true }])
        const sendSymbol = symbol
        runSymbolRef.current = sendSymbol
        try {
          const r = await fetch(API + '/chat/send', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ symbol: sendSymbol, text }),
          }).then((x) => x.json())
          if (!r.ok) throw new Error(r.error || '发送失败')
          const runId = r.data.runId
          setRun({ runId, symbol: sendSymbol })

          const ac = new AbortController()
          abortRef.current = ac
          const res = await fetch(API + '/chat/stream?runId=' + encodeURIComponent(runId), {
            headers: { accept: 'text/event-stream' },
            signal: ac.signal,
          })
          if (!res.ok || !res.body) throw new Error('事件流连接失败（HTTP ' + res.status + '）')

          const reader = res.body.getReader()
          const dec = new TextDecoder()
          const feed = makeSseParser((evt) => {
            // 只有当这条 run 仍属于当前显示的标的时才渲染
            if (runSymbolRef.current !== symbol) return
            if (evt.type === 'text-delta') setLive((s) => s + (evt.text || ''))
            else if (evt.type === 'tool-start') {
              setTools((prev) => [...prev, { name: evt.name, argsRaw: evt.argsRaw || '', pending: true }])
            } else if (evt.type === 'tool-end') {
              setTools((prev) => {
                const next = prev.slice()
                // 结束事件补上结果
                for (let i = next.length - 1; i >= 0; i--) {
                  if (next[i].pending && next[i].name === evt.name) {
                    next[i] = { ...next[i], pending: false, isError: evt.isError === true, text: evt.text, fullText: evt.fullText }
                    break
                  }
                }
                return next
              })
            } else if (evt.type === 'error') {
              setError(evt.message || '未知错误')
            }
          })
          for (;;) {
            const { value, done } = await reader.read()
            if (done) break
            feed(dec.decode(value, { stream: true }))
          }
        } catch (e) {
          if (e && e.name === 'AbortError') setNote('已停止本次回答。已生成的部分仍保存在对话里。')
          else setError(String((e && e.message) || e))
        } finally {
          setRun(null)
          abortRef.current = null
          // 以服务端为准重新载入。
          // ⚠️ 顺序很重要：**先载入、再清掉流式临时文本**。
          // 反过来的话，清空 live 到载入完成之间会有一瞬间"答案消失"，看起来像丢了。
          try {
            const d = await apiFetch('/chat/messages', { symbol: runSymbolRef.current, limit: 200 })
            if (runSymbolRef.current === symbol) {
              setMsgs(d.messages || [])
              setLive('')
              setTools([])
            }
          } catch {
            // 重新载入失败也要收掉临时文本，但**保留**已经显示出来的内容
            setLive('')
            setTools([])
          }
        }
      }

      const stop = async () => {
        const r = run
        if (!r) return
        try {
          await fetch(API + '/chat/cancel', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ runId: r.runId }),
          })
        } catch { /* 取消失败不阻塞本地中断 */ }
        try { abortRef.current?.abort() } catch { /* ignore */ }
      }

      const onKeyDown = (e) => {
        // Enter 发送，Shift+Enter 换行（与常见对话界面一致）
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) {
          e.preventDefault()
          send()
        }
      }

      const isEmpty = loaded && msgs.length === 0 && !streaming

      const logChildren = []
      // 按轮次渲染：用户提问 → 助手回答 → （工具调用折成回答下面的一行摘要）
      // 工具消息**不再**作为独立内容出现——那是中间过程，不该挡在回答前面。
      for (const g of groupMessages(msgs)) {
        if (g.user) logChildren.push(h(MessageBlock, { key: 'u' + g.id, m: g.user }))
        if (g.assistant) {
          logChildren.push(h('div', { className: 'sl-turn', key: 'a' + g.id },
            h(MessageBlock, { m: g.assistant }),
            h(ToolGroup, { tools: g.tools })
          ))
        } else if (g.tools.length > 0) {
          // 有工具但还没落库回答（例如中途取消）：只显示摘要，别丢过程
          logChildren.push(h('div', { className: 'sl-turn', key: 't' + g.id },
            h(ToolGroup, { tools: g.tools })))
        }
      }
      // 流式中：工具只显示一行紧凑进度，不再逐个铺开
      if (runForThisSymbol && tools.length > 0) {
        logChildren.push(h('div', { className: 'sl-tools-live', key: 'live-tools' },
          h('span', { 'aria-hidden': 'true' }, '🔧'),
          h('span', null, tools.map((t) => t.name + (t.pending ? '…' : '')).join('、')),
          tools.some((t) => t.pending) ? h('span', { className: 'sl-stream-cursor' }) : null
        ))
      }
      if (runForThisSymbol && live) {
        logChildren.push(h('div', { className: 'sl-msg sl-msg-assistant', key: 'live' },
          h('div', { className: 'sl-msg-body' }, renderMarkdown(live), h('span', { className: 'sl-stream-cursor' }))
        ))
      }
      if (isEmpty) {
        logChildren.push(h('div', { className: 'sl-chat-empty', key: 'empty' },
          h('div', { className: 'sl-note' },
            `还没有关于 ${symbol} 的对话。在这里提问，会自动带上它作为上下文。`),
          h('div', { className: 'sl-chat-sug' },
            CHAT_SUGGESTIONS.map((q) => h('button', { key: q, onClick: () => send(q) }, q)))
        ))
      }

      return h(RightPane, {
        pane,
        title: 'AI 研究助手',
        bodyClassName: 'sl-chat-wrap',
        children: h('div', { className: 'sl-chat-log', ref: logRef },
          !loaded ? h('div', { className: 'sl-note' }, '载入对话…') : null,
          ...logChildren
        ),
        foot: h('div', { className: 'sl-chat-foot' },
          // 状态行：诚实说明"现在是哪个标的、进行到哪一步"
          h('div', { className: 'sl-chat-status' },
            error
              ? h('span', { className: 'sl-err' }, '⚠️ ' + error)
              : backgroundSymbol
                ? h('span', null, `「${backgroundSymbol}」的回答仍在后台进行，切回去可看到结果`)
                : note
                  ? h('span', null, note)
                  : runForThisSymbol
                    ? h('span', null, tools.some((t) => t.pending) ? '正在调用工具…' : '正在回答…')
                    : info && info.model
                      ? h('span', null, `${info.model.provider} / ${info.model.model} · ${info.toolCount} 个工具可用`)
                      : h('span', null, '就绪')
          ),
          // 复合输入框：按钮**内嵌在右下角**（原生就是这样）；高度由**上边缘拖拽条**调整。
          // 输入区用 padding-right 给按钮让位，避免文字被压在按钮下面。
          h('div', { className: 'sl-composer', ref: composerRef },
            // 上边缘拖拽条：往上拖变高（边缘跟手）。键盘也可调，保持与右栏分隔条一致的语义。
            h('div', {
              className: 'sl-composer-grip' + (composer.dragging ? ' sl-composer-grip-on' : ''),
              role: 'separator',
              'aria-orientation': 'horizontal',
              'aria-label': '调整输入框高度（上下方向键微调，Home/End 到最小/最大，回车复位，双击复位）',
              'aria-valuenow': composer.height,
              'aria-valuemin': COMPOSER.min,
              'aria-valuemax': COMPOSER.max,
              tabIndex: 0,
              title: '拖动调整输入框高度 · 双击复位',
              onPointerDown: composer.onPointerDown,
              onPointerMove: composer.onPointerMove,
              onPointerUp: composer.endDrag,
              onPointerCancel: composer.endDrag,
              onDoubleClick: composer.reset,
              onKeyDown: composer.onKeyDown,
              onLostPointerCapture: composer.endDrag,
            }),
            h('textarea', {
              className: 'sl-chat-input',
              style: { height: composer.height + 'px' },
              value: draft,
              placeholder: streaming
                ? '上一条还在回答中…'
                : `就 ${symbol}${symbolName ? '（' + symbolName + '）' : ''} 提问，Enter 发送，Shift+Enter 换行`,
              disabled: streaming,
              onChange: (e) => setDraft(e.target.value),
              onKeyDown,
            }),
            streaming
              // 回答中：同一个位置变成「停止」（方块）
              ? h('button', {
                className: 'sl-composer-btn sl-composer-stop',
                title: '停止本次回答', 'aria-label': '停止',
                onClick: stop,
              }, h(SendGlyph, { stopping: true }))
              // 空闲：向上箭头（与原生一致）
              : h('button', {
                className: 'sl-composer-btn',
                title: '发送（Enter）', 'aria-label': '发送',
                disabled: draft.trim() === '',
                onClick: () => send(),
              }, h(SendGlyph, { stopping: false }))
          ),
          h('div', { className: 'sl-chat-disclaimer' },
            'AI 回答可能出错；其中的数字来自工具调用，请以工具原始返回为准。'
            + '本对话不构成投资建议。'),
        ),
      })
    }

    /**
     * 图表交互层：让 K 线的缩放/平移**贴近看盘软件**。
     *
     * 键位（沿用通达信习惯，尽量不用新学）：
     *   ↑ / ↓          放大 / 缩小（＝可见根数减少 / 增加）
     *   ← / →          向更早 / 更晚平移
     *   PageUp/PageDown 整屏翻页（半屏步长）
     *   Home / End     跳到最早 / 最新
     *   鼠标滚轮        缩放，且**以指针所在那根为锚**（鼠标指着哪里，哪里不动）
     *
     * 两个实现要点：
     *   1. 滚轮必须用 **原生非 passive 监听**（React 的 onWheel 是被动的，preventDefault 会被忽略，
     *      结果是缩放的同时页面也在滚）。
     *   2. 容器需要 tabIndex 才能接键盘；并在获得焦点时给出可见的焦点环。
     */
    function ChartStage({
      view, geo, scale, bars, shapes, selectedIds, tool, draft, snapOn, paletteRect, measure,
      onDraftChange, onHoverSnap, onUndo, onZoom, onPan, onJump, hint, children,
      onCreate, onDelete, onMarqueeChange, onMarqueeDone, onSelectNone, onMeasure, onExitTool,
    }) {
      const ref = useRef(null)
      const showHint = useTransientHint(false, view.count + '|' + view.end, RIGHT_PANE.sizeHintMs)
      /** 两点型工具（趋势线/圆）的"两次点击"状态：第一次点完先不落地，等第二次点 */
      const pendingFirst = useRef(null)
      const downAt = useRef(null)
      const boxStart = useRef(null)
      /** 拖动判定阈值（viewBox 单位）：位移小于它算"点击"，大于它算"拖动" */
      const DRAG_MIN = Math.max(3, CHART_GEO.W / 300)
      /** 框选是否拖够了（太小就当成点击，避免误触发框选/缩放） */
      const boxBigEnough = (a, b) => a && b && (Math.abs(b.x - a.x) >= DRAG_MIN || Math.abs(b.y - a.y) >= DRAG_MIN)
      /** 当前模式：'draw' 画线 · 'select' 框选图形 · 'zoom' 框选放大 · 'measure' 测幅 */
      const mode = tool === 'select' ? 'select'
        : tool === 'measure' ? 'measure'
          : (tool ? 'draw' : 'zoom')

      /** 指针是否落在浮动调色板上——是的话容器不该接管（否则点色块会变成又画一条线） */
      const insidePalette = (vb) => {
        if (!vb || !paletteRect) return false
        return vb.x >= paletteRect.x - 6 && vb.x <= paletteRect.x + paletteRect.w + 6
          && vb.y >= paletteRect.y - 6 && vb.y <= paletteRect.y + paletteRect.h + 6
      }

      /**
       * 指针 → viewBox 坐标。
       * SVG 是固定 viewBox 再等比缩放到容器，所以**宽高用同一个比例**——
       * 拿 rect.width 换算 x 与 y 都是对的，不必知道 SVG 的实际高度。
       */
      const toViewBox = (clientX, clientY) => {
        const el = ref.current
        if (!el) return null
        const rect = el.getBoundingClientRect()
        if (!rect.width) return null
        const k = CHART_GEO.W / rect.width
        return { x: (clientX - rect.left) * k, y: (clientY - rect.top) * k }
      }

      /** 指针 x → 窗口内**小数**下标（画线用小数，才能精确落在两根之间） */
      const barIndexAt = (clientX) => {
        const el = ref.current
        if (!el || view.count <= 0) return null
        const rect = el.getBoundingClientRect()
        if (!rect.width) return null
        const svgX = ((clientX - rect.left) / rect.width) * CHART_GEO.W
        const plotW = CHART_GEO.W - CHART_GEO.PAD_L - CHART_GEO.PAD_R
        if (plotW <= 0) return null
        const frac = (svgX - CHART_GEO.PAD_L) / plotW
        return Math.max(0, Math.min(view.count - 1, Math.floor(frac * view.count)))
      }

      const onWheel = (e) => {
        e.preventDefault()
        const i = barIndexAt(e.clientX)
        onZoom(e.deltaY > 0 ? CHART_VIEW.wheelFactor : 1 / CHART_VIEW.wheelFactor, i)
      }
      useEffect(() => {
        const el = ref.current
        if (!el || typeof el.addEventListener !== 'function') return undefined
        el.addEventListener('wheel', onWheel, { passive: false })
        return () => el.removeEventListener('wheel', onWheel)
      })

      // ── 画线：按下 → 拖动预览 → 松开保存 ──
      const pointAt = (e) => {
        const vb = toViewBox(e.clientX, e.clientY)
        if (!vb || !scale) return null
        const rawIndex = ((vb.x - CHART_GEO.PAD_L) / geo.plotW) * geo.n - 0.5
        const rawPrice = priceAtY(vb.y, scale, { priceH: CHART_GEO.PRICE_H, padT: CHART_GEO.PAD_T })
        // 吸附开关：按钮切换持久生效；**按住 Ctrl 时临时取反**（
        // 想精确放到"半路价位"时按住 Ctrl 即可绕过吸附，松手又是吸附状态）
        const snapEnabled = e && (e.ctrlKey || e.metaKey) ? !snapOn : snapOn !== false
        const snap = snapAnchor(bars, rawIndex, rawPrice, snapEnabled)
        return { ...snap, vb }
      }
      /** 把窗口内下标还原成锚点（日期 + 价格） */
      const toAnchor = (p) => (p && p.date && Number.isFinite(p.price)) ? { date: p.date, price: p.price } : null

      /** 两点型工具 = 一次拖动画完，或"点一下定第一点、再点一下定第二点" */
      const isTwoPoint = (t) => t === 'trend' || t === 'circle'

      const onPointerDown = (e) => {
        if (!tool) {
          // 没选工具：拖动 = 框选放大（看盘软件里最常见的框选缩放）
          const vb = toViewBox(e.clientX, e.clientY)
          if (!vb) return
          e.preventDefault()
          try { ref.current?.focus?.() } catch { /* ignore */ }
          try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* ignore */ }
          boxStart.current = vb
          onMarqueeChange({ x0: vb.x, y0: geo.padT, x1: vb.x, y1: geo.padT + CHART_GEO.PRICE_H })
          return
        }
        if (tool === 'select') {
          // 选择模式：拖动 = 框选多条，点一下 = 选中一条
          const vb = toViewBox(e.clientX, e.clientY)
          if (!vb || insidePalette(vb)) return
          e.preventDefault()
          try { ref.current?.focus?.() } catch { /* ignore */ }
          try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* ignore */ }
          boxStart.current = vb
          onMarqueeChange({ x0: vb.x, y0: vb.y, x1: vb.x, y1: vb.y })
          return
        }
        if (tool === 'measure') {
          // 测幅：拖动直接测；只是点一下则先定第一个点，等第二下（与画线同一套手感）
          const vb = toViewBox(e.clientX, e.clientY)
          if (!vb) return
          e.preventDefault()
          try { ref.current?.focus?.() } catch { /* ignore */ }
          try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* ignore */ }
          const p = pointAt(e)
          if (!p) return
          if (measure && measure.pending) { onMeasure({ a: measure.a, b: p, done: true }); return }
          downAt.current = vb
          onMeasure({ a: p, b: p, pending: true })
          return
        }
        const vb0 = toViewBox(e.clientX, e.clientY)
        if (insidePalette(vb0)) return          // 落在调色板上：让它自己处理，别开始画线
        e.preventDefault()
        // ⚠️ preventDefault 会**阻止浏览器把焦点交给容器**，而键盘事件（Ctrl+Z / Delete）
        // 只会在容器有焦点时才到达。所以这里必须显式聚焦——
        // 否则"画完一条线后按 Ctrl+Z 没反应"（这条踩过）。
        try { ref.current?.focus?.() } catch { /* ignore */ }
        try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch { /* ignore */ }

        const p = pointAt(e)
        if (!p) return
        // 已处于"两次点击"的第二下：用当前位置把图形定下来
        if (draft && isTwoPoint(draft.type) && pendingFirst.current) {
          finish(draft.type, [pendingFirst.current, p])
          return
        }
        onHoverSnap(null)                       // 进入绘制后收起幽灵提示，只留预览线
        downAt.current = vb0
        onDraftChange(draftFromPoint(tool, [p]))
      }
      const onPointerMove = (e) => {
        if (tool === 'measure') {
          if (!measure || !measure.pending) return
          const p = pointAt(e)
          if (!p) return
          onMeasure({ a: measure.a, b: p, pending: true })
          return
        }
        if (!tool || tool === 'select') {
          if (!boxStart.current) return
          const vb = toViewBox(e.clientX, e.clientY)
          if (!vb) return
          // 放大模式只关心横向（价格轴按可见 K 线自动定，纵向不参与缩放）
          const a = boxStart.current
          onMarqueeChange(mode === 'select'
            ? { x0: a.x, y0: a.y, x1: vb.x, y1: vb.y }
            : { x0: a.x, y0: geo.padT, x1: vb.x, y1: geo.padT + CHART_GEO.PRICE_H })
          return
        }
        const p = pointAt(e)
        if (!p) return
        if (!draft) {
          // 还没按下：给出**幽灵提示**——告诉用户"现在点下去会吸附在哪、松手会得到什么线"
          if (!insidePalette(toViewBox(e.clientX, e.clientY))) onHoverSnap(p)
          return
        }
        const next = isTwoPoint(draft.type) ? [draft.points[0], p] : [p]
        onDraftChange(draftFromPoint(draft.type, next))
      }
      /** 指针离开画布：收起幽灵提示 */
      const onPointerLeave = () => {
        if (tool === 'draw' && !draft) onHoverSnap(null)
      }
      /** 把图形落地（锚点必须能定位到真实交易日，否则存下来也对不齐） */
      const finish = (type, points) => {
        const need = isTwoPoint(type) ? 2 : 1
        const anchors = points.length === need ? points.map(toAnchor) : []
        pendingFirst.current = null
        onDraftChange(null)
        if (anchors.length === need && anchors.every(Boolean)) {
          // 把最后落点的屏幕位置一起报上去：浮动调色板要出现在那里
          const last = points[points.length - 1]
          onCreate(type, anchors, last ? last.vb : null)
        }
      }
      const endDraw = (e) => {
        if (mode === 'measure') {
          if (!measure || !measure.pending) return
          const vb = e ? toViewBox(e.clientX, e.clientY) : null
          const moved = (vb && downAt.current)
            ? Math.hypot(vb.x - downAt.current.x, vb.y - downAt.current.y)
            : 0
          // 拖动够大 = 一次画完；只是点了一下 → 保留第一点，等第二下（同画线的手感）
          if (moved >= DRAG_MIN) onMeasure({ a: measure.a, b: measure.b, done: true })
          return
        }
        // 框选（选择/放大两种模式）：拖够了才算，否则当成一次普通点击
        if (mode !== 'draw') {
          const a = boxStart.current
          const vb = e ? toViewBox(e.clientX, e.clientY) : null
          boxStart.current = null
          onMarqueeChange(null)
          if (!a) return                       // 按下时就被拦掉了（例如落在调色板上）→ 不做任何事
          if (!boxBigEnough(a, vb)) {
            if (vb) {
              if (mode === 'select') onMarqueeDone(null, 'click', vb)   // 小位移 = 点选
              else onMarqueeDone(null, 'pickbar', vb)                   // 放大模式：点一下某根 K 线 → 钉住它的读数
            }
            return
          }
          onMarqueeDone(
            mode === 'select' ? { x0: a.x, y0: a.y, x1: vb.x, y1: vb.y } : { x0: a.x, x1: vb.x },
            mode === 'select' ? 'select' : 'zoom')
          return
        }
        if (!draft) return
        const p0 = draft.points[0]
        // 一点型（水平线/标记）：松手即落地
        if (!isTwoPoint(draft.type)) { finish(draft.type, [p0]); return }
        // 两点型：位移够大 = 拖动画完；位移很小 = 只是"点了一下"→ 等第二次点击定第二点
        const vb = e ? toViewBox(e.clientX, e.clientY) : null
        const moved = (vb && downAt.current)
          ? Math.hypot(vb.x - downAt.current.x, vb.y - downAt.current.y)
          : 0
        if (moved >= DRAG_MIN && draft.points.length === 2) {
          finish(draft.type, draft.points.slice(0, 2))
          return
        }
        pendingFirst.current = p0     // 保留第一点，等下一次点击
      }

      const onKeyDown = (e) => {
        // Ctrl/Cmd+Z：撤销上一次画线操作（画线是高频易错操作，撤销要最顺手）
        if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
          e.preventDefault()
          onUndo()
          return
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          // 多选时按一下删掉全部（框选后不用逐个点）
          if (selectedIds && selectedIds.length > 0) { e.preventDefault(); onDelete(selectedIds); return }
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          // Esc 逐级退出：画线/测幅 → 选择模式；已在选择模式 → 取消选中
          if (tool && tool !== 'select') onExitTool()
          else onSelectNone()
          return
        }
        const page = Math.max(1, Math.round(view.count * CHART_VIEW.pageRatio))
        const step = Math.max(1, Math.round(view.count * 0.05))
        switch (e.key) {
          case 'ArrowUp': e.preventDefault(); onZoom(1 / CHART_VIEW.keyFactor, null); break
          case 'ArrowDown': e.preventDefault(); onZoom(CHART_VIEW.keyFactor, null); break
          case 'ArrowLeft': e.preventDefault(); onPan(-step); break
          case 'ArrowRight': e.preventDefault(); onPan(step); break
          case 'PageUp': e.preventDefault(); onPan(-page); break
          case 'PageDown': e.preventDefault(); onPan(page); break
          case 'Home': e.preventDefault(); onJump('first'); break
          case 'End': e.preventDefault(); onJump('last'); break
          case '+': case '=': e.preventDefault(); onZoom(1 / CHART_VIEW.keyFactor, null); break
          case '-': case '_': e.preventDefault(); onZoom(CHART_VIEW.keyFactor, null); break
          default: break
        }
      }

      return h('div', {
        className: 'sl-stage' + (tool ? ' sl-stage-draw' : ''),
        ref,
        tabIndex: 0,
        role: 'application',
        'aria-label': 'K线图：上下键缩放，左右键平移，PageUp/PageDown 翻页，Home/End 到最早/最新，滚轮缩放'
          + (tool ? `；当前画线工具：${tool}` : ''),
        title: tool
          ? '在图上按下并拖动即可画线（会吸附到最近的 K 线高低点）；Esc 取消'
          : '↑↓ 缩放 · ←→ 平移 · 滚轮缩放 · 用工具栏的画线按钮开始画线',
        onKeyDown,
        // 画线模式下接管指针；否则不拦截，保持原有的 hover 读数
        onPointerDown: onPointerDown,
        onPointerMove: onPointerMove,
        onPointerUp: endDraw,
        onPointerCancel: endDraw,
        onPointerLeave: onPointerLeave,
      },
        children,
        h('div', {
          className: 'sl-view-hint' + (showHint ? '' : ' sl-view-hint-off'),
          role: 'status', 'aria-live': 'polite',
        }, `共 ${view.count} 根`),
        hint ? h('div', { className: 'sl-view-sub' }, hint) : null
      )
    }

    function RightPane({ pane, title, children, foot, bodyClassName }) {
      // 宽度提示只在**正在调整**时出现，停手 3 秒后淡出。
      // 常驻一个灰色的「380px」会持续抢注意力，而它平时毫无用处。
      // 用 useTransientHint 统一处理"拖动中一直显示 / 键盘调整也显示 / 停手后延迟隐藏"。
      const showSize = useTransientHint(pane.dragging, pane.width, RIGHT_PANE.sizeHintMs)

      if (pane.collapsed) {
        return h('div', { className: 'sl-rail' },
          h('button', {
            className: 'sl-rail-btn', title: '展开右栏',
            'aria-label': '展开右栏', onClick: () => pane.setCollapsed(false),
          }, '‹'),
          h('div', { className: 'sl-drag-hint', style: { writingMode: 'vertical-rl' } }, title)
        )
      }
      return h('div', { className: 'sl-right', style: { width: pane.width + 'px' } },
        // 浮动提示：绝对定位在右上角，不影响布局
        h('div', {
          className: 'sl-pane-size' + (showSize ? '' : ' sl-pane-size-off'),
          role: 'status',
          'aria-live': 'polite',
          'aria-hidden': showSize ? 'false' : 'true',
        }, pane.width + 'px'),
        h('div', { className: 'sl-right-head' },
          h('b', null, title),
          h('button', {
            className: 'sl-rail-btn', style: { marginLeft: 'auto' },
            title: '收起右栏（也可双击分隔条复位宽度）',
            'aria-label': '收起右栏', onClick: () => pane.setCollapsed(true),
          }, '›')
        ),
        h('div', { className: 'sl-right-body' + (bodyClassName ? ' ' + bodyClassName : '') }, children),
        foot ? h('div', { className: 'sl-right-foot' }, foot) : null
      )
    }

    /** 分隔条：可拖拽、可键盘调整、双击复位 */
    function Splitter({ pane }) {
      return h('div', {
        className: 'sl-split' + (pane.dragging ? ' sl-split-on' : ''),
        role: 'separator',
        'aria-orientation': 'vertical',
        'aria-label': '调整右栏宽度（左右方向键微调，Home/End 到最小/最大，回车复位，双击复位）',
        'aria-valuenow': pane.width,
        'aria-valuemin': pane.min,
        'aria-valuemax': pane.max,
        tabIndex: 0,
        title: '拖动调整宽度 · 双击复位 · 方向键微调',
        onPointerDown: pane.onPointerDown,
        onPointerMove: pane.onPointerMove,
        onPointerUp: pane.endDrag,
        onPointerCancel: pane.endDrag,
        onDoubleClick: pane.reset,
        onKeyDown: pane.onKeyDown,
        onLostPointerCapture: pane.endDrag,
      })
    }

    // ─────────────────────────── 顶部指数栏 ───────────────────────────
    function TopBar({ onPick }) {
      const [ov, setOv] = useState(null)
      const [err, setErr] = useState(null)
      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const d = await apiFetch('/overview')
            if (alive) { setOv(d); setErr(null) }
          } catch (e) { if (alive) setErr(e.message) }
        }
        load()
        const t = setInterval(load, 10000)
        return () => { alive = false; clearInterval(t) }
      }, [])
      if (err) return h('div', { className: 'sl-top' }, h('span', { className: 'sl-err' }, '大盘数据获取失败：' + err))
      if (!ov) return h('div', { className: 'sl-top' }, h('span', { className: 'sl-note' }, '加载大盘…'))
      const b = ov.breadth
      return h('div', { className: 'sl-top' },
        ...ov.indices.map((i) =>
          h('div', { key: i.symbol, className: 'sl-idx', style: { cursor: 'pointer' }, onClick: () => onPick && onPick(i.symbol) },
            h('div', { className: 'sl-idx-name' }, i.name),
            h('div', { className: 'sl-idx-val' }, fmt(i.price)),
            h('div', { className: 'sl-idx-chg ' + cls(i.changePct) }, fmtPct(i.changePct))
          )),
        h('div', { className: 'sl-sep' }),
        h('div', { className: 'sl-metric' }, h('span', null, '成交额'), h('b', null, fmtBig(ov.totalAmount))),
        b ? h('div', { className: 'sl-metric' }, h('span', null, '涨/跌'),
          h('b', null, h('span', { className: 'sl-up' }, b.up), ' / ', h('span', { className: 'sl-down' }, b.down))) : null,
        ov.sentiment ? h('div', { className: 'sl-metric' }, h('span', null, '情绪'),
          h('b', { className: cls(ov.sentiment.score - 50) }, ov.sentiment.label + ' ' + ov.sentiment.score)) : null
      )
    }

    // ─────────────────────────── 自选股 + 搜索 ───────────────────────────
    function Sidebar({ current, onSelect }) {
      const [watch, setWatch] = useLocal(LS_WATCH, DEFAULT_WATCH)
      const [q, setQ] = useState('')
      const [sugg, setSugg] = useState([])
      const [busy, setBusy] = useState(false)
      const timer = useRef(null)
      const boxRef = useRef(null)

      useEffect(() => {
        if (q.trim() === '') { setSugg([]); return }
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(async () => {
          setBusy(true)
          try {
            const d = await apiFetch('/search', { q: q.trim() })
            setSugg(d.results || [])
          } catch { setSugg([]) }
          finally { setBusy(false) }
        }, 260)
        return () => { if (timer.current) clearTimeout(timer.current) }
      }, [q])

      useEffect(() => {
        const onDoc = (e) => {
          if (boxRef.current && !boxRef.current.contains(e.target)) setSugg([])
        }
        document.addEventListener('mousedown', onDoc)
        return () => document.removeEventListener('mousedown', onDoc)
      }, [])

      const addAndSelect = (item) => {
        if (!watch.some((w) => w.symbol === item.symbol)) {
          setWatch([...watch, { symbol: item.symbol, name: item.name }])
        }
        onSelect(item.symbol, item.name)
        setQ(''); setSugg([])
      }
      const remove = (symbol) => setWatch(watch.filter((w) => w.symbol !== symbol))

      return h('div', { className: 'sl-side' },
        h('div', { className: 'sl-search', ref: boxRef },
          h('input', {
            className: 'sl-in', placeholder: '搜索股票 / 代码', value: q,
            onChange: (e) => setQ(e.target.value),
          }),
          sugg.length > 0 ? h('div', { className: 'sl-sugg' },
            ...sugg.map((s) => h('div', {
              key: s.symbol, className: 'sl-sugg-row', onClick: () => addAndSelect(s),
            },
              h('span', null, s.name),
              h('span', { className: 'sl-code' }, s.symbol)
            ))) : null
        ),
        h('div', { className: 'sl-list' },
          watch.length === 0
            ? h('div', { className: 'sl-note', style: { padding: '10px 8px' } }, '搜索股票并加入自选')
            : watch.map((w) => h('div', {
              key: w.symbol,
              className: 'sl-item' + (current === w.symbol ? ' sl-item-on' : ''),
              onClick: () => onSelect(w.symbol, w.name),
            },
              h('div', null,
                h('div', null, w.name || w.symbol),
                h('div', { className: 'sl-code' }, w.symbol)
              ),
              h('button', { className: 'sl-del', title: '移出自选', onClick: (e) => { e.stopPropagation(); remove(w.symbol) } }, '×')
            ))
        )
      )
    }

    // ─────────────────────────── K线图（手写 SVG） ───────────────────────────
    /**
     * 把公式的输出线分成「主图叠加」与「副图」。
     *
     * 判定依据：数值是否落在价格区间内（留 10% 余量）。
     *   - MA / BBI 这类跟价格同量纲的 → 主图叠加
     *   - MACD（有负值）/ RSI（0~100）这类量纲不同的 → 副图
     * 纯 0/1 的条件线**不画成曲线**：它由 signals 单独标记在 K 线上，
     * 否则一条在 0~1 之间跳动的线只会糊在图上角落里，没有意义。
     *
     * 纯函数，便于离线测试（见 tests/client.test.mjs）。
     */
    function classifyFormulaOutputs(bars, outputs, signalName) {
      const overlay = []
      const sub = []
      const signalLines = []
      const highs = (bars || []).map((b) => b.high).filter((v) => typeof v === 'number')
      const lows = (bars || []).map((b) => b.low).filter((v) => typeof v === 'number')
      if (highs.length === 0 || lows.length === 0) return { overlay, sub, signalLines }
      const maxP = Math.max(...highs)
      const minP = Math.min(...lows)
      const pad = (maxP - minP) * 0.1 || 1
      const lo = minP - pad
      const hi = maxP + pad
      for (const o of outputs || []) {
        const vals = (o.values || []).filter((v) => typeof v === 'number')
        if (vals.length === 0) { sub.push(o); continue }
        const isBool = vals.every((v) => v === 0 || v === 1)
        if (isBool && signalName && o.name === signalName) { signalLines.push(o); continue }
        const minV = Math.min(...vals)
        const maxV = Math.max(...vals)
        if (minV >= lo && maxV <= hi) overlay.push(o)
        else sub.push(o)
      }
      return { overlay, sub, signalLines }
    }

    function formulaLineColor(out, index) {
      const attrs = (out && out.attrs) || []
      for (const a of attrs) {
        if (TDX_COLOR_ATTRS[a]) return TDX_COLOR_ATTRS[a]
      }
      return FORMULA_COLORS[index % FORMULA_COLORS.length]
    }

    function isHistogramOutput(out) {
      const attrs = (out && out.attrs) || []
      return attrs.some((a) => HISTOGRAM_ATTRS.has(a))
    }

    /** 折线路径：null 处断开（不连线跨越数据缺口） */
    function polylinePath(values, xOf, yOf) {
      const parts = []
      let pen = false
      for (let i = 0; i < values.length; i++) {
        const v = values[i]
        if (typeof v !== 'number') { pen = false; continue }
        parts.push((pen ? 'L' : 'M') + xOf(i).toFixed(1) + ' ' + yOf(v).toFixed(1))
        pen = true
      }
      return parts.join(' ')
    }

    function KLineChart({ bars, onHover, overlay = [], sub = [], signals = null, drawings = [], scale, colorPalette = null, marquee = null, pinnedRel = null, dimmed = false }) {
      const { W, PAD_L, PAD_R, PAD_T } = CHART_GEO
      const priceH = CHART_GEO.PRICE_H
      const PRICE_H = CHART_GEO.PRICE_H
      const GAP_V = 8, VOL_H = 40, GAP_S = 8, SUB_H = 88, PAD_B = 18
      const hasSub = sub.length > 0
      const H = PAD_T + PRICE_H + GAP_V + VOL_H + (hasSub ? GAP_S + SUB_H : 0) + PAD_B
      const plotW = W - PAD_L - PAD_R
      if (!bars || bars.length === 0) return h('div', { className: 'sl-note' }, '暂无K线数据')
      const n = bars.length
      const bw = Math.max(1, (plotW / n) * 0.62)
      const xC = (i) => PAD_L + (plotW / n) * (i + 0.5)
      const xL = (i) => PAD_L + (plotW / n) * i

      // 比例尺由调用方传入（**只有一处计算**，交互层与图表共用，避免两边算出不同的范围）
      const { maxP, minP, span } = scale
      const vols = bars.map((b) => b.volume || 0)
      const maxV = Math.max(...vols, 1)
      const yP = (p) => PAD_T + (1 - (p - minP) / span) * priceH

      // 副图范围：含 0（柱状需要零轴）
      const subVals = []
      let subHasHist = false
      for (const o of sub) {
        if (isHistogramOutput(o)) subHasHist = true
        for (const v of o.values || []) if (typeof v === 'number') subVals.push(v)
      }
      if (subHasHist) subVals.push(0)
      const subTop = PAD_T + priceH + GAP_V + VOL_H + GAP_S
      const subMax = subVals.length ? Math.max(...subVals) : 1
      const subMin = subVals.length ? Math.min(...subVals) : 0
      const subSpan = (subMax - subMin) || 1
      const yS = (v) => subTop + (1 - (v - subMin) / subSpan) * SUB_H

      // 网格 + 价格轴
      const gridLines = []
      for (let g = 0; g <= 4; g++) {
        const p = minP + (span * g) / 4
        const y = yP(p)
        gridLines.push(h('line', { key: 'g' + g, x1: PAD_L, x2: W - PAD_R, y1: y, y2: y, stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1 }))
        gridLines.push(h('text', { key: 't' + g, x: W - PAD_R + 6, y: y + 4, fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' }, fmt(p)))
      }

      // 蜡烛
      const candles = bars.map((b, i) => {
        const up = b.close >= b.open
        const color = up ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)'
        const x = xC(i)
        const yO = yP(b.open), yC = yP(b.close)
        const top = Math.min(yO, yC), hgt = Math.max(1, Math.abs(yC - yO))
        return h('g', { key: 'c' + i },
          h('line', { x1: x, x2: x, y1: yP(b.high), y2: yP(b.low), stroke: color, strokeWidth: 1 }),
          h('rect', { x: x - bw / 2, y: top, width: bw, height: hgt, fill: up ? 'none' : color, stroke: color, strokeWidth: 1 })
        )
      })

      // 成交量副图
      const volTop = PAD_T + priceH + GAP_V
      const vols2 = bars.map((b, i) => {
        const v = b.volume || 0
        const hgt = (v / maxV) * VOL_H
        const up = b.close >= b.open
        return h('rect', {
          key: 'v' + i, x: xC(i) - bw / 2, y: volTop + VOL_H - hgt, width: bw, height: Math.max(0.5, hgt),
          fill: up ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)', opacity: 0.65,
        })
      })

      // MA20（内置均线，公式未叠加时也提供基本参照）
      const ma = []
      for (let i = 0; i < n; i++) {
        if (i < 19) continue
        const slice = bars.slice(i - 19, i + 1)
        const avg = slice.reduce((a, b) => a + b.close, 0) / 20
        ma.push([xC(i), yP(avg)])
      }
      const maPath = ma.length ? 'M' + ma.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' L') : ''

      // ── 公式：主图叠加线 ──
      const overlayPaths = overlay.map((o, k) => h('path', {
        key: 'ov' + k,
        d: polylinePath(o.values, xC, yP),
        fill: 'none',
        stroke: formulaLineColor(o, k),
        strokeWidth: 1.5,
        opacity: 0.95,
      }))

      // ── 公式：副图（折线 + 柱状） ──
      const subMarks = []
      sub.forEach((o, k) => {
        const color = formulaLineColor(o, k + overlay.length)
        if (isHistogramOutput(o)) {
          const zeroY = yS(0)
          ;(o.values || []).forEach((v, i) => {
            if (typeof v !== 'number') return
            const y = yS(v)
            const top = Math.min(y, zeroY)
            const hgt = Math.max(0.6, Math.abs(zeroY - y))
            subMarks.push(h('rect', {
              key: `sh${k}-${i}`, x: xC(i) - bw / 2, y: top, width: bw, height: hgt,
              fill: v >= 0 ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-success-primary)',
              opacity: 0.8,
            }))
          })
        } else {
          subMarks.push(h('path', {
            key: 'sl' + k, d: polylinePath(o.values, xC, yS),
            fill: 'none', stroke: color, strokeWidth: 1.4,
          }))
        }
      })
      if (hasSub) {
        subMarks.unshift(h('line', {
          key: 'sub-frame', x1: PAD_L, x2: W - PAD_R, y1: subTop, y2: subTop,
          stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1,
        }))
        subMarks.push(h('text', { key: 'sub-label', x: W - PAD_R + 6, y: subTop + 4, fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' }, fmt(subMax)))
        subMarks.push(h('text', { key: 'sub-label2', x: W - PAD_R + 6, y: subTop + SUB_H, fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' }, fmt(subMin)))
      }

      // ── 选股信号标记（条件为 1 的 bar） ──
      const signalMarks = []
      if (signals && Array.isArray(signals.indices)) {
        for (const i of signals.indices) {
          const b = bars[i]
          if (!b) continue
          const x = xC(i)
          const y = yP(b.low) + 6
          signalMarks.push(h('path', {
            key: 'sig' + i,
            d: `M${x} ${y} l4 7 l-8 0 z`,
            fill: 'var(--dsw-alias-state-warn-primary)',
          }))
        }
      }

      // ── 手工画线（标注）──
      // x 用与 K 线同一个 xC（它对面下标是线性的，所以窗口外的端点会正确外推、被画布裁掉）
      // 复权模式与当前不一致的线画成**虚线**：不画会让人以为丢了，实线会让人以为它还对得上
      const drawingMarks = []
      for (const s of (Array.isArray(drawings) ? drawings : [])) {
        /*
         * 四种视觉状态：
         *   ghost   跟随鼠标的"松手会得到什么"提示——很淡、虚线
         *   preview 正在拖的那条线——虚线 + 明显，端点带圆点
         *   selected 已选中——加粗
         *   普通/复权不一致——实线 / 虚线 + 警示色
         */
        const isGhost = s.ghost === true
        const dash = isGhost ? '3 3' : (s.preview ? '5 4' : (s.staleAdjust ? '4 3' : null))
        // 颜色优先级：幽灵/预览用系统色（表示"还没定"）→ 复权不一致用警示色 → 用户选的颜色 → 默认品牌色
        const userColor = drawingColorCss(s.color)
        const color = isGhost ? 'var(--dsw-alias-label-secondary)'
          : s.preview ? 'var(--dsw-alias-link)'
            : (s.staleAdjust ? 'var(--dsw-alias-state-warn-primary)' : (userColor || 'var(--dsw-alias-brand-primary)'))
        // 线宽：用户两次反馈偏粗，再收细一档（0.8 / 1.2 / 1.5）
        const width = s.selected ? 1.5 : (s.preview ? 1.2 : 0.8)
        const common = { stroke: color, strokeWidth: width, fill: 'none' }
        if (dash) common.strokeDasharray = dash
        if (isGhost) common.opacity = 0.55

        /** 画锚点的小圆点（拖拽时能看清会落在哪根 K 线上） */
        const anchorDots = (points) => points.flatMap((p, k) => [
          h('circle', {
            key: 'dr-dot' + s.id + k, cx: xC(p.i), cy: yP(p.price), r: isGhost ? 2.2 : 2.8,
            fill: color, stroke: 'var(--dsw-alias-bg-base)', strokeWidth: 1, opacity: isGhost ? 0.7 : 1,
          }),
        ])

        if (s.type === 'hline') {
          // 价格可能来自 price（已解析/幽灵）或 points[0].price（草稿）——
          // 只认 price 会让拖动中的预览线变成 NaN 而不可见（踩过的 bug）
          const price = Number.isFinite(s.price) ? s.price
            : (s.points && s.points[0] ? s.points[0].price : null)
          if (!Number.isFinite(price)) continue
          const y = yP(price)
          drawingMarks.push(h('line', {
            key: 'dr-h' + s.id, x1: PAD_L, x2: PAD_L + plotW, y1: y, y2: y, ...common,
          }))
          if (s.preview) drawingMarks.push(...anchorDots(s.points))
          if (!isGhost) {
            drawingMarks.push(h('text', {
              key: 'dr-ht' + s.id, x: PAD_L + 2, y: y - 3, fontSize: 10, fill: color,
            }, (s.label ? s.label + ' ' : '') + fmt(price)))
          }
        } else if (s.type === 'trend' && s.points.length === 2) {
          const [a, b] = s.points
          // 线段/射线/直线：统一按延伸方式**裁剪到画布**（锚点可能投影在画布外）
          const seg = extendLine(xC(a.i), yP(a.price), xC(b.i), yP(b.price),
            { x0: PAD_L, x1: PAD_L + plotW, y0: PAD_T, y1: PAD_T + priceH }, s.ext || 'segment')
          if (seg) {
            drawingMarks.push(h('line', {
              key: 'dr-t' + s.id, x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2, ...common,
            }))
          }
          // 只有线段模式才把锚点画成点：射线/直线延长后，锚点只是定义用的两个位置
          if (!isGhost && (!s.ext || s.ext === 'segment')) drawingMarks.push(...anchorDots(s.points))
          if (s.label && !isGhost && seg) {
            const mx = (xC(a.i) + xC(b.i)) / 2
            const my = (yP(a.price) + yP(b.price)) / 2
            drawingMarks.push(h('text', {
              key: 'dr-tt' + s.id,
              x: Math.min(Math.max(mx + 4, PAD_L + 4), PAD_L + plotW - 60),
              y: Math.min(Math.max(my - 4, PAD_T + 10), PAD_T + priceH - 2),
              fontSize: 10, fill: color,
            }, s.label))
          }
        } else if (s.type === 'circle' && s.points.length === 2) {
          // **圆心 + 圆上一点**：半径取两点之间的**价格差**（不是连线长度）。
          // 用户指定：半径应当由"价格差"决定——这样拖动时调的是价格幅度，
          // 与 K 线的价格轴直接对应，而不是一个被横纵比例搅在一起的斜距。
          const [center, edge] = s.points
          const cx = xC(center.i); const cy = yP(center.price)
          const r = Math.abs(yP(edge.price) - cy)
          const dPrice = Math.abs(edge.price - center.price)
          if (r > 0.5) {
            drawingMarks.push(h('circle', {
              key: 'dr-c' + s.id, cx, cy, r, ...common,
            }))
            /*
             * 平时**不画**半径锚点：用户会把它误当成"自己不小心画的一个点"。
             * 只在选中时用一个小点提示圆心位置（便于理解圆的锚定处），
             * 半径点则始终不画——圆的形状已经把半径表达清楚了。
             */
            if (s.selected || s.preview) {
              drawingMarks.push(h('circle', {
                key: 'dr-cc' + s.id, cx, cy, r: 1.8, fill: color, stroke: 'none', opacity: 0.9,
              }))
            }
            if (!isGhost) {
              drawingMarks.push(h('text', {
                key: 'dr-r' + s.id, x: cx + r + 4, y: cy + 3, fontSize: 10, fill: color,
              }, (s.label ? s.label + ' ' : '') + '±' + fmt(dPrice)))
            }
          } else if (s.label && !isGhost) {
            drawingMarks.push(h('text', {
              key: 'dr-r0' + s.id, x: cx + 6, y: cy + 3, fontSize: 10, fill: color,
            }, s.label))
          }
        } else if (s.type === 'measure' && s.points && s.points.length === 2) {
          // 测幅：两点之间的涨跌幅 / 价差 / 相隔根数（临时显示，不落库）
          const [ma, mb] = s.points
          const x1 = xC(ma.i); const y1 = yP(ma.price)
          const x2 = xC(mb.i); const y2 = yP(mb.price)
          const mCommon = {
            stroke: color, strokeWidth: width, fill: 'none', opacity: isGhost ? 0.7 : 1,
          }
          if (dash) mCommon.strokeDasharray = dash
          drawingMarks.push(h('line', { key: 'ms-l' + s.id, x1, y1, x2, y2, ...mCommon }))
          // 两端各一条短竖线，便于看出测的是哪两根
          for (const [k, x, y] of [[0, x1, y1], [1, x2, y2]]) {
            drawingMarks.push(h('line', {
              key: 'ms-t' + s.id + k, x1: x, y1: y - (k ? 0 : 4), x2: x, y2: y + (k ? 4 : 0),
              stroke: color, strokeWidth: 1, opacity: 0.9,
            }))
          }
          const pct = ma.price ? ((mb.price - ma.price) / ma.price) * 100 : null
          // 注意别把变量命名成 bars——那会遮蔽图表自己的 K 线数组
          const spanBars = Math.abs(Math.round(mb.i) - Math.round(ma.i))
          const text = (pct === null ? '' : (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%  ')
            + (mb.price - ma.price >= 0 ? '+' : '') + fmt(mb.price - ma.price) + '  '
            + spanBars + ' 根'
          const tx = Math.max(PAD_L + 4, Math.min(x2 + 6, PAD_L + plotW - 96))
          const ty = Math.max(PAD_T + 12, Math.min((y1 + y2) / 2, PAD_T + priceH - 4))
          drawingMarks.push(h('text', {
            key: 'ms-x' + s.id, x: tx, y: ty, fontSize: 11, fill: color,
            stroke: 'var(--dsw-alias-bg-base)', strokeWidth: 3, paintOrder: 'stroke',
          }, text))
        } else if (s.type === 'marker' && s.points.length === 1) {
          const p = s.points[0]
          const x = xC(p.i)
          const y = yP(p.price)
          drawingMarks.push(h('circle', {
            key: 'dr-m' + s.id, cx: x, cy: y, r: isGhost ? 3.5 : 5,
            fill: 'none', stroke: color, strokeWidth: 1.4, opacity: isGhost ? 0.55 : 1,
          }))
          if (s.label && !isGhost) {
            drawingMarks.push(h('text', { key: 'dr-mt' + s.id, x: x + 6, y: y - 4, fontSize: 10, fill: color }, s.label))
          }
        }
      }

      // 选中图形旁的**浮动调色板**：颜色贴着线/形状，而不是丢在图表下方
      const paletteMarks = []
      if (colorPalette && Number.isFinite(colorPalette.x)) {
        const { x, y, current, onPick } = colorPalette
        // ⚠️ 调色板必须**独占自己的指针事件**：
        // 它画在图表 SVG 里，而图表容器的 onPointerDown/onClick 会接管指针——
        // 不拦的话，点色块等于"又在画下一条线"（或触发选中判定把它自己关掉）。
        const stop = (e) => { e.stopPropagation() }
        paletteMarks.push(h('rect', {
          key: 'pal-bg', x: x - 4, y: y - 4, width: PALETTE_W, height: 22, rx: 6,
          fill: 'var(--dsw-alias-bg-overlay)', stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 0.6,
          onPointerDown: stop, onClick: stop,
        }))
        DRAW_COLORS.forEach((c, k) => {
          const cx = x + 8 + k * 18
          const cy = y + 7
          const isCur = (current || '') === c.k
          paletteMarks.push(h('circle', {
            key: 'pal-' + c.k, cx, cy, r: 6.5,
            fill: drawingColorCss(c.k) || 'var(--dsw-alias-brand-primary)',
            stroke: isCur ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)',
            strokeWidth: isCur ? 1.6 : 0.6,
            style: { cursor: 'pointer' },
            onPointerDown: stop,
            onClick: (e) => { e.stopPropagation(); onPick(c.k) },
          }))
          paletteMarks.push(h('title', { key: 'pal-t' + c.k }, c.label))
        })
      }

      // 图例
      const legendItems = [
        ...overlay.map((o, k) => ({ name: o.name, color: formulaLineColor(o, k), panel: '主图' })),
        ...sub.map((o, k) => ({ name: o.name, color: formulaLineColor(o, k + overlay.length), panel: hasSub ? '副图' : '' })),
      ]
      const legend = legendItems.length
        ? h('g', null, ...legendItems.slice(0, 8).map((it, k) => h('g', { key: 'lg' + k },
          h('rect', { x: PAD_L + k * 96, y: 0, width: 8, height: 8, rx: 2, fill: it.color }),
          h('text', { x: PAD_L + k * 96 + 12, y: 8, fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' },
            it.name + (it.panel ? ' · ' + it.panel : ''))
        )))
        : null

      return h('svg', {
        viewBox: `0 0 ${W} ${H}`, className: 'sl-chart',
        style: { width: '100%', height: 'auto', display: 'block', opacity: dimmed ? 0.5 : 1 },
        onMouseLeave: () => onHover && onHover(null),
      },
        ...gridLines,
        maPath ? h('path', { d: maPath, fill: 'none', stroke: 'var(--dsw-alias-state-warn-primary)', strokeWidth: 1.2, opacity: 0.55 }) : null,
        ...candles, ...vols2,
        ...overlayPaths, ...subMarks, ...signalMarks, ...drawingMarks,
        h('text', { x: PAD_L, y: H - 4, fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' },
          bars[0]?.time || ''),
        // 结束日期靠右对齐（两个日期都挤在左边不好读）
        h('text', {
          x: PAD_L + plotW, y: H - 4, fontSize: 10, textAnchor: 'end',
          fill: 'var(--dsw-alias-label-secondary)',
        }, bars.at(-1)?.time || ''),
        h('text', { x: PAD_L, y: volTop - 2, fontSize: 10, fill: 'var(--dsw-alias-label-secondary)' }, '成交量'),
        legend,
        // 透明覆盖层做逐根读数
        ...bars.map((b, i) => h('rect', {
          key: 'hit' + i, x: xL(i), y: PAD_T, width: plotW / n, height: priceH,
          fill: 'transparent', onMouseEnter: () => onHover && onHover(b),
        })),
        /*
         * ⚠️ 浮动调色板必须画在**最后**——即命中层之上。
         * 上面那些透明 hover 矩形铺满整个价格区，先画调色板就会被它们盖住：
         * 点击落在 hover 矩形上 → 调色板的 onClick 根本不触发 →
         * 表现为"点了完全没反应"（这就是颜色改不了的真实原因）。
         */
        ...paletteMarks,
        // 钉住的那根 K 线：竖线标出（配合下方读数，点一下就能盯住某一天）
        pinnedRel !== null && pinnedRel >= 0 && pinnedRel < n
          ? h('line', {
            key: 'pinned', x1: xC(pinnedRel), x2: xC(pinnedRel), y1: PAD_T, y2: PAD_T + priceH,
            stroke: 'var(--dsw-alias-label-secondary)', strokeWidth: 0.8, strokeDasharray: '3 3',
            style: { pointerEvents: 'none' },
          })
          : null,
        // 框选矩形（最上层，纯展示、不吃指针）
        marquee && Math.abs(marquee.x1 - marquee.x0) > 0.5
          ? h('rect', {
            key: 'marquee',
            x: Math.min(marquee.x0, marquee.x1), y: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0),
            fill: 'var(--dsw-alias-bg-overlay)', fillOpacity: 0.25,
            stroke: 'var(--dsw-alias-link)', strokeWidth: 0.8, strokeDasharray: '4 3',
            style: { pointerEvents: 'none' },
          })
          : null
      )
    }

    // ─────────────────────────── 主面板 ───────────────────────────
    function Panel() {
      const [last, setLast] = useLocal(LS_LAST, { symbol: 'SH600519', name: '贵州茅台' })
      // 三栏布局：左（自选/搜索）| 中（图表+底部 tab）| 分隔条 | 右（AI 助手，宽度可调）
      const bodyRef = useRef(null)
      const pane = useResizablePane(bodyRef)
      const [current, setCurrent] = useState(last)
      const [bars, setBars] = useState([])
      const [quote, setQuote] = useState(null)
      const [err, setErr] = useState(null)
      const [hover, setHover] = useState(null)
      const [tf, setTf] = useState('1d')
      const [adjust, setAdjust] = useState('qfq')
      // 可视窗口：count=可见根数（缩放），end=右边缘下标（平移）。
      // 缩放级别跨会话记住（看盘软件也记住）；平移位置在换标的/周期时回到最新。
      const [viewCount, setViewCount] = useLocal(CHART_VIEW.countKey, CHART_VIEW.default)
      const [viewEnd, setViewEnd] = useState(-1)   // -1 = 尚未定位，加载后置为最新
      const [tab, setTab] = useState('news')
      const [extra, setExtra] = useState({})
      const [loading, setLoading] = useState(false)
      // Research Notebook
      const [notes, setNotes] = useState([])
      const [notesStats, setNotesStats] = useState(null)
      const [notesLoading, setNotesLoading] = useState(false)
      const [noteFormOpen, setNoteFormOpen] = useState(false)
      // 指标公式：已导入清单 / 已叠加到图上的 / 各公式在当前标的上的求值结果
      const [formulas, setFormulas] = useState([])
      const [appliedFormulas, setAppliedFormulas] = useLocal('stock-lab:appliedFormulas', [])
      const [formulaRuns, setFormulaRuns] = useState({})
      const [formulasLoading, setFormulasLoading] = useState(false)
      const [formulaImportText, setFormulaImportText] = useState('')
      const [formulaImportName, setFormulaImportName] = useState('')
      const [formulaImportMsg, setFormulaImportMsg] = useState(null)
      const [formulaImporting, setFormulaImporting] = useState(false)
      // 手工画线（图表标注）：从数据根目录读取，锚点是「日期 + 价格」
      const [drawings, setDrawings] = useState([])
      const [drawingWarnings, setDrawingWarnings] = useState([])
      const [drawTool, setDrawTool] = useState(null)      // null=不画（拖动=框选放大）· select=框选图形 · 四种画线工具
      const [selectedIds, setSelectedIds] = useState([])  // 多选（框选后可批量删除）
      const [marqueeRect, setMarqueeRect] = useState(null)
      const [measure, setMeasure] = useState(null)        // 测幅（临时，不落库）
      const [pinnedBar, setPinnedBar] = useState(null)    // 点击某根 K 线后钉住它的读数
      const [pinnedIdx, setPinnedIdx] = useState(null)
      const [snapOn, setSnapOn] = useState(true)          // 吸附开关（Ctrl 可临时取反）
      const [draftDrawing, setDraftDrawing] = useState(null)
      const [hoverSnap, setHoverSnap] = useState(null)     // 按下前的"会吸附到这里"提示
      const [undoStack, setUndoStack] = useState([])       // 撤销栈（画线是易错操作，撤销要比"选中→删除"顺手）
      const [selectedDrawingId, setSelectedDrawingId] = useState(null)
      const [selPoint, setSelPoint] = useState(null)      // 选中/落笔时的鼠标位置（调色板贴这里）
      const [ctrlHeld, setCtrlHeld] = useState(false)     // Ctrl 是否按住（吸附显示要跟着它变）
      const [drawingNote, setDrawingNote] = useState(null)
      // 选中画线的备注草稿（标签 + 为什么画在这里）
      const [drawingEdit, setDrawingEdit] = useState({ label: '', reason: '' })
      const [drawingExt, setDrawingExt] = useState('segment')   // 趋势线的延伸方式（选中时显示）
      const [drawingColor, setDrawingColor] = useState(null)     // 画线颜色（色名；null=默认）

      useEffect(() => {
        let alive = true
        // 换标的时收起画线状态：选中项与草稿都只对上一个标的有效
        setDrawTool(null)
        setDraftDrawing(null)
        setHoverSnap(null)
        setSelectedDrawingId(null)
        setDrawingNote(null)
        setUndoStack([])     // 撤销栈只对当前标的有效（跨标的撤销会张冠李戴）
        apiFetch('/drawings', { symbol: current.symbol })
          .then((d) => { if (alive) { setDrawings(d.drawings || []); setDrawingWarnings(d.warnings || []) } })
          .catch((e) => { if (alive) { setDrawings([]); setDrawingWarnings([String(e?.message || e)]) } })
        return () => { alive = false }
      }, [current.symbol])

      const refreshFormulas = useCallback(async () => {
        setFormulasLoading(true)
        try {
          const r = await apiFetch('/formula/list', { symbol: current.symbol, limit: 200 })
          setFormulas(r.formulas || [])
        } catch { /* 公式库不可用时静默 */ }
        finally { setFormulasLoading(false) }
      }, [current.symbol])

      useEffect(() => { refreshFormulas() }, [refreshFormulas])

      // 对已启用的公式求值。
      // ⚠️ 必须在**整个缓冲区**上求，而不是只算可见窗口：
      //   MA20 在窗口最左边那根，需要它之前的 19 根；只按窗口算会让左边缘的指标变成空值，
      //   而且每平移一格就要重算一遍（慢，且线会随平移跳动）。
      //   所以按缓冲区长度求一次，图表再按窗口切片——这样平移/缩放完全不触发重算。
      useEffect(() => {
        let alive = true
        if (appliedFormulas.length === 0) { setFormulaRuns({}); return () => { alive = false } }
        const load = async () => {
          const out = {}
          const bufferCount = bars.length > 0 ? bars.length : BARS_BUFFER
          for (const id of appliedFormulas) {
            try {
              const r = await apiFetch('/formula/run', {
                id, symbol: current.symbol, count: bufferCount, timeframe: tf, adjust,
              })
              out[id] = r
            } catch (e) {
              out[id] = { ok: false, errors: [String(e?.message || e)] }
            }
          }
          if (alive) setFormulaRuns(out)
        }
        load()
        return () => { alive = false }
      }, [appliedFormulas, current.symbol, tf, adjust, bars.length])

      const toggleFormula = useCallback((id) => {
        setAppliedFormulas((prev) => {
          const list = Array.isArray(prev) ? prev : []
          return list.includes(id) ? list.filter((x) => x !== id) : [...list, id]
        })
      }, [setAppliedFormulas])

      const importFormula = useCallback(async () => {
        const name = String(formulaImportName || '').trim()
        const text = String(formulaImportText || '')
        if (!name) { setFormulaImportMsg('请先填公式名字'); return }
        if (!text.trim()) { setFormulaImportMsg('公式内容为空'); return }
        setFormulaImporting(true); setFormulaImportMsg(null)
        try {
          const r = await fetch(API + '/formula/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, text, symbol: current.symbol }),
          })
          const j = await r.json()
          if (!j.ok) throw new Error(j.error || '导入失败')
          const f = j.data
          const parts = []
          if (f.ok) parts.push(`已导入「${f.name}」，${(f.outputs || []).length} 条输出线`)
          else parts.push(`已保存但解析失败：${(f.errors || []).slice(0, 2).join('；')}`)
          if ((f.futureFunctions || []).length) parts.push(`⚠️ 含未来函数 ${f.futureFunctions.join('、')}（默认不计算）`)
          if ((f.ignoredDrawCalls || []).length) parts.push(`忽略绘图指令 ${f.ignoredDrawCalls.join('、')}`)
          setFormulaImportMsg(parts.join(' · '))
          setFormulaImportText(''); setFormulaImportName('')
          await refreshFormulas()
          if (f.ok) toggleFormula(f.id)   // 导入成功就直接画到图上
        } catch (e) { setFormulaImportMsg('导入失败：' + e.message) }
        finally { setFormulaImporting(false) }
      }, [formulaImportName, formulaImportText, current.symbol, refreshFormulas, toggleFormula])

      const refreshNotes = useCallback(async () => {
        setNotesLoading(true)
        try {
          const [list, st] = await Promise.all([
            apiFetch('/research/list', { symbol: current.symbol, limit: 50 }),
            apiFetch('/research/stats'),
          ])
          setNotes(list.notes || [])
          setNotesStats(st)
        } catch { /* 研究库不可用时静默 */ }
        finally { setNotesLoading(false) }
      }, [current.symbol])

      useEffect(() => {
        if (tab === 'notes') refreshNotes()
      }, [tab, current.symbol, refreshNotes])

      const select = useCallback((symbol, name) => {
        setCurrent({ symbol, name })
        setLast({ symbol, name })
      }, [setLast])

      // K线：一次取**整段缓冲区**（不是可视根数），缩放/平移都在这张数据上做。
      // 换标的/周期/复权时把窗口拉回最新（与看盘软件一致：切股票就是看最新）。
      useEffect(() => {
        let alive = true
        setLoading(true); setErr(null)
        setViewEnd(-1)   // -1 = 跟随最新
        apiFetch('/kline', { symbol: current.symbol, timeframe: tf, adjust, count: BARS_BUFFER })
          .then((d) => { if (alive) setBars(d || []) })
          .catch((e) => { if (alive) { setErr(e.message); setBars([]) } })
          .finally(() => { if (alive) setLoading(false) })
        return () => { alive = false }
      }, [current.symbol, tf, adjust])

      // 行情（轮询 5s）
      useEffect(() => {
        let alive = true
        const load = () => apiFetch('/quote', { symbols: current.symbol })
          .then((d) => { if (alive && d && d[0]) setQuote(d[0]) })
          .catch(() => { })
        load()
        const t = setInterval(load, 5000)
        return () => { alive = false; clearInterval(t) }
      }, [current.symbol])

      // 跟踪 Ctrl/Cmd 是否按住：吸附按钮要显示**当前实际生效**的状态，
// 而不是只显示基础开关——否则用户按着 Ctrl 画完，看到"吸附开"会以为没生效。
      useEffect(() => {
        const isMod = (e) => e.key === 'Control' || e.key === 'Meta'
        const down = (e) => { if (isMod(e)) setCtrlHeld(true) }
        const up = (e) => { if (isMod(e)) setCtrlHeld(false) }
        const clear = () => setCtrlHeld(false)     // 切窗口时按键状态会丢，必须清掉
        window.addEventListener('keydown', down)
        window.addEventListener('keyup', up)
        window.addEventListener('blur', clear)
        return () => {
          window.removeEventListener('keydown', down)
          window.removeEventListener('keyup', up)
          window.removeEventListener('blur', clear)
        }
      }, [])

      // tab 数据
      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            if (tab === 'news' && !extra.news) {
              const d = await apiFetch('/news', { symbol: current.symbol, limit: 12 })
              if (alive) setExtra((x) => ({ ...x, news: d.news || [] }))
            }
            if (tab === 'fin' && !extra.fin) {
              const d = await apiFetch('/financials', { symbol: current.symbol })
              if (alive) setExtra((x) => ({ ...x, fin: d }))
            }
            if (tab === 'flow' && !extra.flow) {
              const d = await apiFetch('/moneyflow', { symbol: current.symbol })
              if (alive) setExtra((x) => ({ ...x, flow: d }))
            }
          } catch { /* 忽略 */ }
        }
        load()
        return () => { alive = false }
      }, [tab, current.symbol, extra.news, extra.fin, extra.flow])

      useEffect(() => { setExtra({}) }, [current.symbol])

      const total = bars.length
      // 有效窗口 + 可见切片。end < 0 表示"跟随最新"（见 resolveView）
      const view = resolveView(viewCount, viewEnd, total)
      const range = sliceRange(view, total)
      const visBars = range.end >= range.start ? bars.slice(range.start, range.end + 1) : []
      const atLatest = viewEnd < 0 || view.end >= total - 1
      // 吸附的**实际生效**状态：按住 Ctrl/Cmd 时取反（与图表里的判定保持一致）
      const snapEffective = ctrlHeld ? !snapOn : snapOn

      /** 应用窗口变化：停在最右端就记回"跟随最新"(-1)，否则记绝对下标 */
      const applyView = (next) => {
        // 只有根数真的变了才写 localStorage：否则每平移一步都会写一次
        if (next.count !== viewCount) setViewCount(next.count)
        setViewEnd(next.end >= total - 1 ? -1 : next.end)
      }
      const onZoom = (factor, anchorInWindow) => {
        setHover(null)
        const anchor = anchorInWindow === null || anchorInWindow === undefined
          ? null
          : range.start + anchorInWindow
        applyView(zoomView(view, factor, total, anchor))
      }
      const onPan = (delta) => { setHover(null); applyView(panView(view, delta, total)) }
      const onJump = (where) => { setHover(null); applyView(jumpView(view, where, total)) }

      /** 测幅：拖动一次画完，或点两下（与画线同一套手感）。
       *  点只存**日期 + 价格**——存下标会在缩放/平移后漂到别的 K 线上。 */
      const onMeasureChange = (next) => {
        if (!next) { setMeasure(null); return }
        const norm = (p) => (p && p.date && Number.isFinite(p.price) ? { date: p.date, price: p.price } : null)
        const a = norm(next.a)
        const b = norm(next.b)
        if (!a || !b) { setMeasure(null); return }
        setMeasure({ a, b, pending: !next.done })
      }

      /** 统一的工具切换：离开测幅就清掉结果（它只是"看一眼"，不该常驻在图上） */
      const pickTool = (k, tip) => {
        const next = drawTool === k ? null : k
        setDrawTool(next)
        setDraftDrawing(null)
        setHoverSnap(null)
        if (next !== 'measure') setMeasure(null)
        setDrawingNote(next ? (tip || null) : null)
      }

      const shown = (pinnedIdx !== null ? bars[pinnedIdx] : null) || hover || visBars.at(-1) || null
      const priceCls = cls(quote?.changePct)

      // 组装要画到图上的公式线。
      // 分两步：① 在**缓冲区**上分类（量纲判断用整段更稳）② 按窗口**切片**再交给图表。
      // 这样平移/缩放不会触发重算，左边缘的指标也不会因为窗口而变成空值。
      const chartOverlay = []
      const chartSub = []
      let chartSignals = null
      for (const id of appliedFormulas) {
        const r = formulaRuns[id]
        if (!r || !r.ok) continue
        const signalName = r.signals && !r.signals.notACondition ? r.signals.conditionName : null
        const c = classifyFormulaOutputs(bars, r.outputs, signalName)
        const cut = (o) => ({ ...o, values: sliceSeries(o.values, view, total) })
        chartOverlay.push(...c.overlay.map(cut))
        chartSub.push(...c.sub.map(cut))
        if (c.signalLines.length && r.signals && Array.isArray(r.signals.indices) && r.signals.indices.length) {
          // 信号下标是缓冲区绝对值 → 换算成窗口相对值，只保留落在这个窗口里的
          const inWindow = r.signals.indices
            .map((i) => Number(i) - range.start)
            .filter((i) => i >= 0 && i < visBars.length)
          if (inWindow.length > 0) {
            chartSignals = {
              indices: inWindow,
              conditionName: r.signals.conditionName,
              totalHits: Number(r.signals.hitCount) || r.signals.indices.length,
            }
          }
        }
      }
      const formulaFailed = appliedFormulas.filter((id) => formulaRuns[id] && !formulaRuns[id].ok).length

      // 画线：把「日期 + 价格」锚点解析成当前窗口下的可绘制几何。
      // 纯函数，因此这段几何逻辑可以离线测试（见 tests/client.test.mjs）。
      const dr = resolveDrawings(bars, range.start, drawings, adjust)
      const drawingIssueText = summarizeDrawingIssues(dr.issues)
      const drawingAllIssues = [...drawingWarnings, drawingIssueText].filter(Boolean)

      // 比例尺只算一处：图表与交互层共用（两边各算一份就会在叠加公式线时偏）
      const priceScale = computePriceScale(visBars, chartOverlay)
      // 命中测试/框选/调色板共用的几何（一处定义，避免各算一份而漂移）
      const chartGeo = {
        padL: CHART_GEO.PAD_L,
        padT: CHART_GEO.PAD_T,
        plotW: CHART_GEO.W - CHART_GEO.PAD_L - CHART_GEO.PAD_R,
        priceH: CHART_GEO.PRICE_H,
        n: Math.max(1, visBars.length),
      }
      const chartGeoHit = chartGeo
      /** viewBox 的 x → **缓冲区绝对下标**（框选放大要把窗口下标换算回绝对下标） */
      const xToAbsIndex = (svgX) => {
        if (!(chartGeo.plotW > 0)) return null
        const rel = ((svgX - CHART_GEO.PAD_L) / chartGeo.plotW) * chartGeo.n - 0.5
        return Math.round(rel) + range.start
      }
      // 交给图表渲染的画线 = 已解析的 + 正在画的预览 + 幽灵提示；选中的（含多选）加粗
      const chartDrawings = [
        ...dr.shapes.map((s) => (selectedIds.includes(s.id) ? { ...s, selected: true } : s)),
        ...(draftDrawing ? [draftDrawing] : []),
        ...(hoverSnap && drawTool && drawTool !== 'select' && drawTool !== 'measure' && !draftDrawing
          ? [ghostFromPoint(drawTool, hoverSnap)].filter(Boolean) : []),
      ]
      // 测幅（临时显示，不落库；**按日期解析**，缩放平移都不会漂）
      const measureShape = (() => {
        const m = resolveMeasure(measure, bars, range.start)
        return m ? { id: '__measure', type: 'measure', points: [m.a, m.b], color: 'blue', ext: null } : null
      })()
      if (measureShape) chartDrawings.push(measureShape)
      // 多选时的提示（框选后直接 Delete 就能批量删）
      const multiNote = selectedIds.length > 1 ? `已框选 ${selectedIds.length} 条（按 Delete 批量删除）` : null

      /** 记一步撤销（最多保留 30 步） */
      const pushUndo = (entry) => setUndoStack((s) => [...s.slice(-29), entry])

      /**
       * 撤销上一次画线操作。
       * 为什么必须做：画错之后要去点「选择」→ 找到那条线 → 点「删除选中」，太绕；
       * 而画线本身是**高频易错**操作，撤销的手感直接决定敢不敢随手画。
       */
      const undoDrawing = async () => {
        // ⚠️ 从**当前渲染的 state** 读栈顶，而不是在 setState 的 updater 里读：
        // updater 何时执行由 React 决定，写在里面的副作用可能晚于下面这行判断，
        // 结果是"栈里有东西却提示没有可撤销"——静默失效。
        if (undoStack.length === 0) { setDrawingNote('没有可撤销的操作'); return }
        const entry = undoStack[undoStack.length - 1]
        setUndoStack((s) => s.slice(0, -1))
        try {
          if (entry.kind === 'create') {
            const r = await fetch(API + '/drawings/remove', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ symbol: current.symbol, id: entry.id }),
            }).then((x) => x.json())
            if (!r.ok) throw new Error(r.error || '撤销失败')
            setDrawingNote('已撤销刚画的那条线')
          } else if (entry.kind === 'delete') {
            const r = await fetch(API + '/drawings/add', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...entry.drawing, symbol: current.symbol }),
            }).then((x) => x.json())
            if (!r.ok) throw new Error(r.error || '撤销删除失败')
            setDrawingNote('已恢复被删的那条线')
          } else if (entry.kind === 'memo') {
            const r = await fetch(API + '/drawings/add', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...entry.drawing, symbol: current.symbol }),
            }).then((x) => x.json())
            if (!r.ok) throw new Error(r.error || '撤销说明修改失败')
            setDrawingNote('已恢复原来的说明')
          }
          const fresh = await apiFetch('/drawings', { symbol: current.symbol })
          setDrawings(fresh.drawings || [])
          setDrawingWarnings(fresh.warnings || [])
        } catch (e) {
          setDrawingNote('撤销失败：' + (e?.message || e))
        }
      }

      // 选中图形的浮动调色板：**贴在鼠标点选的位置**（没有点击位置时退回贴图形）
      const selShape = selectedDrawingId ? dr.shapes.find((s) => s.id === selectedDrawingId) : null
      const shapeAnchor = selShape ? paletteAnchor(selShape, chartGeo, priceScale) : null
      const palAnchor = (() => {
        const base = selPoint && Number.isFinite(selPoint.x)
          ? { x: selPoint.x + 10, y: selPoint.y - 24 }
          : shapeAnchor
        return base ? clampPalette(base, chartGeo) : null
      })()
      const paletteRect = palAnchor
        ? { x: palAnchor.x - 4, y: palAnchor.y - 4, w: PALETTE_W, h: 22 }
        : null
      const colorPalette = palAnchor
        ? {
          x: palAnchor.x, y: palAnchor.y, current: drawingColor,
          onPick: (key) => {
            setDrawingColor(key)
            saveDrawingMemo(selectedDrawingId, drawingEdit.label, drawingEdit.reason, drawingExt, key)
          },
        }
        : null

      /**
       * 框选结果。三种用途分开处理：
       *   click  —— 只是点了一下（小位移）：单选
       *   select —— 选择模式下拖出框：多选图形（为批量删除）
       *   zoom   —— 没选工具时拖出框：把视图缩放到这段横向范围
       */
      const onMarqueeDone = (rect, kind, vb) => {
        if (kind === 'pickbar') {
          // 点一下某根 K 线 → 钉住它的读数（再点同一根 = 取消）
          const rel = Math.max(0, Math.min(visBars.length - 1,
            Math.round(((vb.x - CHART_GEO.PAD_L) / chartGeo.plotW) * chartGeo.n - 0.5)))
          const abs = rel + range.start
          setPinnedIdx((prev) => (prev === abs ? null : abs))
          return
        }
        if (kind === 'click') {
          const hit = hitTestDrawings(dr.shapes, vb.x, vb.y, 6, chartGeoHit, priceScale)
          applySelect(hit, vb)
          return
        }
        if (kind === 'select') {
          const ids = hitTestRect(dr.shapes, rect, chartGeoHit, priceScale)
          setSelectedIds(ids)
          setSelectedDrawingId(ids.length === 1 ? ids[0] : null)
          if (ids.length === 0) setDrawingNote('框选范围内没有画线')
          else if (ids.length === 1) setDrawingNote('已选中 1 条（按 Delete 删除）')
          else setDrawingNote(`已框选 ${ids.length} 条（按 Delete 批量删除）`)
          setSelPoint(null)
          return
        }
        // zoom：横向范围 → 视图（价格轴按可见 K 线自动定，纵向不参与）
        const i0 = xToAbsIndex(rect.x0)
        const i1 = xToAbsIndex(rect.x1)
        if (!Number.isFinite(i0) || !Number.isFinite(i1)) return
        const lo = Math.max(0, Math.min(i0, i1))
        const hi = Math.min(total - 1, Math.max(i0, i1))
        const count = Math.max(CHART_VIEW.minCount || 5, hi - lo + 1)
        setViewCount(count)
        setViewEnd(hi)
        setDrawingNote(null)
      }

      /** 统一处理"选中一条"（点击/小位移） */
      const applySelect = (id, point) => {
        setSelectedIds(id ? [id] : [])
        setSelectedDrawingId(id)
        if (id) {
          const s = dr.shapes.find((x) => x.id === id)
          const raw = drawings.find((x) => x.id === id)
          setDrawingEdit({ label: (raw && raw.label) || '', reason: (raw && raw.reason) || '' })
          setDrawingExt((raw && raw.ext) || 'segment')
          setDrawingColor((raw && raw.color) || null)
          setSelPoint(point || null)
          setDrawingNote(s ? `已选中${s.label ? '「' + s.label + '」' : '一条画线'}（按 Delete 删除，Ctrl+Z 撤销）` : null)
        } else {
          setDrawingNote(null)
          setSelPoint(null)
        }
      }

      /** 画完一条：落库（锚点带日期、复权模式，以及"为什么画在这里"留空待补） */
      const createDrawing = async (type, anchors, vb) => {
        try {
          const body = { symbol: current.symbol, type, anchors, adjust }
          // 趋势线默认射线（用户指定：延长到未来更有用）；颜色未选则用默认色
          if (type === 'trend') body.ext = drawingExt || 'ray'
          if (drawingColor) body.color = drawingColor
          const r = await fetch(API + '/drawings/add', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }).then((x) => x.json())
          if (!r.ok) throw new Error(r.error || '保存失败')
          const newId = r.data.drawing ? r.data.drawing.id : null
          if (newId) pushUndo({ kind: 'create', id: newId })
          const fresh = await apiFetch('/drawings', { symbol: current.symbol })
          setDrawings(fresh.drawings || [])
          setDrawingWarnings(fresh.warnings || [])
          setSelectedDrawingId(newId)
          setSelPoint(vb || null)
          setDrawingNote('已画一条' + (DRAW_TOOL_LABEL[type] || type)
            + '（' + anchors.map((a) => `${a.date} ${fmt(a.price)}`).join(' → ') + '）；Ctrl+Z 可撤销')
        } catch (e) {
          setDrawingNote('保存失败：' + (e?.message || e))
        }
      }

      const deleteDrawing = async (id) => {
        // id 可以是单个，也可以是数组（框选后批量删除）
        const ids = Array.isArray(id) ? id : [id]
        const victims = drawings.filter((d) => ids.includes(d.id))
        if (victims.length === 0) return
        try {
          for (const v of victims) {
            const r = await fetch(API + '/drawings/remove', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ symbol: current.symbol, id: v.id }),
            }).then((x) => x.json())
            if (!r.ok) throw new Error(r.error || '删除失败')
          }
          for (const v of victims) pushUndo({ kind: 'delete', drawing: v })   // 逐条可撤回
          const gone = new Set(victims.map((v) => v.id))
          setDrawings((prev) => prev.filter((d) => !gone.has(d.id)))
          setSelectedDrawingId(null)
          setSelectedIds([])
          setDrawingNote(victims.length === 1
            ? '已删除一条画线；Ctrl+Z 可恢复'
            : `已删除 ${victims.length} 条画线；Ctrl+Z 可逐条恢复`)
        } catch (e) {
          setDrawingNote('删除失败：' + (e?.message || e))
        }
      }

      /** 保存选中画线的标签 / 说明 / 延伸方式 / 颜色 */
      const saveDrawingMemo = async (id, label, reason, ext, color) => {
        const cur = drawings.find((d) => d.id === id)
        if (!cur) return
        try {
          const next = {
            symbol: current.symbol, id: cur.id, type: cur.type, anchors: cur.anchors,
            adjust: cur.adjust, label, reason,
          }
          if (cur.type === 'trend') next.ext = ext || cur.ext || 'ray'
          if (color !== undefined) next.color = color
          const r = await fetch(API + '/drawings/add', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(next),
          }).then((x) => x.json())
          if (!r.ok) throw new Error(r.error || '保存失败')
          pushUndo({ kind: 'memo', drawing: cur })       // 撤销回到改之前的版本
          const fresh = await apiFetch('/drawings', { symbol: current.symbol })
          setDrawings(fresh.drawings || [])
          setDrawingNote('已保存这条画线的说明')
        } catch (e) {
          setDrawingNote('保存说明失败：' + (e?.message || e))
        }
      }

      // 上报 context 给 Host（Context-aware AI）。
      // 放在窗口计算之后：chartRange 现在描述**用户实际在看的那一段**，
      // 而不是一个笼统的根数——用户平移进历史时，AI 也该知道。
      // 依赖里只放"会改变结论"的量（标的/周期/是否在最新/可见根数）：
      // 不把 range.start 放进去，否则每按一次左键都上报一次。
      useEffect(() => {
        fetch(API + '/context', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            currentStock: current.symbol,
            currentName: current.name || quote?.name || null,
            timeframe: tf,
            adjust,
            chartRange: visBars.length > 0
              ? (atLatest
                ? `最近 ${visBars.length} 根`
                : `${visBars.length} 根（历史区间，右端 ${visBars.at(-1).time}）`)
              : null,
            benchmark: 'IDX000300',
          }),
        }).catch(() => { })
      }, [current.symbol, tf, adjust, quote?.name, atLatest, visBars.length])

      return h('div', { className: 'sl-root' + (pane.dragging ? ' sl-dragging' : '') },
        h(TopBar, { onPick: (s) => select(s, null) }),
        h('div', { className: 'sl-body', ref: bodyRef },
          h(Sidebar, { current: current.symbol, onSelect: select }),
          h('div', { className: 'sl-main' },
            // 标题区
            h('div', { className: 'sl-head' },
              h('span', { className: 'sl-name' }, quote?.name || current.name || current.symbol),
              h('span', { className: 'sl-code' }, current.symbol),
              quote ? h('span', { className: 'sl-px ' + priceCls }, fmt(quote.price)) : null,
              quote ? h('span', { className: priceCls }, fmtPct(quote.changePct)) : null,
              quote?.flags?.st ? h('span', { className: 'sl-code', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, 'ST') : null,
              quote?.status === 'suspended' ? h('span', { className: 'sl-code' }, '停牌/无成交') : null
            ),
            // 工具条
            h('div', { className: 'sl-toolbar' },
              ...TIMEFRAMES.map((t) => h('button', {
                key: t.k, className: 'sl-btn' + (tf === t.k ? ' sl-btn-on' : ''), onClick: () => setTf(t.k),
              }, t.label)),
              h('span', { style: { width: 8 } }),
              ...ADJUSTS.map((a) => h('button', {
                key: a.k, className: 'sl-btn' + (adjust === a.k ? ' sl-btn-on' : ''), onClick: () => setAdjust(a.k),
              }, a.label))
              // 根数预设已去掉：缩放/平移直接在图上看（↑↓ 缩放 · ←→ 平移 · 滚轮缩放），
              // 四个固定档位既不够用（无法往回看），也占地方。
              ,
              h('span', { style: { width: 8 } }),
              // 画图工具**常驻**（用户反馈：没必要收起）。颜色不放在这里——
              // 颜色在选中图形时贴着图形显示（见图表里的浮动调色板）。
              h('span', { className: 'sl-tool-palette' },
                ...DRAW_TOOLS.map((t) => h('button', {
                  key: t.k,
                  className: 'sl-btn' + (drawTool === t.k ? ' sl-btn-on' : ''),
                  title: t.tip,
                  onClick: () => pickTool(t.k, t.tip),
                }, t.label))
              ),
              // 只看不改的工具（选择 / 测幅）单独一组：测幅跟画图不是一类东西
              h('span', { className: 'sl-tool-palette' },
                ...VIEW_TOOLS.map((t) => h('button', {
                  key: t.k,
                  className: 'sl-btn' + (drawTool === t.k ? ' sl-btn-on' : ''),
                  title: t.tip,
                  onClick: () => pickTool(t.k, t.tip),
                }, t.label)),
                // 吸附开关：显示**当前实际生效**的状态（按住 Ctrl 会取反，按钮跟着变）
                h('button', {
                  className: 'sl-btn' + (snapEffective ? ' sl-btn-on' : ''),
                  title: snapEffective
                    ? '吸附开：会吸到最近 K 线的开/高/低/收；按住 Ctrl 可临时关掉'
                    : '吸附关：价格按鼠标位置取；按住 Ctrl 可临时打开',
                  onClick: () => setSnapOn(!snapOn),
                }, snapEffective ? '吸附开' : '吸附关'),
                h('button', {
                  className: 'sl-btn', title: '撤销上一次画线/删除/改说明（Ctrl+Z）',
                  onClick: () => undoDrawing(),
                }, '撤销')
              )
            ),
            // 逐根读数
            shown ? h('div', { className: 'sl-note', style: { fontVariantNumeric: 'tabular-nums' } },
              // 点过的 K 线会被钉住（不点就跟随鼠标；鼠标离开则显示最后一根）
              (pinnedIdx !== null ? '📌 ' : '')
              + `${shown.time}  开 ${fmt(shown.open)}  高 ${fmt(shown.high)}  低 ${fmt(shown.low)}  收 ${fmt(shown.close)}  量 ${fmtBig(shown.volume)}`
              // 相对前一根的涨跌幅（没有前值就不显示，不编数字）
              + (() => {
                const i = bars.findIndex((b) => b.time === shown.time)
                const prev = i > 0 ? bars[i - 1] : null
                if (!prev || !prev.close || typeof shown.close !== 'number') return ''
                const pct = ((shown.close - prev.close) / prev.close) * 100
                return `  涨跌 ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`
              })()
              + (pinnedIdx !== null ? '　（点同一根取消）' : '')
            ) : null,
            // 图（可聚焦，接键盘/滚轮；缩放平移都在这一层）
            err ? h('div', { className: 'sl-err' }, 'K线加载失败：' + err)
              : loading && bars.length === 0 ? h('div', { className: 'sl-note' }, '加载K线…')
                : h(ChartStage, {
                  view,
                  geo: chartGeo,
                  scale: priceScale,
                  bars: visBars,
                  shapes: dr.shapes,
                  selectedIds,
                  tool: drawTool,
                  snapOn,
                  paletteRect,
                  measure,
                  draft: draftDrawing,
                  onDraftChange: setDraftDrawing,
                  onHoverSnap: setHoverSnap,
                  onUndo: undoDrawing,
                  onMarqueeChange: setMarqueeRect,
                  onMarqueeDone,
                  onSelectNone: () => { setSelectedIds([]); setSelectedDrawingId(null); setSelPoint(null); setDrawingNote(null); setPinnedIdx(null); setMeasure(null) },
                  onExitTool: () => {
                    // Esc 从画线/测幅退到「选择」模式（而不是什么都不选）——用户要求
                    setDrawTool('select')
                    setDraftDrawing(null)
                    setHoverSnap(null)
                    setMeasure(null)
                    setDrawingNote('已退出画图，进入选择模式')
                  },
                  onMeasure: onMeasureChange,
                  onCreate: createDrawing,
                  onDelete: deleteDrawing,
                  onZoom,
                  onPan,
                  onJump,
                  hint: (range.start === 0 && total > 0)
                    ? `已到数据起点（共 ${total} 根，最早 ${bars[0] ? bars[0].time : ''}）`
                    : (atLatest ? null : '正在看历史（按 End 回到最新）'),
                  children: h(KLineChart, {
                    bars: visBars,
                    scale: priceScale,
                    onHover: setHover,
                    overlay: chartOverlay,
                    sub: chartSub,
                    signals: chartSignals,
                    drawings: chartDrawings,
                    colorPalette,
                    marquee: marqueeRect,
                    pinnedRel: pinnedIdx === null ? null : pinnedIdx - range.start,
                  }),
                }),
            // 选中某条画线时：可以写「标签」与「为什么画在这里」。
            // 这一步不做的话，手画的线就只是条线——而画线的价值在于**记下一个判断**
            // （AI 画的线能带 reason，人画的也应该能带）。
            selectedDrawingId
              ? h('div', { className: 'sl-draw-edit' },
                h('input', {
                  className: 'sl-draw-input', style: { flex: '0 0 120px' },
                  placeholder: '标签（如「颈线」）', value: drawingEdit.label,
                  onChange: (e) => setDrawingEdit({ ...drawingEdit, label: e.target.value }),
                }),
                // 趋势线：线段 / 射线 / 直线（看盘软件的"延长"）
                (() => {
                  const cur = drawings.find((d) => d.id === selectedDrawingId)
                  if (!cur || cur.type !== 'trend') return null
                  return h('span', { className: 'sl-toolbar', style: { flex: '0 0 auto' } },
                    h('span', { className: 'sl-note' }, '延伸：'),
                    ...LINE_EXTS.map((x) => h('button', {
                      key: x.k,
                      className: 'sl-btn' + (drawingExt === x.k ? ' sl-btn-on' : ''),
                      title: x.k === 'segment' ? '只画在两点之间'
                        : x.k === 'ray' ? '从第一个点出发，穿过第二个点后延伸到边缘'
                          : '向两端都延伸到边缘',
                      onClick: () => {
                        setDrawingExt(x.k)
                        saveDrawingMemo(selectedDrawingId, drawingEdit.label, drawingEdit.reason, x.k)
                      },
                    }, x.label)))
                })(),
                h('input', {
                  className: 'sl-draw-input', placeholder: '为什么画在这里（判断依据）',
                  value: drawingEdit.reason,
                  onChange: (e) => setDrawingEdit({ ...drawingEdit, reason: e.target.value }),
                }),
                h('button', {
                  className: 'sl-btn',
                  onClick: () => saveDrawingMemo(selectedDrawingId, drawingEdit.label, drawingEdit.reason, drawingExt),
                }, '保存说明'),
                h('button', {
                  // 多选时删掉全部（框选后不用逐个点）
                  className: 'sl-btn',
                  onClick: () => deleteDrawing(selectedIds.length > 0 ? selectedIds : selectedDrawingId),
                }, selectedIds.length > 1 ? `删除选中的 ${selectedIds.length} 条` : '删除')
              )
              : null,
            // 画线状态：条数 + 操作提示 + 问题（不合法/超出范围/复权不一致都要说清，不静默丢）
            (drawingNote || drawings.length > 0)
              ? h('div', { className: 'sl-note', style: { lineHeight: 1.8 } },
                (drawingNote ? drawingNote + '　' : '')
                + (multiNote ? multiNote + '　' : '')
                + (drawings.length > 0
                  ? `画线 ${dr.shapes.length} 条`
                    + (dr.shapes.length < drawings.length ? `（另有 ${drawings.length - dr.shapes.length} 条未显示）` : '')
                  : '')
                + (drawingAllIssues.length > 0 ? '　⚠️ ' + drawingAllIssues.join('；') : ''))
              : (drawingAllIssues.length > 0
                ? h('div', { className: 'sl-err' }, '⚠️ ' + drawingAllIssues.join('；'))
                : null),
            // 公式线图例与状态（说明哪条线在哪、哪些公式没算出来）
            (appliedFormulas.length > 0) ? h('div', { className: 'sl-note', style: { lineHeight: 1.8 } },
              `已叠加 ${appliedFormulas.length} 个公式`
              + (chartOverlay.length ? `；主图 ${chartOverlay.map((o) => o.name).join('、')}` : '')
              + (chartSub.length ? `；副图 ${chartSub.map((o) => o.name).join('、')}` : '')
              + (chartSignals ? `；信号命中 ${chartSignals.indices.length} 次（${chartSignals.conditionName}，已在 K 线上标 ▲）` : '')
              + (formulaFailed ? `；⚠️ ${formulaFailed} 个公式未算出（见「指标公式」tab 的原因）` : '')
            ) : null,
            // 行情明细
            quote ? h('div', { className: 'sl-card' },
              h('h4', null, '行情'),
              h('div', { className: 'sl-grid' },
                metric('开盘', fmt(quote.open)),
                metric('最高', fmt(quote.high)),
                metric('最低', fmt(quote.low)),
                metric('昨收', fmt(quote.prevClose)),
                metric('成交额', fmtBig(quote.amount)),
                metric('换手率', quote.turnover === null ? '—' : fmt(quote.turnover) + '%'),
                metric('PE', quote.pe === null ? '—' : fmt(quote.pe)),
                metric('来源', quote.source || '—')
              ),
              h('div', { className: 'sl-note', style: { marginTop: 8 } },
                '数据时间 ' + (quote.timestamp || '—') + '（来源 ' + (quote.source || '—') + '，已归一化）')
            ) : null,
            // 底部 tabs
            h('div', { className: 'sl-card' },
              h('div', { className: 'sl-toolbar', style: { marginBottom: 10 } },
                ...[['news', '新闻'], ['fin', '财务'], ['flow', '资金流'], ['sector', '所属行业'], ['formula', '指标公式'], ['quant', '量化验证'], ['watch', '智能盯盘'], ['notes', '研究笔记']]
                  .map(([k, label]) => h('button', {
                    key: k, className: 'sl-btn' + (tab === k ? ' sl-btn-on' : ''), onClick: () => setTab(k),
                  }, label)),
                tab === 'notes' ? h('span', { style: { marginLeft: 'auto' } },
                  h('button', {
                    className: 'sl-btn', onClick: () => setNoteFormOpen(!noteFormOpen),
                  }, noteFormOpen ? '取消' : '＋ 新建笔记')
                ) : null
              ),
              tab === 'news' ? (extra.news
                ? extra.news.length
                  ? h('div', null, ...extra.news.map((n, i) => h('div', {
                    key: i, className: 'sl-anom',
                  },
                    h('span', { className: 'sl-anom-kind', style: { color: 'var(--dsw-alias-label-secondary)', fontWeight: 400, minWidth: 108 } }, n.time || ''),
                    h('span', null, n.title)
                  )))
                  : h('div', { className: 'sl-note' }, '暂无新闻')
                : h('div', { className: 'sl-note' }, '加载新闻…')) : null,
              tab === 'fin' ? (extra.fin
                ? extra.fin.reports?.length
                  ? h('div', { className: 'sl-grid' },
                    metric('报告期', extra.fin.reports[0].reportDate),
                    metric('营收', fmtBig(extra.fin.reports[0].revenue)),
                    metric('营收同比', extra.fin.reports[0].revenueYoY === null ? '—' : fmt(extra.fin.reports[0].revenueYoY) + '%'),
                    metric('净利', fmtBig(extra.fin.reports[0].netProfit)),
                    metric('ROE', extra.fin.reports[0].roe === null ? '—' : fmt(extra.fin.reports[0].roe) + '%'),
                    metric('毛利率', extra.fin.reports[0].grossMargin === null ? '—' : fmt(extra.fin.reports[0].grossMargin) + '%'),
                    metric('EPS', fmt(extra.fin.reports[0].eps)),
                    metric('负债率', extra.fin.reports[0].debtRatio === null ? '—' : fmt(extra.fin.reports[0].debtRatio) + '%')
                  )
                  : h('div', { className: 'sl-note' }, extra.fin.note || '暂无财务数据')
                : h('div', { className: 'sl-note' }, '加载财务…')) : null,
              tab === 'flow' ? (extra.flow
                ? h('div', { className: 'sl-grid' },
                  metric('今日主力', fmtBig(extra.flow.today?.mainNetInflow)),
                  metric('近5日主力', fmtBig(extra.flow.mainNetInflow5d)),
                  metric('超大单', fmtBig(extra.flow.today?.superLargeNet)),
                  metric('大单', fmtBig(extra.flow.today?.largeNet)),
                  metric('中单', fmtBig(extra.flow.today?.mediumNet)),
                  metric('小单', fmtBig(extra.flow.today?.smallNet))
                )
                : h('div', { className: 'sl-note' }, '加载资金流…')) : null,
              tab === 'sector' ? h(SectorPanel, { symbol: current.symbol })
                : tab === 'formula'
                  ? h(FormulaPanel, {
                    symbol: current.symbol,
                    applied: appliedFormulas,
                    onToggle: toggleFormula,
                    onRefresh: refreshFormulas,
                    formulas,
                    runs: formulaRuns,
                    loading: formulasLoading,
                    importText: formulaImportText,
                    setImportText: setFormulaImportText,
                    importName: formulaImportName,
                    setImportName: setFormulaImportName,
                    onImport: importFormula,
                    importMsg: formulaImportMsg,
                    importing: formulaImporting,
                    onPickSymbol: select,
                  })
                  : tab === 'quant'
                  ? h(QuantPanel, { symbol: current.symbol, name: quote?.name || current.name, onSaved: refreshNotes })
                  : tab === 'watch'
                    ? h(WatchPanel, { symbol: current.symbol, name: quote?.name || current.name, notes, onNeedNotes: refreshNotes })
                    : tab === 'notes'
                    ? h(NotesPanel, {
                      symbol: current.symbol, formOpen: noteFormOpen, setFormOpen: setNoteFormOpen,
                      onChanged: refreshNotes, notes, notesStats, notesLoading,
                    })
                    : null
            ),
            h('div', { className: 'sl-note', style: { paddingBottom: 8 } },
              '⚠️ 数据来自公开接口，仅供研究参考，不构成投资建议。AI 分析请直接在对话中提问（已自动带上当前股票上下文）。')
          ),
          // 右栏：宽度用户可调（见 useResizablePane 的说明）
          h(Splitter, { pane }),
          // 右栏 = 当前标的会话的视图（独立组件持有自己的状态）
          h(ChatPane, { symbol: current.symbol, symbolName: current.name, pane })
        )
      )
    }

    function metric(label, value) {
      return h('div', { className: 'sl-m', key: label }, h('span', null, label), h('b', null, value))
    }

    // ─────────────────────────── 量化验证面板 ───────────────────────────
    // 条件定义与参数 schema（与 backend/quant/event_study.py 保持一致）
    const QUANT_CONDITIONS = [
      {
        k: 'volume_spike', label: '放量',
        desc: '当日成交量 ≥ 前 N 日均量 × 倍数',
        params: [
          { k: 'n', label: '均量窗口', def: 20, step: 1 },
          { k: 'mult', label: '倍数', def: 1.5, step: 0.1 },
        ],
      },
      {
        k: 'breakout', label: '突破新高',
        desc: '收盘价创前 N 日最高',
        params: [{ k: 'n', label: '窗口', def: 20, step: 1 }],
      },
      {
        k: 'drawdown', label: '回撤',
        desc: '从 N 日高点回撤超过阈值',
        params: [
          { k: 'n', label: '窗口', def: 20, step: 1 },
          { k: 'pct', label: '回撤阈值(0~1)', def: 0.1, step: 0.01 },
        ],
      },
      {
        k: 'ma_cross', label: '均线上穿',
        desc: '短期均线上穿长期均线',
        params: [
          { k: 'fast', label: '快线', def: 5, step: 1 },
          { k: 'slow', label: '慢线', def: 20, step: 1 },
        ],
      },
      {
        k: 'big_move', label: '单日大涨跌',
        desc: '单日涨跌幅绝对值超过阈值',
        params: [{ k: 'pct', label: '阈值(0~1)', def: 0.05, step: 0.01 }],
      },
    ]

    function QuantPanel({ symbol, name, onSaved }) {
      const [condKey, setCondKey] = useState('volume_spike')
      const cond = QUANT_CONDITIONS.find((c) => c.k === condKey) || QUANT_CONDITIONS[0]
      const [params, setParams] = useState(() => {
        const o = {}; for (const p of cond.params) o[p.k] = p.def; return o
      })
      const [horizon, setHorizon] = useState(5)
      const [benchmark, setBenchmark] = useState('IDX000300')
      const [result, setResult] = useState(null)
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState(null)
      const [pyOk, setPyOk] = useState(null)
      const [dataStatus, setDataStatus] = useState(null)

      // 切换条件时重置参数为该条件的默认值
      const pickCondition = (key) => {
        const c = QUANT_CONDITIONS.find((x) => x.k === key)
        const o = {}; for (const p of c.params) o[p.k] = p.def
        setCondKey(key); setParams(o); setResult(null); setMsg(null)
      }

      const refreshStatus = useCallback(async () => {
        try {
          const [py, st] = await Promise.all([
            apiFetch('/quant/python'),
            apiFetch('/quant/status'),
          ])
          setPyOk(!!py.available)
          setDataStatus(st)
        } catch { setPyOk(false) }
      }, [])

      useEffect(() => { refreshStatus() }, [refreshStatus])

      const hasLocalData = !!(dataStatus?.symbols || []).some((s) => s.symbol === symbol)

      const collect = async () => {
        setBusy(true); setMsg(null)
        try {
          const r = await fetch(API + '/quant/collect', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ symbols: [symbol, benchmark], count: 500 }),
          })
          const j = await r.json()
          if (!j.ok) throw new Error(j.error || '采集失败')
          const okCount = j.data.ok
          setMsg(`已采集 ${okCount}/${j.data.total} 个标的`)
          await refreshStatus()
        } catch (e) { setMsg('采集失败：' + e.message) }
        finally { setBusy(false) }
      }

      const run = async () => {
        setBusy(true); setMsg(null); setResult(null)
        try {
          const qs = new URLSearchParams({
            symbol, condition: condKey, horizon: String(horizon),
            benchmark, params: JSON.stringify(params),
          })
          const r = await fetch(API + '/quant/event-study?' + qs.toString())
          const j = await r.json()
          if (!j.ok) throw new Error(j.error || '计算失败')
          setResult(j.data)
          if (j.data.sampleSize === 0) setMsg('没有可用事件样本：条件可能过严，或历史数据太短')
        } catch (e) { setMsg('计算失败：' + e.message) }
        finally { setBusy(false) }
      }

      // 把量化结果一键存成研究笔记（保证「验证 → 记录」闭环）
      const saveAsNote = async () => {
        if (!result) return
        setBusy(true)
        const st = result.stats
        const pct = (v) => (v * 100).toFixed(2) + '%'
        try {
          const r = await fetch(API + '/research/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              symbol, name,
              observation: `${cond.label}（${cond.desc}，参数 ${JSON.stringify(params)}）在 ${result.sampleSize} 个历史样本中，`
                + `事件后 ${result.horizon} 日平均超额收益 ${pct(st.meanExcessReturn)}（中位 ${pct(st.medianExcessReturn)}），`
                + `胜率 ${(st.winRate * 100).toFixed(1)}%，t 统计量 ${st.tStat}。样本区间 ${result.sampleRange.first} ~ ${result.sampleRange.last}。`,
              hypothesis: `待填写：为什么会出现这个结果？（当前统计${st.significant5pct ? '显著' : '不显著'}，`
                + `${st.significant5pct ? '需警惕多重比较导致的假阳性' : '提示该条件在此样本中没有稳定优势'}）`,
              evidence: [
                `样本量 ${result.sampleSize}，平均超额 ${pct(st.meanExcessReturn)}`,
                `中位超额 ${pct(st.medianExcessReturn)}，标准差 ${pct(st.stdExcessReturn)}`,
                `t=${st.tStat}，胜率 ${(st.winRate * 100).toFixed(1)}%`,
                `最好 ${pct(st.bestExcess)} / 最差 ${pct(st.worstExcess)}`,
              ],
              counterEvidence: [
                '这是历史统计描述，不构成因果结论，也不保证未来重复',
                st.significant5pct ? '可能存在多重比较问题（换条件/参数后容易挑出显著结果）' : '统计上不显著，不能据此认为存在规律',
                '未控制市场状态、行业轮动、流动性等混杂因素',
              ],
              prediction: '待填写：基于本结果你说得清的下一个可验证预测是什么？',
              confidence: 0.5,
              benchmark,
              tags: ['quant', 'event-study', condKey],
              dataVersion: `sample=${result.sampleSize};rows=${result.meta.dataRows}`,
            }),
          })
          const j = await r.json()
          if (!j.ok) throw new Error(j.error || '保存失败')
          setMsg('已存为研究笔记（可到「研究笔记」tab 补充假设与预测）')
          if (onSaved) onSaved()
        } catch (e) { setMsg('保存失败：' + e.message) }
        finally { setBusy(false) }
      }

      // 未就绪时的引导
      if (pyOk === false) {
        return h('div', null,
          h('div', { className: 'sl-err' }, '未找到 Python 解释器，量化功能不可用。'),
          h('div', { className: 'sl-note', style: { lineHeight: 1.8 } },
            '插件会依次查找：DSH_STOCK_LAB_PYTHON 环境变量 → 包内 .python-path 文件 → DSH_PYTHON → '
            + 'DSH 自带运行时（$DSH_HOME 或 ~/.dsh 下的 dsh-runtimes）→ PATH 上的 python。'),
          h('button', { className: 'sl-btn', style: { marginTop: 8 }, onClick: refreshStatus }, '重新检测')
        )
      }

      return h('div', null,
        // 状态条
        h('div', { className: 'sl-note', style: { marginBottom: 8, lineHeight: 1.7 } },
          pyOk === null ? '检测 Python 环境…'
            : `本地历史库：${dataStatus?.count || 0} 个标的`
              + (hasLocalData ? '（含当前股票 ✓）' : '（⚠ 尚无当前股票数据）')
        ),
        !hasLocalData ? h('div', { style: { marginBottom: 8 } },
          h('button', { className: 'sl-btn', disabled: busy, onClick: collect },
            busy ? '采集中…' : `采集 ${symbol} 与基准的 500 根日线`),
          h('span', { className: 'sl-note', style: { marginLeft: 8 } },
            '事件研究需要先落库历史数据（首次约 2~5 秒）')
        ) : null,
        msg ? h('div', { className: 'sl-note', style: { color: 'var(--dsw-alias-state-warn-primary)', marginBottom: 8 } }, msg) : null,

        // 条件选择
        h('div', { className: 'sl-note', style: { marginBottom: 4, fontWeight: 600 } }, '事件条件'),
        h('div', { className: 'sl-toolbar', style: { marginBottom: 8 } },
          ...QUANT_CONDITIONS.map((c) => h('button', {
            key: c.k, className: 'sl-btn' + (condKey === c.k ? ' sl-btn-on' : ''), onClick: () => pickCondition(c.k),
          }, c.label))
        ),
        h('div', { className: 'sl-note', style: { marginBottom: 8 } }, cond.desc),

        // 参数
        h('div', { className: 'sl-toolbar', style: { marginBottom: 8, flexWrap: 'wrap' } },
          ...cond.params.map((p) => h('span', { key: p.k, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('span', { className: 'sl-note' }, p.label),
            h('input', {
              className: 'sl-in', type: 'number', step: p.step, style: { width: 72 },
              value: params[p.k],
              onChange: (e) => setParams({ ...params, [p.k]: Number(e.target.value) }),
            })
          )),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('span', { className: 'sl-note' }, '观察天数'),
            h('input', {
              className: 'sl-in', type: 'number', min: 1, max: 60, step: 1, style: { width: 72 },
              value: horizon, onChange: (e) => setHorizon(Number(e.target.value)),
            })
          ),
          h('button', { className: 'sl-btn sl-btn-on', disabled: busy || pyOk === null, onClick: run },
            busy ? '计算中…' : '运行验证')
        ),

        // 结果
        result ? h('div', { style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 10 } },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8, flexWrap: 'wrap' } },
            h('span', { style: { fontWeight: 600 } }, `${cond.label} → 未来 ${result.horizon} 日`),
            h('span', {
              className: result.stats.significant5pct ? 'sl-up' : 'sl-flat',
              style: { fontSize: 12 },
            }, result.stats.significant5pct ? '统计显著 (|t| ≥ 2)' : '不显著 (|t| < 2)')
          ),
          h('div', { className: 'sl-grid' },
            metric('样本量', String(result.sampleSize)),
            metric('平均超额', (result.stats.meanExcessReturn * 100).toFixed(2) + '%'),
            metric('中位超额', (result.stats.medianExcessReturn * 100).toFixed(2) + '%'),
            metric('标准差', (result.stats.stdExcessReturn * 100).toFixed(2) + '%'),
            metric('t 统计量', String(result.stats.tStat)),
            metric('胜率', (result.stats.winRate * 100).toFixed(1) + '%'),
            metric('最好', (result.stats.bestExcess * 100).toFixed(2) + '%'),
            metric('最差', (result.stats.worstExcess * 100).toFixed(2) + '%')
          ),
          h('div', { className: 'sl-note', style: { marginTop: 8, lineHeight: 1.7 } }, result.interpretation.text),
          h('div', { className: 'sl-note', style: { marginTop: 6, lineHeight: 1.7 } },
            ...result.interpretation.caveats.map((c, i) => h('div', { key: i }, '· ' + c))
          ),
          h('div', { style: { marginTop: 10 } },
            h('button', { className: 'sl-btn sl-btn-on', disabled: busy, onClick: saveAsNote },
              busy ? '保存中…' : '存为研究笔记'),
            h('span', { className: 'sl-note', style: { marginLeft: 8 } },
              '结果已自动填入观察与证据；假设与预测留给你补（那是研究者的工作）')
          )
        ) : null
      )
    }

    // ─────────────────────────── 智能盯盘面板 ───────────────────────────
    // 条件定义（与 evaluator.js / watch-store.js 的 WATCH_KINDS 保持一致）
    const WATCH_CONDITIONS = [
      {
        k: 'volume_anomaly', label: '成交量异常', desc: '当日成交量 ≥ 前 N 日均量 × 倍数',
        params: [{ k: 'n', label: '窗口', def: 20, step: 1 }, { k: 'mult', label: '倍数', def: 2, step: 0.1 }],
      },
      {
        k: 'volatility_breakout', label: '波动率突破', desc: '当期波动率 ≥ 前一期 × 倍数',
        params: [{ k: 'n', label: '窗口', def: 20, step: 1 }, { k: 'ratio', label: '倍数', def: 1.6, step: 0.1 }],
      },
      {
        k: 'relative_strength_shift', label: '相对强弱突变', desc: 'N 日超额收益达到阈值',
        params: [{ k: 'n', label: '窗口', def: 20, step: 1 }, { k: 'threshold', label: '阈值pp', def: 5, step: 1 }],
        dirs: [['underperform', '跑输'], ['outperform', '跑赢'], ['any', '任一方向']],
      },
      {
        k: 'money_flow_anomaly', label: '资金流异常', desc: '近 N 日主力累计净流入/出达到阈值',
        params: [{ k: 'days', label: '天数', def: 5, step: 1 }, { k: 'threshold', label: '阈值(亿)', def: 5, step: 0.5, scale: 1e8 }],
        dirs: [['inflow', '净流入'], ['outflow', '净流出'], ['any', '任一方向']],
      },
      {
        k: 'sector_relative', label: '与行业背离', desc: '个股当日涨跌与所属行业差达到阈值',
        params: [{ k: 'threshold', label: '阈值pp', def: 3, step: 0.5 }],
        dirs: [['underperform', '跑输行业'], ['outperform', '跑赢行业'], ['any', '任一方向']],
      },
      {
        k: 'daily_change_pct', label: '当日涨跌幅', desc: '当日涨跌幅超过阈值',
        params: [{ k: 'value', label: '阈值%', def: 7, step: 0.5 }],
        ops: [['>=', '涨幅 ≥'], ['<=', '跌幅 ≤']],
      },
      {
        k: 'price_threshold', label: '价格阈值', desc: '现价相对某值',
        params: [{ k: 'value', label: '价格', def: 0, step: 0.01 }],
        ops: [['>=', '≥'], ['<=', '≤']],
      },
      {
        k: 'turnover_spike', label: '换手率骤升', desc: '换手率 ≥ 阈值',
        params: [{ k: 'value', label: '换手率%', def: 5, step: 0.5 }],
      },
      {
        k: 'hypothesis_review_due', label: '假设到复盘日', desc: '关联研究笔记后，到复盘日提醒（与 Notebook 联动）',
        params: [], needNote: true,
      },
    ]

    function WatchPanel({ symbol, name, notes, onNeedNotes }) {
      const [rules, setRules] = useState([])
      const [triggers, setTriggers] = useState([])
      const [stats, setStats] = useState(null)
      const [condKey, setCondKey] = useState('volume_anomaly')
      const [params, setParams] = useState({ n: 20, mult: 2 })
      const [dir, setDir] = useState(null)
      const [op, setOp] = useState(null)
      const [reason, setReason] = useState('')
      const [noteId, setNoteId] = useState('')
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState(null)
      const [formOpen, setFormOpen] = useState(false)
      const [evaluating, setEvaluating] = useState(false)
      const [tradingTime, setTradingTime] = useState(null)

      const cond = WATCH_CONDITIONS.find((c) => c.k === condKey) || WATCH_CONDITIONS[0]

      const pickCond = (key) => {
        const c = WATCH_CONDITIONS.find((x) => x.k === key)
        const o = {}
        for (const p of c.params) o[p.k] = p.def
        setCondKey(key); setParams(o)
        setDir(c.dirs ? c.dirs[0][0] : null)
        setOp(c.ops ? c.ops[0][0] : null)
        setNoteId('')
        setMsg(null)
      }

      const refresh = useCallback(async () => {
        try {
          const [r, t, k] = await Promise.all([
            apiFetch('/watch/rules', { symbol }),
            apiFetch('/watch/triggers', { symbol, limit: 30 }),
            apiFetch('/watch/kinds'),
          ])
          setRules(r.rules || []); setStats(r.stats || null)
          setTriggers(t.triggers || [])
          setTradingTime(!!k.tradingTime)
        } catch { /* 引擎不可用时静默 */ }
      }, [symbol])

      useEffect(() => { refresh() }, [refresh])
      useEffect(() => { if (condKey === 'hypothesis_review_due' && (!notes || notes.length === 0)) onNeedNotes?.() }, [condKey, notes, onNeedNotes])

      const create = async () => {
        if (cond.needNote && !noteId) { setMsg('「假设到复盘日」需要先选一条研究笔记'); return }
        setBusy(true); setMsg(null)
        // 把界面上的 scale 还原成后端单位（如"亿"→元）
        const builtParams = {}
        for (const p of cond.params) {
          const raw = Number(params[p.k])
          builtParams[p.k] = p.scale ? raw * p.scale : raw
        }
        if (dir) builtParams.direction = dir
        if (op) builtParams.op = op
        try {
          const r = await fetch(API + '/watch/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              symbol, name, kind: condKey, params: builtParams,
              reason: reason || undefined, noteId: noteId || undefined,
            }),
          })
          const j = await r.json()
          if (!j.ok) throw new Error(j.error || '创建失败')
          setMsg('规则已创建')
          setReason(''); setFormOpen(false)
          await refresh()
        } catch (e) { setMsg('创建失败：' + e.message) }
        finally { setBusy(false) }
      }

      const toggle = async (id, enabled) => {
        await fetch(API + '/watch/toggle', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, enabled }),
        }).catch(() => { })
        await refresh()
      }
      const remove = async (id) => {
        await fetch(API + '/watch/delete', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id }),
        }).catch(() => { })
        await refresh()
      }
      const evaluate = async () => {
        setEvaluating(true); setMsg(null)
        try {
          const r = await apiFetch('/watch/evaluate', { symbol })
          setMsg(`已评估 ${r.evaluated} 条规则，触发 ${r.fired} 条`
            + (r.suppressedByCooldown ? `，${r.suppressedByCooldown} 条在冷却期内` : ''))
          await refresh()
        } catch (e) { setMsg('评估失败：' + e.message) }
        finally { setEvaluating(false) }
      }
      const ack = async (id) => {
        await fetch(API + '/watch/ack', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, acknowledged: true }),
        }).catch(() => { })
        await refresh()
      }

      const sevClass = (s) => (s === 'critical' ? 'sl-up' : s === 'warning' ? 'sl-anom-kind' : 'sl-note')

      return h('div', null,
        h('div', { className: 'sl-note', style: { marginBottom: 8, lineHeight: 1.7 } },
          `盯盘规则 ${stats?.rules ?? 0} 条（启用 ${stats?.enabled ?? 0}）· 触发记录 ${stats?.triggers ?? 0} 条`
            + (stats?.unacknowledged ? `（未确认 ${stats.unacknowledged}）` : '')
            + (tradingTime === null ? '' : tradingTime ? ' · 当前为交易时段' : ' · 当前非交易时段（周期评估会自动跳过）')
        ),
        h('div', { className: 'sl-toolbar', style: { marginBottom: 8 } },
          h('button', { className: 'sl-btn', disabled: evaluating, onClick: evaluate }, evaluating ? '评估中…' : '立即评估'),
          h('button', { className: 'sl-btn', onClick: () => setFormOpen(!formOpen) }, formOpen ? '取消' : '＋ 新建规则'),
          h('span', { className: 'sl-note', style: { marginLeft: 6 } },
            'Host 每 5 分钟自动评估一次（仅交易时段；可用 DSH_STOCK_LAB_WATCH_MINUTES 调整）')
        ),
        msg ? h('div', { className: 'sl-note', style: { color: 'var(--dsw-alias-state-warn-primary)', marginBottom: 8 } }, msg) : null,

        // 新建表单
        formOpen ? h('div', { style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 10, marginBottom: 10 } },
          h('div', { className: 'sl-note', style: { marginBottom: 4, fontWeight: 600 } }, '条件类型'),
          h('div', { className: 'sl-toolbar', style: { marginBottom: 6, flexWrap: 'wrap' } },
            ...WATCH_CONDITIONS.map((c) => h('button', {
              key: c.k, className: 'sl-btn' + (condKey === c.k ? ' sl-btn-on' : ''), onClick: () => pickCond(c.k),
            }, c.label))
          ),
          h('div', { className: 'sl-note', style: { marginBottom: 8 } }, cond.desc),
          h('div', { className: 'sl-toolbar', style: { marginBottom: 8, flexWrap: 'wrap' } },
            ...cond.params.map((p) => h('span', { key: p.k, style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
              h('span', { className: 'sl-note' }, p.label),
              h('input', {
                className: 'sl-in', type: 'number', step: p.step, style: { width: 76 },
                value: params[p.k], onChange: (e) => setParams({ ...params, [p.k]: e.target.value }),
              })
            )),
            cond.ops ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
              h('span', { className: 'sl-note' }, '方向'),
              h('span', { className: 'sl-toolbar' }, ...cond.ops.map(([v, label]) =>
                h('button', { key: v, className: 'sl-btn' + (op === v ? ' sl-btn-on' : ''), onClick: () => setOp(v) }, label)))
            ) : null,
            cond.dirs ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
              h('span', { className: 'sl-note' }, '方向'),
              h('span', { className: 'sl-toolbar' }, ...cond.dirs.map(([v, label]) =>
                h('button', { key: v, className: 'sl-btn' + (dir === v ? ' sl-btn-on' : ''), onClick: () => setDir(v) }, label)))
            ) : null
          ),
          cond.needNote ? h('div', { style: { marginBottom: 8 } },
            h('div', { className: 'sl-note', style: { marginBottom: 3 } }, '关联研究笔记（到期提醒复盘）'),
            notes && notes.length
              ? h('select', {
                className: 'sl-in',
                value: noteId, onChange: (e) => setNoteId(e.target.value),
              },
                h('option', { value: '' }, '— 请选择 —'),
                ...notes.map((n) => h('option', { key: n.id, value: n.id },
                  `${(n.createdAt || '').slice(0, 10)} ${n.hypothesis ? n.hypothesis.slice(0, 40) : n.id.slice(0, 8)}`
                    + (n.reviewDate ? `（复盘日 ${n.reviewDate}）` : '')))
              )
              : h('div', { className: 'sl-note' }, '这只股票还没有研究笔记——先到「研究笔记」tab 建立一条假设')
          ) : null,
          h('div', { style: { marginBottom: 8 } },
            h('div', { className: 'sl-note', style: { marginBottom: 3 } }, '为什么设这条规则（研究意图，会存下来）'),
            h('input', {
              className: 'sl-in', value: reason, placeholder: '例：如果连续跑赢行业且放量，我之前的"持续弱势"假设就被推翻',
              onChange: (e) => setReason(e.target.value),
            })
          ),
          h('button', { className: 'sl-btn sl-btn-on', disabled: busy, onClick: create }, busy ? '创建中…' : '创建规则')
        ) : null,

        // 规则列表
        h('div', { className: 'sl-note', style: { margin: '6px 0 4px', fontWeight: 600 } }, '当前股票的规则'),
        rules.length === 0
          ? h('div', { className: 'sl-note' }, '还没有盯盘规则。')
          : h('div', null, ...rules.map((r) => {
            const c = WATCH_CONDITIONS.find((x) => x.k === r.kind)
            return h('div', { key: r.id, style: { borderBottom: '1px solid var(--dsw-alias-border-l1)', padding: '7px 0' } },
              h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
                h('span', { style: { fontWeight: 600 } }, c ? c.label : r.kind),
                h('span', { className: 'sl-code' }, JSON.stringify(r.params)),
                r.noteId ? h('span', { className: 'sl-note' }, '关联笔记 ' + String(r.noteId).slice(0, 8)) : null,
                h('span', { className: r.enabled ? 'sl-note' : 'sl-flat', style: { marginLeft: 'auto' } },
                  r.enabled ? '启用中' : '已停用'),
                h('span', { className: 'sl-note' }, `触发 ${r.triggerCount} 次`)
              ),
              r.reason ? h('div', { className: 'sl-note', style: { marginTop: 3 } }, '意图：' + r.reason) : null,
              h('div', { style: { marginTop: 5, display: 'flex', gap: 6 } },
                h('button', { className: 'sl-btn', onClick: () => toggle(r.id, !r.enabled) }, r.enabled ? '停用' : '启用'),
                h('button', { className: 'sl-btn', onClick: () => remove(r.id) }, '删除'),
                r.lastTriggeredAt ? h('span', { className: 'sl-note' }, '最近触发 ' + r.lastTriggeredAt.slice(0, 16).replace('T', ' ')) : null
              )
            )
          })),

        // 触发记录
        h('div', { className: 'sl-note', style: { margin: '12px 0 4px', fontWeight: 600 } }, '触发记录'),
        triggers.length === 0
          ? h('div', { className: 'sl-note' }, '暂无触发。点「立即评估」可立刻检查一次。')
          : h('div', null, ...triggers.map((tg) => h('div', {
            key: tg.id, style: { borderBottom: '1px solid var(--dsw-alias-border-l1)', padding: '7px 0' },
          },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
              h('span', { className: sevClass(tg.severity) }, tg.severity === 'critical' ? '● 重要' : tg.severity === 'warning' ? '● 关注' : '● 提示'),
              h('span', { style: { fontWeight: 600 } }, tg.title),
              h('span', { className: 'sl-note', style: { marginLeft: 'auto' } }, String(tg.firedAt).slice(0, 16).replace('T', ' '))
            ),
            tg.detail ? h('div', { className: 'sl-note', style: { marginTop: 3, lineHeight: 1.7 } }, tg.detail) : null,
            h('div', { style: { marginTop: 4, display: 'flex', gap: 8, alignItems: 'center' } },
              tg.noteId ? h('span', { className: 'sl-note' }, '→ 关联笔记，建议复盘') : null,
              tg.acknowledged
                ? h('span', { className: 'sl-note' }, '已确认')
                : h('button', { className: 'sl-btn', onClick: () => ack(tg.id) }, '确认')
            )
          )))
      )
    }

    // ─────────────────────────── 指标公式面板 ───────────────────────────
    function FormulaPanel({ symbol, applied, onToggle, onRefresh, formulas, runs, loading,
                            importText, setImportText, importName, setImportName, onImport, importMsg, importing,
                            onPickSymbol }) {
      const [open, setOpen] = useState(false)
      // ── 公式选股（T5.7）──
      // 选中的公式（{ id, name }）；有值时在公式列表上方展示选股区。
      const [screenFormula, setScreenFormula] = useState(null)
      const [universe, setUniverse] = useState('local')
      const [latestOnly, setLatestOnly] = useState(false)
      const [universes, setUniverses] = useState(null)
      const [job, setJob] = useState(null)
      const [starting, setStarting] = useState(false)
      const [cancelling, setCancelling] = useState(false)
      const [screenMsg, setScreenMsg] = useState(null)
      const [pollErr, setPollErr] = useState(null)

      // 标的池规模/全市场抓取是否完整：启动前先如实展示，避免把"本地库只有几只"误当全市场
      useEffect(() => {
        let alive = true
        apiFetch('/formula/screen/universes')
          .then((d) => { if (alive) setUniverses(d) })
          .catch((e) => { if (alive) setUniverses({ error: e.message }) })
        return () => { alive = false }
      }, [])

      // running 时每 400ms 轮询一次状态；任务结束（done/cancelled/failed）或组件卸载时必须清掉定时器
      useEffect(() => {
        const id = job && job.id
        if (!id || job.state !== 'running') return undefined
        let alive = true
        let fails = 0
        const tick = async () => {
          try {
            const d = await apiFetch('/formula/screen/status', { id })
            if (!alive) return
            fails = 0
            setPollErr(null)
            setJob(d)
          } catch (e) {
            if (!alive) return
            fails += 1
            if (fails >= 3) {
              setJob((prev) => (prev && prev.id === id ? { ...prev, state: 'failed', error: e.message } : prev))
            } else {
              setPollErr('状态获取失败，重试中：' + e.message)
            }
          }
        }
        const timer = setInterval(tick, 400)
        return () => { alive = false; clearInterval(timer) }
      }, [job && job.id, job && job.state])

      // 自选股存的是 [{symbol,name}]（见 Sidebar 的 useLocal(LS_WATCH, ...)）；也兼容纯字符串数组
      const watchSymbols = () => {
        try {
          const saved = localStorage.getItem(LS_WATCH)
          const raw = saved ? JSON.parse(saved) : DEFAULT_WATCH
          if (!Array.isArray(raw)) return []
          return raw.map((x) => (typeof x === 'string' ? x : x && x.symbol)).filter(Boolean)
        } catch { return [] }
      }

      const postJson = async (path, body) => {
        const r = await fetch(API + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
        const j = await r.json()
        if (!j.ok) throw new Error(j.error || '请求失败')
        return j.data
      }

      const startScreen = async () => {
        if (!screenFormula) return
        setStarting(true); setScreenMsg(null); setPollErr(null)
        try {
          const body = { formulaId: screenFormula.id, universe, latestOnly }
          if (universe === 'watchlist') body.symbols = watchSymbols()
          const d = await postJson('/formula/screen/start', body)
          setJob(d)
        } catch (e) { setScreenMsg('启动选股失败：' + e.message) }
        finally { setStarting(false) }
      }

      const stopScreen = async () => {
        if (!job || !job.id) return
        setCancelling(true); setScreenMsg(null)
        try {
          const d = await postJson('/formula/screen/cancel', { id: job.id })
          if (d && d.ok === false) setScreenMsg(d.error || '取消失败')
          // 立刻刷新一次，不必等下一个 400ms 轮询
          try {
            const s = await apiFetch('/formula/screen/status', { id: job.id })
            if (s) setJob(s)
          } catch { /* 状态查询失败时交给轮询继续重试 */ }
        } catch (e) { setScreenMsg('取消失败：' + e.message) }
        finally { setCancelling(false) }
      }

      const running = !!(job && job.state === 'running')
      const uni = job && job.universe
      const prog = (job && job.progress) || { total: 0, done: 0, hit: 0, missing: 0, failed: 0 }
      // 后端 progress.hit 只在任务结束时写入；运行中先用 results.length 兜底，避免进度条旁一直显示 0 命中
      const hitNow = Math.max(prog.hit || 0, Array.isArray(job && job.results) ? job.results.length : 0)
      const elapsedSec = job && typeof job.elapsedMs === 'number' ? (job.elapsedMs / 1000).toFixed(1) : '0.0'
      const pct = prog.total > 0 ? Math.min(100, Math.round((prog.done / prog.total) * 100)) : 0
      const fromCache = !!(job && (job.cached === true || job.state === 'cached'))
      const missingHint = !!(uni && uni.source === 'market' && uni.missingData > 0
        && uni.missingData >= (uni.total || 0) / 2)
      // market 池的 note 本身已含「缺数据的 N 只未参与计算」，避免重复拼接
      const uniNote = uni && uni.note && !String(uni.note).includes('缺数据的') ? ' ' + uni.note : ''
      const watchCount = universe === 'watchlist' ? watchSymbols().length : 0

      // 选股区（选中公式后出现在公式列表上方）
      const screenArea = screenFormula ? h('div', {
        style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 10, marginBottom: 10 },
      },
        h('div', { className: 'sl-toolbar', style: { marginBottom: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 600 } }, '公式选股'),
          h('span', { className: 'sl-note' }, '公式：' + screenFormula.name),
          h('button', {
            className: 'sl-btn', style: { marginLeft: 'auto' }, disabled: running,
            title: running ? '任务运行中，先停止再收起' : '收起选股区',
            onClick: () => { setScreenFormula(null); setJob(null); setScreenMsg(null); setPollErr(null) },
          }, '收起')
        ),
        // 标的池 / 只看最新一根 / 开始-停止
        h('div', { className: 'sl-toolbar', style: { marginBottom: 6, flexWrap: 'wrap' } },
          h('span', { className: 'sl-note' }, '标的池'),
          ...[['local', '本地库'], ['watchlist', '自选股'], ['market', '全市场']].map(([k, label]) =>
            h('button', {
              key: k,
              className: 'sl-btn' + (universe === k ? ' sl-btn-on' : ''),
              disabled: running,
              title: k === 'watchlist' ? '用左侧自选股（LS_WATCH）作为标的池' : (k === 'market' ? '全市场（只评估本地库有数据的标的）' : '本地历史库已落库的标的'),
              onClick: () => { setUniverse(k); setJob(null); setScreenMsg(null) },
            }, label)
          ),
          h('label', { className: 'sl-note', style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
            h('input', {
              type: 'checkbox', checked: latestOnly, disabled: running,
              onChange: (e) => setLatestOnly(e.target.checked),
            }),
            '只看最新一根'
          ),
          h('button', {
            className: 'sl-btn' + (running ? '' : ' sl-btn-on'),
            disabled: starting || cancelling,
            onClick: running ? stopScreen : startScreen,
          }, running ? '停止' : (job && job.state === 'failed' ? '重新开始' : '开始选股'))
        ),
        // 标的池规模 / 抓取完整性（如实展示，不粉饰）
        h('div', { className: 'sl-note', style: { marginBottom: 6, lineHeight: 1.7 } },
          !universes ? '加载标的池信息…'
            : universes.error ? '标的池加载失败：' + universes.error
              : `本地库 ${universes.local?.total ?? 0} 只 · 全市场 ${universes.market?.total ?? 0} 只`
                + (universes.market?.error ? `（全市场标的池不可用：${universes.market.error}）` : '')
                + (universes.market?.partial ? `（抓取不完整：已抓 ${universes.market.fetched ?? 0}/${universes.market.total ?? 0}，失败 ${universes.market.failedPages || 0} 页，结果可能漏标的）` : '')
        ),
        universe === 'watchlist' && watchCount === 0 && !running
          ? h('div', { className: 'sl-note', style: { marginBottom: 6 } }, '自选股为空：请先在左侧搜索并加入自选股。')
          : null,
        screenMsg ? h('div', { className: 'sl-note', style: { color: 'var(--dsw-alias-state-warn-primary)', marginBottom: 6 } }, screenMsg) : null,
        pollErr ? h('div', { className: 'sl-note', style: { color: 'var(--dsw-alias-state-warn-primary)', marginBottom: 6 } }, pollErr) : null,

        job ? h('div', null,
          h('div', { className: 'sl-note', style: { marginBottom: 4 } },
            `已评估 ${prog.done}/${prog.total} · 命中 ${hitNow} · 缺数据 ${prog.missing} · ${elapsedSec}s`
            + (prog.failed ? ` · 失败 ${prog.failed}` : '')
            + (fromCache ? ' · 来自缓存' : '')
          ),
          h('div', {
            className: 'sl-screen-bar', role: 'progressbar',
            'aria-valuemin': 0, 'aria-valuemax': prog.total || 0, 'aria-valuenow': prog.done || 0,
            title: `进度 ${pct}%`,
          }, h('div', { className: 'sl-screen-bar-fill', style: { width: pct + '%' } })),
          uni ? h('div', { className: 'sl-note', style: { marginBottom: 4, lineHeight: 1.7 } },
            `只评估本地库有数据的标的；缺数据的 ${uni.missingData || 0} 只未参与计算。`
            + uniNote) : null,
          missingHint ? h('div', { className: 'sl-note', style: { color: 'var(--dsw-alias-state-warn-primary)', marginBottom: 4, lineHeight: 1.7 } },
            '全市场标的池里缺数据的标的很多：先在对话里用 collect_history 补数据，或切到本地库。') : null,
          job.state === 'failed' ? h('div', { className: 'sl-err' }, '选股失败：' + (job.error || '未知错误')) : null,
          job.state === 'cancelled' ? h('div', { className: 'sl-note' }, '已停止' + (job.error ? '：' + job.error : '')) : null,
          job.state === 'done' && job.error ? h('div', { className: 'sl-note' }, job.error) : null,
          job.results && job.results.length
            ? h('table', { className: 'sl-screen-table' },
              h('thead', null, h('tr', null,
                ...['代码', '名称', '命中次数', '最近命中日', '收盘', '涨跌'].map((c) => h('th', { key: c }, c))
              )),
              h('tbody', null, ...job.results.map((r) => h('tr', {
                key: r.symbol, title: '点击切换到该标的',
                onClick: () => onPickSymbol && onPickSymbol(r.symbol, r.name || r.symbol),
              },
                h('td', null, r.symbol),
                h('td', null, r.name || '—'),
                h('td', null, String(r.hitCount)),
                h('td', null, r.lastHitDate || '—'),
                h('td', null, fmt(r.close)),
                h('td', { className: cls(r.changePct) }, fmtPct(r.changePct))
              )))
            )
            : job.state === 'done'
              ? h('div', { className: 'sl-note', style: { marginTop: 6 } },
                '没有命中的标的（不代表全市场只有 0 只——见上面的缺数据数量）')
              : null,
          job.resultsTruncated ? h('div', { className: 'sl-note' }, '结果超过 500 条，仅显示前 500 条') : null
        ) : null,
        h('div', { className: 'sl-note', style: { marginTop: 8, color: 'var(--dsw-alias-label-tertiary)' } },
          '历史统计筛选，不构成投资建议')
      ) : null

      return h('div', null,
        h('div', { className: 'sl-toolbar', style: { marginBottom: 8, flexWrap: 'wrap' } },
          h('button', { className: 'sl-btn', onClick: () => setOpen(!open) }, open ? '取消导入' : '＋ 导入公式'),
          h('button', { className: 'sl-btn', onClick: onRefresh }, '刷新列表'),
          h('span', { className: 'sl-note', style: { marginLeft: 6 } },
            `已导入 ${formulas.length} 个 · 已启用 ${applied.length} 个`)
        ),

        open ? h('div', { style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 10, marginBottom: 10 } },
          h('div', { className: 'sl-note', style: { marginBottom: 6, lineHeight: 1.7 } },
            '粘贴通达信公式源码后导入。也支持在对话里让 AI 用 import_formula / import_formula_dir 导入（含文件与目录批量）。'),
          h('div', { className: 'sl-note', style: { marginBottom: 6, lineHeight: 1.7 } },
            '⚠️ 加密公式文件（.tne 等）无法解析；绘图指令会被忽略；含未来函数的公式默认不计算。'),
          h('input', {
            className: 'sl-in', style: { width: '100%', boxSizing: 'border-box', marginBottom: 6 },
            placeholder: '公式名字，例如：我的均线系统',
            value: importName || '',
            onChange: (e) => setImportName(e.target.value),
          }),
          h('textarea', {
            className: 'sl-ta', rows: 6,
            placeholder: '例：\nMA5:MA(CLOSE,5);\nMA20:MA(CLOSE,20);\nXG:CROSS(MA5,MA20);',
            value: importText || '',
            onChange: (e) => setImportText(e.target.value),
          }),
          h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 } },
            h('button', {
              className: 'sl-btn sl-btn-on',
              disabled: importing || !String(importText || '').trim(),
              onClick: onImport,
            }, importing ? '导入中…' : '导入并解析'),
            h('span', { className: 'sl-note' }, '导入后点「画到图上」即可叠加显示')
          ),
          importMsg ? h('div', { className: 'sl-note', style: { marginTop: 6, color: 'var(--dsw-alias-state-warn-primary)' } }, importMsg) : null
        ) : null,

        // 公式选股区（点某个公式行的「选股」后出现）
        screenArea,

        loading ? h('div', { className: 'sl-note' }, '加载公式…')
          : formulas.length === 0
            ? h('div', { className: 'sl-note' }, '还没有导入任何公式。点「导入公式」粘贴通达信源码，或在对话里让 AI 导入。')
            : h('div', null, ...formulas.map((f) => {
              const on = applied.includes(f.id)
              const run = runs[f.id]
              return h('div', { key: f.id, style: { borderBottom: '1px solid var(--dsw-alias-border-l1)', padding: '8px 0' } },
                h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
                  h('button', {
                    className: 'sl-btn' + (on ? ' sl-btn-on' : ''),
                    onClick: () => onToggle(f.id),
                    title: on ? '从图表移除' : '叠加到图表',
                  }, on ? '已在图上' : '画到图上'),
                  h('button', {
                    className: 'sl-btn' + (screenFormula && screenFormula.id === f.id ? ' sl-btn-on' : ''),
                    disabled: !f.ok || running,
                    title: f.ok ? (running ? '选股任务运行中' : '用该公式对一批标的选股') : '公式解析失败，无法用于选股',
                    onClick: () => {
                      setScreenFormula({ id: f.id, name: f.name })
                      setJob(null); setScreenMsg(null); setPollErr(null)
                    },
                  }, '选股'),
                  h('span', { style: { fontWeight: 600 } }, f.name),
                  f.symbol ? h('span', { className: 'sl-code' }, f.symbol) : h('span', { className: 'sl-note' }, '通用'),
                  !f.ok ? h('span', { className: 'sl-up' }, '解析失败') : null,
                  (f.futureFunctions && f.futureFunctions.length) ? h('span', { className: 'sl-anom-kind' }, '含未来函数') : null,
                  (f.ignoredDrawCalls && f.ignoredDrawCalls.length) ? h('span', { className: 'sl-note' }, '有绘图指令被忽略') : null
                ),
                h('div', { className: 'sl-note', style: { marginTop: 3 } },
                  '输出线：' + ((f.outputs || []).map((o) => o.name).join(' / ') || '（无）')),
                !f.ok && f.errors && f.errors.length
                  ? h('div', { className: 'sl-err', style: { marginTop: 4 } }, ...f.errors.slice(0, 3).map((e, i) => h('div', { key: i }, e)))
                  : null,
                (f.futureFunctions && f.futureFunctions.length)
                  ? h('div', { className: 'sl-note', style: { marginTop: 4, lineHeight: 1.7, color: 'var(--dsw-alias-state-warn-primary)' } },
                    `含未来函数 ${f.futureFunctions.join('、')}：会随新数据重画历史，用它判断信号会得到虚假高胜率，因此默认不计算。`
                    + '确实只是想看图时，可在对话里用 run_formula 且 allowFutureFunctions=true。')
                  : null,
                run && !run.ok
                  ? h('div', { className: 'sl-err', style: { marginTop: 4 } }, '当前标的计算失败：' + ((run.errors || []).join('；') || '未知原因'))
                  : null,
                run && run.ok
                  ? h('div', { className: 'sl-note', style: { marginTop: 4 } },
                    `当前标的下：${run.outputs.length} 条线，区间 ${run.range.start} ~ ${run.range.end}`
                    + (run.signals && !run.signals.notACondition
                      ? `；信号命中 ${run.signals.hitCount} 次${run.signals.recentHits && run.signals.recentHits.length ? '（最近 ' + run.signals.recentHits.slice(-3).join(' / ') + '）' : ''}`
                      : ''))
                  : null
              )
            }))
      )
    }

    // ─────────────────────────── 所属行业面板 ───────────────────────────
    function SectorPanel({ symbol }) {
      const [data, setData] = useState(null)
      const [members, setMembers] = useState([])
      const [err, setErr] = useState(null)
      useEffect(() => {
        let alive = true
        apiFetch('/stock-sector', { symbol })
          .then(async (d) => {
            if (!alive) return
            setData(d)
            if (d.sector?.id) {
              const m = await apiFetch('/sector/members', { id: d.sector.id, limit: 20 })
              if (alive) setMembers(m || [])
            }
          })
          .catch((e) => { if (alive) setErr(e.message) })
        return () => { alive = false }
      }, [symbol])
      if (err) return h('div', { className: 'sl-err' }, '行业数据获取失败：' + err)
      if (!data) return h('div', { className: 'sl-note' }, '加载行业信息…')
      if (!data.sector) {
        return h('div', { className: 'sl-note' },
          `行业：${data.industry || '未知'}（未能匹配到板块代码，无法展示成分股）`)
      }
      return h('div', null,
        h('div', { className: 'sl-grid' },
          metric('行业', data.industry || '—'),
          metric('板块代码', data.sector.id),
          metric('板块涨跌', data.sector.changePct === null ? '—' : fmtPct(data.sector.changePct)),
          metric('板块主力', fmtBig(data.sector.mainNetInflow)),
          metric('地域', data.region || '—')
        ),
        h('div', { className: 'sl-note', style: { margin: '10px 0 6px' } },
          '成分股（按当日涨跌幅排序，前 20）——用来看个股是"行业普涨/普跌"还是"个股独立行情"'),
        members.length
          ? h('div', null, ...members.map((m, i) => h('div', { key: m.code || i, className: 'sl-anom' },
            h('span', { style: { minWidth: 78, fontVariantNumeric: 'tabular-nums' } }, m.code),
            h('span', { style: { flex: 1 } }, m.name),
            h('span', { className: cls(m.changePct), style: { fontVariantNumeric: 'tabular-nums' } }, fmtPct(m.changePct))
          )))
          : h('div', { className: 'sl-note' }, '成分股为空')
      )
    }

    // ─────────────────────────── 研究笔记面板 ───────────────────────────
    function NotesPanel({ symbol, formOpen, setFormOpen, onChanged, notes, notesStats, notesLoading }) {
      const [draft, setDraft] = useState({
        observation: '', hypothesis: '', evidence: '', counterEvidence: '',
        prediction: '', confidence: 0.5, reviewDate: '',
      })
      const [msg, setMsg] = useState(null)
      const [busy, setBusy] = useState(false)
      const [reviewing, setReviewing] = useState(null) // { id, verdict, reviewNotes }

      const upd = (k, v) => setDraft((d) => ({ ...d, [k]: v }))
      const splitLines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean)

      const submit = async () => {
        if (!draft.observation.trim() || !draft.hypothesis.trim()) {
          setMsg('观察与假设均为必填')
          return
        }
        setBusy(true); setMsg(null)
        try {
          const r = await fetch(API + '/research/create', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              symbol,
              observation: draft.observation,
              hypothesis: draft.hypothesis,
              evidence: splitLines(draft.evidence),
              counterEvidence: splitLines(draft.counterEvidence),
              prediction: draft.prediction || undefined,
              confidence: Number(draft.confidence),
              reviewDate: draft.reviewDate || undefined,
              benchmark: 'IDX000300',
              tags: [],
            }),
          })
          const j = await r.json()
          if (!j.ok) throw new Error(j.error || '保存失败')
          setMsg('已保存：' + String(j.data.id).slice(0, 8))
          setDraft({ observation: '', hypothesis: '', evidence: '', counterEvidence: '', prediction: '', confidence: 0.5, reviewDate: '' })
          setFormOpen(false)
          if (onChanged) onChanged()
        } catch (e) { setMsg('保存失败：' + e.message) }
        finally { setBusy(false) }
      }

      const submitReview = async () => {
        if (!reviewing) return
        setBusy(true)
        try {
          const r = await fetch(API + '/research/review', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(reviewing),
          })
          const j = await r.json()
          if (!j.ok) throw new Error(j.error || '复盘保存失败')
          setReviewing(null)
          if (onChanged) onChanged()
        } catch (e) { setMsg('复盘失败：' + e.message) }
        finally { setBusy(false) }
      }

      const input = (label, key, opts = {}) => h('div', { style: { marginBottom: 8 } },
        h('div', { className: 'sl-note', style: { marginBottom: 3 } }, label),
        opts.multiline
          ? h('textarea', {
            className: 'sl-ta', rows: opts.rows || 2, value: draft[key],
            placeholder: opts.placeholder || '', onChange: (e) => upd(key, e.target.value),
          })
          : h('input', {
            className: 'sl-in', value: draft[key], type: opts.type || 'text',
            placeholder: opts.placeholder || '', onChange: (e) => upd(key, e.target.value),
          })
      )

      return h('div', null,
        // 统计条
        h('div', { className: 'sl-note', style: { marginBottom: 8 } },
          notesStats
            ? `研究库：共 ${notesStats.total} 条 · 待复盘 ${notesStats.open} · 已复盘 ${notesStats.reviewed}` +
              (notesStats.byVerdict?.length ? ' · ' + notesStats.byVerdict.map((v) => `${v.verdict} ${v.n}`).join(' / ') : '')
            : '研究库加载中…'
        ),
        msg ? h('div', { className: 'sl-note', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, msg) : null,

        // 新建表单
        formOpen ? h('div', { style: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: 10, marginBottom: 10 } },
          h('div', { className: 'sl-note', style: { marginBottom: 8, fontWeight: 600 } },
            `新建研究笔记 — ${symbol}`),
          input('观察（客观事实，不含判断）', 'observation', { multiline: true, rows: 2, placeholder: '例：近 20 日跑输沪深300 13.96pp' }),
          input('假设（明确这是假设）', 'hypothesis', { multiline: true, rows: 2, placeholder: '例：海外业务风险可能被重新定价' }),
          input('证据（每行一条）', 'evidence', { multiline: true, rows: 3, placeholder: '60日超额 -25.05pp\n波动率 59.98% 显著高于指数' }),
          input('反证（每行一条，必须尽力找）', 'counterEvidence', { multiline: true, rows: 3, placeholder: 'PE 12.54 处于历史低位，不支持基本面恶化假设' }),
          input('预测（可验证）', 'prediction', { placeholder: '例：未来 10 日继续弱于沪深300' }),
          h('div', { style: { display: 'flex', gap: 10, alignItems: 'flex-end', marginBottom: 10 } },
            h('div', { style: { flex: 1 } },
              h('div', { className: 'sl-note', style: { marginBottom: 3 } }, '置信度（0~1）'),
              h('input', {
                className: 'sl-in', type: 'number', min: 0, max: 1, step: 0.05,
                value: draft.confidence, onChange: (e) => upd('confidence', e.target.value),
              })),
            h('div', { style: { flex: 1 } },
              h('div', { className: 'sl-note', style: { marginBottom: 3 } }, '复盘日'),
              h('input', {
                className: 'sl-in', type: 'date', value: draft.reviewDate,
                onChange: (e) => upd('reviewDate', e.target.value),
              }))
          ),
          h('button', { className: 'sl-btn sl-btn-on', disabled: busy, onClick: submit }, busy ? '保存中…' : '保存笔记')
        ) : null,

        // 笔记列表
        notesLoading ? h('div', { className: 'sl-note' }, '加载笔记…')
          : notes.length === 0 ? h('div', { className: 'sl-note' }, '这只股票还没有研究笔记。点击右上「＋ 新建笔记」记录一次判断。')
            : h('div', null, ...notes.map((n) => h('div', {
              key: n.id,
              style: { borderBottom: '1px solid var(--dsw-alias-border-l1)', padding: '8px 0' },
            },
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
                h('span', { style: { fontWeight: 600 } }, n.symbol),
                h('span', { className: 'sl-note' }, (n.createdAt || '').slice(0, 10)),
                n.confidence !== null && n.confidence !== undefined
                  ? h('span', { className: 'sl-note' }, '置信 ' + n.confidence) : null,
                n.reviewDate ? h('span', { className: 'sl-note' }, '复盘日 ' + n.reviewDate) : null,
                h('span', {
                  className: n.status === 'reviewed' ? 'sl-note' : 'sl-anom-kind',
                  style: { marginLeft: 'auto' },
                }, n.status === 'reviewed' ? '已复盘 · ' + (n.verdict || '') : '待复盘')
              ),
              h('div', { className: 'sl-note', style: { margin: '4px 0', lineHeight: 1.6 } },
                (n.hypothesis || '').slice(0, 140) + ((n.hypothesis || '').length > 140 ? '…' : '')),
              n.prediction ? h('div', { className: 'sl-note' }, '预测：' + n.prediction) : null,
              n.status === 'reviewed' ? null : h('div', { style: { marginTop: 6 } },
                reviewing && reviewing.id === n.id
                  ? h('div', null,
                    h('div', { style: { display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' } },
                      ...[['correct', '完全正确'], ['partially', '部分正确'], ['wrong', '判断错误'], ['void', '作废']]
                        .map(([v, label]) => h('button', {
                          key: v,
                          className: 'sl-btn' + (reviewing.verdict === v ? ' sl-btn-on' : ''),
                          onClick: () => setReviewing({ ...reviewing, verdict: v }),
                        }, label))),
                    h('textarea', {
                      className: 'sl-ta', rows: 3, placeholder: '复盘正文：哪部分对、哪部分错、遗漏了什么、因果理解是否有误',
                      value: reviewing.reviewNotes || '',
                      onChange: (e) => setReviewing({ ...reviewing, reviewNotes: e.target.value }),
                    }),
                    h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
                      h('button', { className: 'sl-btn sl-btn-on', disabled: busy || !reviewing.verdict, onClick: submitReview }, '保存复盘'),
                      h('button', { className: 'sl-btn', onClick: () => setReviewing(null) }, '取消'))
                  )
                  : h('button', {
                    className: 'sl-btn',
                    onClick: () => setReviewing({ id: n.id, verdict: '', reviewNotes: '' }),
                  }, '复盘')
              )
            )))
      )
    }

    // ─────────────────────────── 侧栏图标 ───────────────────────────
    function Icon({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round',
      },
        h('path', { d: 'M3 20h18' }),
        h('path', { d: 'M5 16V9M9.5 16V5M14 16v-5M18.5 16V7' }),
        h('circle', { cx: 14, cy: 6, r: 1.6, fill: 'currentColor', stroke: 'none' })
      )
    }

    // ─────────────────────────── 注册 ───────────────────────────
    function apply(ctx) {
      // 注入 CSS。
      //
      // ⚠️ 必须**无条件覆盖**已存在样式元素的内容，不能"已存在就跳过"。
      // 原因：客户端 bundle 是热更新的（HMR）——旧 bundle 已往 head 插过
      // 一个 <style id="sl-styles">；新 bundle 再次 apply 时若因"已存在"而跳过，
      // 新增的 CSS 就永远不生效，表现为「JS 更新了、样式还是旧的」。
      // 真实故障：新加的拖拽分隔条没有任何样式 → 0 尺寸 → 看不见也拖不动。
      if (typeof document !== 'undefined') {
        let el = document.getElementById('sl-styles')
        if (!el) {
          el = document.createElement('style')
          el.id = 'sl-styles'
          document.head.appendChild(el)
        }
        el.textContent = CSS
      }
      if (ctx.slots === undefined) {
        console.error('[dsh-stock-lab] slots 服务不可用')
        return
      }
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'stock-lab' }, Panel))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        // 显示名（用户看到的名字）。内部标识仍是 stock-lab / dsh-stock-lab——
        // 改内部标识会动到路由、localStorage 键与数据目录，换不来用户体验，反而可能丢数据。
        name: 'sidebar.panellist', id: 'stock-lab', order: 70, label: '看盘助手',
      }, Icon))
      return () => {
        const el = typeof document !== 'undefined' ? document.getElementById('sl-styles') : null
        if (el) el.remove()
      }
    }

    return {
      name: 'stock-lab',
      inject: ['slots'],
      apply,
      __test: {
        clampPaneWidth, RIGHT_PANE, shouldAutoCollapse, shouldShowSizeHint,
        COMPOSER, clampComposerHeight,
        CHART_GEO, CHART_VIEW, BARS_BUFFER, DRAW_TOOLS,
        clampView, resolveView, sliceRange, sliceSeries, zoomView, panView, jumpView,
        computePriceScale, priceAtY, snapAnchor, hitTestDrawings, hitTestRect, distanceToSegment, resolveMeasure,
        classifyFormulaOutputs, formulaLineColor, polylinePath,
        FORMULA_COLORS, TDX_COLOR_ATTRS, CSS,
        makeSseParser, CHAT_SUGGESTIONS,
        renderMarkdown, renderInline, groupMessages, toolItemOf,
        resolveDrawings, indexOfDate, summarizeDrawingIssues, DRAW_ISSUE,
        extendLine, ghostFromPoint, LINE_EXTS, DRAW_TOOL_LABEL,
        DRAW_COLORS, drawingColorCss, draftFromPoint, paletteAnchor, PALETTE_W,
      },
    }
  },
})
