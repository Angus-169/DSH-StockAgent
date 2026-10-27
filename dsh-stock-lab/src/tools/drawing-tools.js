/**
 * drawing-tools.js — 让 AI 能在 K 线图上画线/标注
 *
 * 这是"证券软件 + AI"里最直接的一处结合：
 *   用户说"帮我把颈线画出来"，模型先取 K 线算出关键价位，再调用这里的工具把线落到图上。
 *
 * 三条约束（都写进了工具描述，让模型看得见）：
 *   1. **锚点价格必须来自工具取到的真实数据**，不许凭记忆写一个价位
 *   2. **必须记录复权模式**（`adjust`）。前复权基准会随除权整体平移，不记就会错位
 *   3. 画线是**用户的图表标注**，不是投资建议；`reason` 写判断理由而不是买卖指令
 */

import { DRAWING_TYPES, ANCHORS_REQUIRED, LINE_EXT, DRAWING_COLORS } from '../services/drawing-service/drawing-store.js'

/** 工具输出必须是 lossless JSON（undefined / NaN 都不合法），统一净化 */
function jsonSafe(v) {
  if (v === undefined) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (Array.isArray(v)) return v.map(jsonSafe)
  if (v && typeof v === 'object') {
    const o = {}
    for (const [k, x] of Object.entries(v)) o[k] = jsonSafe(x)
    return o
  }
  return v
}

export function registerDrawingTools(ctx, store, market, stockContext) {
  const T = ctx.tools

  T.register({
    name: 'save_drawing',
    description: [
      '在 K 线图上画一条线/标注（图表标注，不是投资建议）。',
      `支持的类型：${DRAWING_TYPES.join(' / ')}`,
      ' · hline：水平线，1 个锚点（价格位，如颈线/支撑位）',
      ' · trend：趋势线，2 个锚点（两点连线，如上升趋势）',
      ' · circle：圆，2 个锚点（**第一个是圆心、第二个是圆上一点**；画出来是真圆）',
      ' · marker：标记某一天，1 个锚点（如财报日/事件日）',
      '',
      '【硬性要求】',
      '1. anchors 里的 date 必须是**真实存在的交易日**（YYYY-MM-DD），通常是 K 线返回里的 time；',
      '   price 必须是**按当日真实数据取到的价位**（收盘/最高/最低等），不得凭记忆编造。',
      '2. adjust 必须写清这条线的价位是在哪种复权模式下取的（前复权基准会在除权后整体平移，',
      '   不记录就会与后来的 K 线错位）。默认用当前 UI 的复权模式。',
      '3. reason 写**判断依据**（如"跌破此线则需求转弱"），不要写买卖指令。',
      '先调用 stock_kline 取到真实 K 线，再据此填写锚点。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '标的代码（省略则用当前 UI 正在看的标的）' },
        type: { type: 'string', enum: DRAWING_TYPES, description: '线型' },
        anchors: {
          type: 'array',
          description: '锚点：hline/marker 1 个；trend/circle 2 个（circle 的第一个是圆心）',
          items: {
            type: 'object',
            properties: {
              date: { type: 'string', description: '交易日 YYYY-MM-DD（必须是真实存在的交易日）' },
              price: { type: 'number', description: '该日的价位（取自真实行情数据）' },
            },
            required: ['date', 'price'],
          },
        },
        ext: {
          type: 'string', enum: LINE_EXT,
          description: '仅 trend 用：ray 射线（默认，从第一个锚点向第二个锚点方向延伸到边缘）/ segment 线段 / line 直线',
        },
        color: {
          type: 'string', enum: DRAWING_COLORS,
          description: '线色（默认跟随主题）。存色名而不是色值，这样明暗主题下都看得清。',
        },
        label: { type: 'string', description: '图上显示的短标签（如「颈线」）' },
        reason: { type: 'string', description: '为什么画在这里（判断依据，非买卖指令）' },
        adjust: { type: 'string', enum: ['qfq', 'hfq', 'none'], description: '价位对应的复权模式；省略则用当前 UI 的' },
      },
      required: ['type', 'anchors'],
    },
    async execute(args) {
      const symbol = args.symbol || stockContext?.get?.().currentStock
      if (!symbol) return { ok: false, error: '没有标的：请显式传 symbol，或先在界面上选中一只股票' }
      const uiAdjust = stockContext?.get?.().adjust
      const res = store.add(symbol, {
        type: args.type,
        anchors: args.anchors,
        ext: args.ext,
        color: args.color,
        label: args.label,
        reason: args.reason,
        adjust: args.adjust || uiAdjust || 'qfq',
      })
      if (!res.ok) return jsonSafe({ ok: false, symbol, errors: res.errors })
      const after = store.list(symbol)
      return jsonSafe({
        ok: true,
        symbol: after.symbol,
        saved: after.drawings.length,
        path: res.path,
        // 创建/更新后可能被规范化，回读最新一条让模型核对
        drawing: after.drawings[after.drawings.length - 1] || null,
      })
    },
  })

  T.register({
    name: 'list_drawings',
    description: [
      '列出某标的已画的线/标注。',
      '每条含 id / type / anchors（日期+价格）/ label / reason / **adjust（画线时的复权模式）**。',
      '不传 symbol 时列出**所有**有画线的标的 —— 用于回答"我在哪些票上画过线"。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '标的代码；省略则列出所有标的（只给数量）' },
      },
    },
    async execute(args) {
      if (!args.symbol) {
        const syms = store.listSymbols()
        return jsonSafe({
          symbols: syms.map((s) => ({ symbol: s, drawings: store.list(s).drawings.length })),
          stats: store.stats(),
        })
      }
      const r = store.list(args.symbol)
      return jsonSafe({ symbol: r.symbol, drawings: r.drawings, warnings: r.warnings })
    },
  })

  T.register({
    name: 'delete_drawing',
    description: '删除某标的一条画线（需要 id，可先用 list_drawings 查）。找不到会如实报错。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '标的代码' },
        id: { type: 'string', description: '画线 id' },
      },
      required: ['symbol', 'id'],
    },
    async execute(args) {
      return jsonSafe(store.remove(args.symbol, args.id))
    },
  })

  return ANCHORS_REQUIRED
}