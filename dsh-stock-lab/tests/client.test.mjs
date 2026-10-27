/**
 * client.test.mjs — Client bundle 契约测试
 * 用假的 window.__ModuleLoader__ + require('react') 加载 bundle，检查注册行为。
 * 运行：node tests/client.test.mjs
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

let passed = 0
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

// ── 极简 React 桩：只记录 createElement 调用 ──
const created = []
const React = {
  createElement: (type, props, ...children) => { const v = { type, props, children }; created.push(v); return v },
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
  useMemo: (fn) => fn(),
}
const requireStub = (id) => {
  if (id === 'react') return React
  throw new Error('unexpected require: ' + id)
}

// ── 加载 bundle ──
const code = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')
let loaded = null
const fakeWindow = {
  __ModuleLoader__: {
    load: (def) => { loaded = def },
  },
}
// 在隔离作用域执行（bundle 是 IIFE 风格，引用 window）
const fn = new Function('window', 'document', 'fetch', 'localStorage', 'console', code)
const fakeDocument = {
  head: { appendChild: () => {} },
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '' }),
  addEventListener: () => {},
  removeEventListener: () => {},
}
const fakeLS = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
fn(fakeWindow, fakeDocument, async () => ({ json: async () => ({ ok: true, data: {} }) }), fakeLS, console)

console.log('bundle 导出')
t('bundle 被 ModuleLoader.load 接收', () => assert.ok(loaded))
t('bundle id = dsh-stock-lab', () => assert.equal(loaded.id, 'dsh-stock-lab'))
t('factory 是函数', () => assert.equal(typeof loaded.factory, 'function'))

const mod = loaded.factory(requireStub)

/**
 * 取某个顶层函数的源码范围（直到下一个同级 function 为止）。
 *
 * 为什么不写 `code.slice(idx, idx + 2600)`：那是**固定长度**切片，
 * 函数一变长就切不到要看的部分——测试会莫名其妙地失败（已真实发生过一次）。
 * 按函数边界取则不受长度影响。
 */
function fnBody(name) {
  const marker = `function ${name}(`
  const start = code.indexOf(marker)
  assert.ok(start >= 0, '找不到函数 ' + name)
  const next = code.indexOf('\n    function ', start + marker.length)
  return code.slice(start, next > 0 ? next : code.length)
}
console.log('\n模块契约')
t('导出 name = stock-lab', () => assert.equal(mod.name, 'stock-lab'))
t('inject 含 slots', () => assert.ok(mod.inject.includes('slots')))
t('导出 apply', () => assert.equal(typeof mod.apply, 'function'))

console.log('\nslot 注册')
const registered = []
const ctx = {
  slots: {
    inject: (name, cb) => { cb() },
    register: (meta, comp) => { registered.push({ meta, comp }); return { dispose() {} } },
  },
}
t('apply 不抛错', () => mod.apply(ctx))
t('注册了 2 个 slot', () => assert.equal(registered.length, 2))

const mainReg = registered.find((r) => r.meta.name === 'main')
const sideReg = registered.find((r) => r.meta.name === 'sidebar.panellist')
t('main slot 使用 key=stock-lab', () => {
  assert.ok(mainReg, '缺少 main 注册')
  assert.equal(mainReg.meta.key, 'stock-lab')
})
t('sidebar.panellist 使用 id=stock-lab 且有 order/label', () => {
  assert.ok(sideReg, '缺少 sidebar 注册')
  assert.equal(sideReg.meta.id, 'stock-lab')
  assert.equal(typeof sideReg.meta.order, 'number')
  assert.equal(typeof sideReg.meta.label, 'string')
})
t('两个 slot 都注册了组件', () => {
  assert.equal(typeof mainReg.comp, 'function')
  assert.equal(typeof sideReg.comp, 'function')
})

console.log('\n组件渲染（React 桩）')
t('Panel 可渲染', () => {
  created.length = 0
  const out = mainReg.comp({})
  assert.ok(out, 'Panel 返回空')
  assert.ok(created.length > 0, 'Panel 未创建任何元素')
})
t('Icon 可渲染且为 svg', () => {
  created.length = 0
  const out = sideReg.comp({ size: 20, active: false })
  assert.equal(out.type, 'svg')
  assert.equal(out.props.width, 20)
})
t('Panel 根元素是 sl-root', () => {
  created.length = 0
  const out = mainReg.comp({})
  assert.equal(out.props.className, 'sl-root')
})

console.log('\n架构检查')
t('client.js 不含行情 API 地址', () => {
  for (const bad of ['qt.gtimg.cn', 'push2.eastmoney', 'fqkline', 'sina.com.cn']) {
    assert.ok(!code.includes(bad), 'client 不得直连行情源: ' + bad)
  }
})
t('client.js 只调用 /stock-lab 路由', () => {
  assert.ok(code.includes("const API = '/stock-lab'"))
})
/**
 * 去掉注释后再检查硬编码颜色 / 名字引用。
 *
 * 规则的本意是「**样式声明里**不得写死颜色」「**代码里**不得引用没声明的参数」，
 * 而不是「源码里不许出现这些字符串」——注释里写出实际色值、
 * 或说明"曾经漏解构 windowStart"都是有价值的文档，不该被判违规。
 * 所以这里把块注释与行注释都剥掉（用 `[^:]` 保护 `https://` 这类写法）。
 */
const stripComments = (s) => String(s)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const hardColorsIn = (s) => (stripComments(s).match(/#[0-9a-fA-F]{6}\b/g) || [])
  .filter((c) => c.toLowerCase() !== '#fff')

t('client 样式声明里不含硬编码颜色', () => {
  const nonWhite = hardColorsIn(code)
  assert.equal(nonWhite.length, 0, '发现硬编码颜色: ' + nonWhite.join(','))
})
t('Research Notebook UI 已接入', () => {
  assert.ok(code.includes('NotesPanel'), '缺少 NotesPanel 组件')
  assert.ok(code.includes("'/research/list'"), '未调用 /research/list')
  assert.ok(code.includes("'/research/create'"), '未调用 /research/create')
  assert.ok(code.includes("'/research/review'"), '未调用 /research/review')
  assert.ok(code.includes('研究笔记'), 'tab 标签缺失')
})
t('行业面板已接入', () => {
  assert.ok(code.includes('SectorPanel'))
  assert.ok(code.includes("'/stock-sector'"))
  assert.ok(code.includes("'/sector/members'"))
  assert.ok(code.includes('所属行业'))
})
t('笔记本必须强制填写反证（合规）', () => {
  // 表单里反证必须作为独立输入项存在，且 UI 文案提醒"必须尽力找"
  assert.ok(code.includes('反证'), '缺少反证输入项')
  assert.ok(code.includes('必须尽力找'), '缺少反证不可省的提示')
})
t('量化验证 UI 已接入', () => {
  assert.ok(code.includes('QuantPanel'), '缺少 QuantPanel 组件')
  for (const route of ['quant/event-study', 'quant/collect', 'quant/status', 'quant/python']) {
    assert.ok(code.includes(route), '未调用 ' + route)
  }
  assert.ok(code.includes('量化验证'), 'tab 标签缺失')
})
t('量化条件与后端保持一致', () => {
  // 这些 key 必须与 backend/quant/event_study.py 的 CONDITIONS 一致
  for (const k of ['volume_spike', 'breakout', 'drawdown', 'ma_cross', 'big_move']) {
    assert.ok(code.includes("'" + k + "'"), '缺少条件 ' + k)
  }
})
t('量化结果展示显著性而不只是收益', () => {
  assert.ok(code.includes('sampleSize'), '未展示样本量')
  assert.ok(code.includes('tStat'), '未展示 t 统计量')
  assert.ok(code.includes('winRate'), '未展示胜率')
  assert.ok(code.includes('significant5pct'), '未展示显著性判定')
  assert.ok(code.includes('不显著'), '缺少不显著的明确标注')
})
t('量化结果可一键存为研究笔记（闭环）', () => {
  assert.ok(code.includes('saveAsNote'), '缺少存为笔记的入口')
  assert.ok(code.includes('研究者的工作'), '应说明假设/预测留给用户填写')
})
t('智能盯盘 UI 已接入', () => {
  assert.ok(code.includes('WatchPanel'), '缺少 WatchPanel 组件')
  for (const route of ['watch/rules', 'watch/triggers', 'watch/create', 'watch/evaluate', 'watch/kinds', 'watch/ack']) {
    assert.ok(code.includes(route), '未调用 ' + route)
  }
  assert.ok(code.includes('智能盯盘'), 'tab 标签缺失')
})
t('盯盘条件与后端 WATCH_KINDS 一致', async () => {
  // 从后端源码读出 WATCH_KINDS，确保前端没有遗漏或多写
  const { readFileSync } = await import('node:fs')
  const backend = readFileSync(new URL('../src/services/watch-service/watch-store.js', import.meta.url), 'utf8')
  const m = backend.match(/export const WATCH_KINDS = \[([\s\S]*?)\]/)
  assert.ok(m, '未能从后端读出 WATCH_KINDS')
  const kinds = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
  assert.ok(kinds.length >= 8, '后端 kinds 太少: ' + kinds.join(','))
  for (const k of kinds) {
    assert.ok(code.includes("'" + k + "'"), '前端缺少条件 ' + k)
  }
})
t('盯盘与研究笔记联动（假设失效提醒）', () => {
  assert.ok(code.includes('hypothesis_review_due'), '缺少假设到期条件')
  assert.ok(code.includes('关联研究笔记'), '缺少关联笔记的选择入口')
  assert.ok(code.includes('建议复盘'), '触发记录应引导复盘')
  assert.ok(code.includes('研究意图'), '应记录设置规则的研究意图')
})
t('盯盘触发展示依据数值与严重度分级', () => {
  assert.ok(code.includes('severity'), '未展示严重度')
  assert.ok(code.includes('critical'), '缺少重要级别')
  assert.ok(code.includes('sl-anom-kind'), '缺少关注级别样式')
})

console.log('\n右栏宽度可调（纯逻辑：clampPaneWidth）')
const { clampPaneWidth, RIGHT_PANE } = mod.__test

t('导出纯函数与配置供测试', () => {
  assert.equal(typeof clampPaneWidth, 'function')
  assert.ok(RIGHT_PANE.min > 0 && RIGHT_PANE.default >= RIGHT_PANE.min)
})
t('正常值原样通过（取整）', () => {
  assert.equal(clampPaneWidth(400, 1600), 400)
  assert.equal(clampPaneWidth(400.6, 1600), 401)
})
t('低于下限被抬到下限', () => {
  assert.equal(clampPaneWidth(10, 1600), RIGHT_PANE.min)
  assert.equal(clampPaneWidth(-999, 1600), RIGHT_PANE.min)
})
t('受容器宽度比例上限约束（窄窗口不挤掉图表）', () => {
  // 容器 1000px，55% = 550
  assert.equal(clampPaneWidth(800, 1000), 550)
  // 容器 800px，55% = 440
  assert.equal(clampPaneWidth(800, 800), 440)
})
t('受硬上限约束（超宽屏也不无限放宽）', () => {
  assert.equal(clampPaneWidth(5000, 4000), RIGHT_PANE.hardMax)
})
t('容器宽度未知时用硬上限', () => {
  assert.equal(clampPaneWidth(600, null), 600)
  assert.equal(clampPaneWidth(600, 0), 600)
  assert.equal(clampPaneWidth(5000, NaN), RIGHT_PANE.hardMax)
})
t('容器极窄时上限不会低于下限（避免 min>max 抖动）', () => {
  // 容器 200px，55% = 110 < min(260) → 上限应抬到 min
  const w = clampPaneWidth(300, 200)
  assert.equal(w, RIGHT_PANE.min, '实际 ' + w)
})
t('非法输入回退默认值', () => {
  assert.equal(clampPaneWidth(NaN, 1600), RIGHT_PANE.default)
  assert.equal(clampPaneWidth(undefined, 1600), RIGHT_PANE.default)
  assert.equal(clampPaneWidth('400', 1600), RIGHT_PANE.default, '字符串不应被当作有效数字')
  assert.equal(clampPaneWidth(Infinity, 1600), RIGHT_PANE.default)
})
t('结果始终落在 [min, max] 内', () => {
  for (const cw of [200, 500, 880, 1000, 1440, 2560, 3840, null]) {
    for (const req of [-100, 0, 1, 260, 380, 700, 1200, 5000]) {
      const w = clampPaneWidth(req, cw)
      assert.ok(w >= RIGHT_PANE.min, `cw=${cw} req=${req} → ${w} 小于下限`)
      const ratioMax = cw ? Math.floor(cw * RIGHT_PANE.maxRatio) : RIGHT_PANE.hardMax
      const max = Math.max(RIGHT_PANE.min, Math.min(RIGHT_PANE.hardMax, ratioMax))
      assert.ok(w <= max, `cw=${cw} req=${req} → ${w} 超过上限 ${max}`)
    }
  }
})

console.log('\n右栏交互契约（静态断言）')
t('宽度与收起状态跨会话持久化', () => {
  assert.ok(code.includes("'stock-lab:rightPane'"), '缺少持久化 key')
  assert.ok(code.includes('localStorage.setItem'), '未写入 localStorage')
})
t('分隔条支持鼠标/触摸拖拽', () => {
  for (const ev of ['onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerCancel']) {
    assert.ok(code.includes(ev), '缺少 ' + ev)
  }
  assert.ok(code.includes('setPointerCapture'), '未捕获指针，拖出元素会丢失')
})
t('分隔条支持键盘调整与复位（可访问性）', () => {
  assert.ok(code.includes("'ArrowLeft'") && code.includes("'ArrowRight'"), '缺少方向键')
  assert.ok(code.includes("'Home'") && code.includes("'End'"), '缺少 Home/End')
  assert.ok(code.includes('onDoubleClick'), '缺少双击复位')
  assert.ok(code.includes("role: 'separator'"), '缺少 separator 角色')
  assert.ok(code.includes("'aria-valuenow'") && code.includes("'aria-valuemin'") && code.includes("'aria-valuemax'"),
    '缺少 aria 值')
  assert.ok(code.includes('tabIndex'), '分隔条应可聚焦')
})
t('拖动时禁用文本选中（避免拖拽时选到文字）', () => {
  assert.ok(code.includes('sl-dragging'), '缺少拖动中样式类')
  assert.ok(code.includes('user-select:none'), '缺少 user-select:none')
})
t('右栏可收起为竖条，避免窄窗口挤压', () => {
  assert.ok(code.includes('sl-rail'), '缺少收起态竖条')
  assert.ok(code.includes('setCollapsed'), '缺少收起开关')
  assert.ok(code.includes('collapseBelow'), '缺少窄窗口阈值配置')
})
t('右栏当前宽度对用户可见', () => {
  assert.ok(code.includes("pane.width + 'px'"), '应显示当前像素宽度，让用户知道拖到多少了')
})

console.log('\n指标公式：主图/副图分类（纯函数）')
const { classifyFormulaOutputs, formulaLineColor, polylinePath, FORMULA_COLORS, TDX_COLOR_ATTRS } = mod.__test

/** 造 K 线：价格大致在 100~120 */
const priceBars = (n = 30) => Array.from({ length: n }, (_, i) => ({
  time: `2026-01-${String(i + 1).padStart(2, '0')}`,
  open: 100 + i * 0.5, high: 102 + i * 0.5, low: 98 + i * 0.5, close: 100 + i * 0.5, volume: 1000 + i,
}))
const mkOutput = (name, values, attrs = []) => ({ name, values, attrs })

t('价格量纲的线进主图（均线）', () => {
  const bars = priceBars(30)
  const ma = mkOutput('MA5', bars.map((b) => b.close))
  const r = classifyFormulaOutputs(bars, [ma])
  assert.equal(r.overlay.length, 1)
  assert.equal(r.sub.length, 0)
})
t('不同量纲的线进副图（MACD 有负值）', () => {
  const bars = priceBars(30)
  const macd = mkOutput('MACD', bars.map((_, i) => (i % 5) - 2)) // -2 ~ 2
  const r = classifyFormulaOutputs(bars, [macd])
  assert.equal(r.overlay.length, 0)
  assert.equal(r.sub.length, 1)
})
t('0~100 量纲的线进副图（RSI）', () => {
  const bars = priceBars(30)
  const rsi = mkOutput('RSI', bars.map((_, i) => 40 + (i % 20)))
  const r = classifyFormulaOutputs(bars, [rsi])
  assert.equal(r.sub.length, 1)
})
t('0/1 条件线不被画成曲线，而是交给信号标记', () => {
  const bars = priceBars(30)
  const xg = mkOutput('XG', bars.map((_, i) => (i % 7 === 0 ? 1 : 0)))
  const r = classifyFormulaOutputs(bars, [xg], 'XG')
  assert.equal(r.overlay.length, 0)
  assert.equal(r.sub.length, 0, '条件线不该出现在副图')
  assert.equal(r.signalLines.length, 1)
})
t('同为 0/1 但不是信号名时仍按普通线处理（放副图）', () => {
  const bars = priceBars(30)
  const flag = mkOutput('OTHER', bars.map(() => 0))
  const r = classifyFormulaOutputs(bars, [flag], 'XG')
  assert.equal(r.sub.length, 1)
})
t('全空输出线放到副图并保留（不静默丢弃）', () => {
  const bars = priceBars(10)
  const empty = mkOutput('EMPTY', bars.map(() => null))
  const r = classifyFormulaOutputs(bars, [empty])
  assert.equal(r.sub.length, 1)
})
t('多条线混合分类正确', () => {
  const bars = priceBars(30)
  const outs = [
    mkOutput('MA5', bars.map((b) => b.close)),
    mkOutput('MA20', bars.map((b) => b.close - 1)),
    mkOutput('DIF', bars.map((_, i) => i - 15)),
    mkOutput('XG', bars.map((_, i) => (i === 5 ? 1 : 0))),
  ]
  const r = classifyFormulaOutputs(bars, outs, 'XG')
  assert.deepEqual(r.overlay.map((o) => o.name), ['MA5', 'MA20'])
  assert.deepEqual(r.sub.map((o) => o.name), ['DIF'])
  assert.deepEqual(r.signalLines.map((o) => o.name), ['XG'])
})
t('空 bars 不崩（返回空分组）', () => {
  const r = classifyFormulaOutputs([], [mkOutput('X', [1])])
  assert.deepEqual(r, { overlay: [], sub: [], signalLines: [] })
})
t('null 值不影响分类判定（只看有效值）', () => {
  const bars = priceBars(30)
  const v = bars.map((b, i) => (i < 5 ? null : b.close))
  const r = classifyFormulaOutputs(bars, [mkOutput('MA5', v)])
  assert.equal(r.overlay.length, 1, '带前导 null 的均线仍应进主图')
})

console.log('\n指标公式：配色与折线（纯函数）')
t('颜色全部来自主题 token（无硬编码色值）', () => {
  for (const c of FORMULA_COLORS) {
    assert.ok(/^var\(--dsw-/.test(c), '非主题 token: ' + c)
  }
  for (const [attr, c] of Object.entries(TDX_COLOR_ATTRS)) {
    assert.ok(/^var\(--dsw-/.test(c), `${attr} 映射到非主题 token: ${c}`)
  }
})
t('TDX 绘图属性优先于调色板', () => {
  const c = formulaLineColor({ attrs: ['COLORRED'] }, 0)
  assert.equal(c, TDX_COLOR_ATTRS.COLORRED)
})
t('无颜色属性时按序号取调色板并循环', () => {
  assert.equal(formulaLineColor({ attrs: [] }, 0), FORMULA_COLORS[0])
  assert.equal(formulaLineColor({ attrs: [] }, FORMULA_COLORS.length), FORMULA_COLORS[0])
})
t('折线在 null 处断开（不跨缺口连线）', () => {
  const d = polylinePath([1, 2, null, 4, 5], (i) => i * 10, (v) => v)
  // SVG 允许命令之间用空白分隔，因此这里做归一化后比对语义
  const norm = d.replace(/\s+/g, ' ').trim()
  assert.equal(norm, 'M0.0 1.0 L10.0 2.0 M30.0 4.0 L40.0 5.0')
  // 关键性质：出现两个 M（两段独立折线），说明缺口处确实断开了
  assert.equal((norm.match(/M/g) || []).length, 2, 'null 处应断开成两段')
})
t('连续 null 不会产生多余命令', () => {
  const d = polylinePath([1, null, null, 2], (i) => i, (v) => v)
  const norm = d.replace(/\s+/g, ' ').trim()
  assert.equal((norm.match(/M/g) || []).length, 2, '应断成两段')
  assert.equal((norm.match(/L/g) || []).length, 0, '每段只有一个点，不该有连线命令')
})
t('前导 null 只从第一个有效值起画', () => {
  const d = polylinePath([null, null, 3, 4], (i) => i, (v) => v)
  const norm = d.replace(/\s+/g, ' ').trim()
  assert.ok(norm.startsWith('M2.0 3.0'), '实际: ' + norm)
})
t('全 null 输出空路径（不画线）', () => {
  assert.equal(polylinePath([null, null], (i) => i, (v) => v), '')
})

console.log('\n指标公式：UI 与数据流契约')
t('新增「指标公式」tab 且接入了面板', () => {
  assert.ok(code.includes("['formula', '指标公式']"), '缺少 tab')
  assert.ok(code.includes('FormulaPanel'), '缺少面板组件')
})
t('调用了公式相关的全部路由', () => {
  for (const r of ['formula/list', 'formula/import', 'formula/run']) {
    assert.ok(code.includes(r), '未调用 ' + r)
  }
})
t('公式求值跟随图表的周期/复权/根数（否则线柱错位）', () => {
  const runIdx = code.indexOf("apiFetch('/formula/run'")
  assert.ok(runIdx > 0, '未找到 run 调用')
  const snippet = code.slice(runIdx, runIdx + 400)
  for (const p of ['timeframe: tf', 'adjust', 'count']) {
    assert.ok(snippet.includes(p), '公式求值未传 ' + p)
  }
})
t('已启用的公式跨会话记住', () => {
  assert.ok(code.includes("'stock-lab:appliedFormulas'"), '缺少持久化 key')
})
t('未来函数导致的计算失败在界面上说明原因', () => {
  assert.ok(code.includes('含未来函数'), '未标注未来函数')
  assert.ok(code.includes('默认不计算'), '未说明默认不计算')
  assert.ok(code.includes('虚假高胜率'), '未说明危害')
})
t('信号以标记方式画在 K 线上（而非 0~1 的线）', () => {
  assert.ok(code.includes('signalMarks'), '缺少信号标记绘制')
  assert.ok(code.includes('▲'), '图例应说明信号标记的图形')
})

console.log('\n右栏 AI 对话：SSE 帧解析（真实会踩的坑都在这）')
const { makeSseParser, CHAT_SUGGESTIONS } = mod.__test

/** 跑一段"服务器输出"，返回收到的事件 */
function parseSse(chunks) {
  const out = []
  const feed = makeSseParser((e) => out.push(e))
  for (const c of chunks) feed(c)
  return out
}

t('单帧解析', () => {
  const evts = parseSse(['data: {"type":"text-delta","text":"你好"}\n\n'])
  assert.equal(evts.length, 1)
  assert.equal(evts[0].type, 'text-delta')
  assert.equal(evts[0].text, '你好')
})
t('多帧在一个 chunk 里', () => {
  const evts = parseSse(['data: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: {"type":"c"}\n\n'])
  assert.deepEqual(evts.map((e) => e.type), ['a', 'b', 'c'])
})
t('帧被切在两个 chunk 之间（最关键：网络分包是常态）', () => {
  const evts = parseSse(['data: {"type":"text-del', 'ta","text":"半"}\n', '\n'])
  assert.equal(evts.length, 1)
  assert.equal(evts[0].type, 'text-delta')
  assert.equal(evts[0].text, '半')
})
t('一次读到半个 JSON 不会崩溃（等下一块）', () => {
  const out = []
  const feed = makeSseParser((e) => out.push(e))
  feed('data: {"type":"text-delta","text":"1"}\n\ndata: {"type":"text-')
  assert.equal(out.length, 1, '已完整的帧应先交付')
  feed('delta","text":"2"}\n\n')
  assert.equal(out.length, 2)
  assert.equal(out[1].text, '2')
})
t('忽略非 data 行（注释、心跳、event:）', () => {
  const evts = parseSse([': keepalive\nevent: ping\ndata: {"type":"x"}\nid: 7\n\n'])
  assert.deepEqual(evts.map((e) => e.type), ['x'])
})
t('畸形 JSON 被跳过，不中断后续帧', () => {
  const evts = parseSse(['data: {坏json}\n\ndata: {"type":"ok"}\n\n'])
  assert.deepEqual(evts.map((e) => e.type), ['ok'], '坏帧不该让后面的帧丢失')
})
t('空 data 行被忽略', () => {
  assert.equal(parseSse(['data:\n\ndata:   \n\n']).length, 0)
})
t('不完整的尾部帧不交付（等下一块补齐）', () => {
  const out = []
  const feed = makeSseParser((e) => out.push(e))
  feed('data: {"type":"done"}')   // 没有 \n\n
  assert.equal(out.length, 0, '没有帧结束标记就不该交付')
  feed('\n\n')
  assert.equal(out.length, 1)
})
t('模拟一次真实的完整流：工具调用 + 逐字文本 + 结束', () => {
  const wire = [
    'data: {"type":"round","round":1,"maxRounds":6}\n\n',
    'data: {"type":"tool-start","id":"c1","name":"stock_quote","argsRaw":"{\\"symbols\\":[\\"600519\\"]}"}\n\n',
    'data: {"type":"tool-end","id":"c1","name":"stock_quote","isError":false,"text":"{\\"price\\":1335}"}\n\n',
    'data: {"type":"round","round":2,"maxRounds":6}\n\n',
    'data: {"type":"text-delta","text":"现价 "}\n\n',
    'data: {"type":"text-delta","text":"1335 元"}\n\n',
    'data: {"type":"round-done","round":2,"finish":"stop"}\n\n',
    'data: {"type":"done","ok":true,"rounds":2,"toolCallCount":1}\n\n',
  ]
  // 模拟网络任意切割：每 17 个字符一块
  const joined = wire.join('')
  const chunks = []
  for (let i = 0; i < joined.length; i += 17) chunks.push(joined.slice(i, i + 17))
  const evts = parseSse(chunks)
  const types = evts.map((e) => e.type)
  assert.deepEqual(types, ['round', 'tool-start', 'tool-end', 'round', 'text-delta', 'text-delta', 'round-done', 'done'])
  const text = evts.filter((e) => e.type === 'text-delta').map((e) => e.text).join('')
  assert.equal(text, '现价 1335 元')
  assert.equal(evts.find((e) => e.type === 'tool-start').name, 'stock_quote')
  assert.equal(evts.find((e) => e.type === 'done').ok, true)
})

console.log('\n右栏 AI 对话：UI 与数据流契约')
t('换标的只读取、不创建会话（懒创建）', () => {
  // 载入历史必须走 GET /chat/messages；若这里出现 POST /chat/send 就是预建行为
  const effectIdx = code.indexOf("apiFetch('/chat/messages'")
  assert.ok(effectIdx > 0, '未调用 /chat/messages')
  const head = code.slice(0, effectIdx)
  assert.ok(!head.includes("fetch(API + '/chat/send'"), '载入历史之前不该出现 send')
})
t('发送用 POST /chat/send，流用 GET /chat/stream?runId=', () => {
  assert.ok(code.includes("fetch(API + '/chat/send'"))
  assert.ok(code.includes("'/chat/stream?runId='"))
})
t('停止按钮调用 /chat/cancel 并本地中断', () => {
  assert.ok(code.includes("fetch(API + '/chat/cancel'"), '未调用 cancel 接口')
  assert.ok(code.includes('abortRef.current?.abort()'), '未中断本地读取')
})
t('切标的时不打断正在进行的回答（它属于上一个标的）', () => {
  // 换标的的 effect 里不该有 abort —— 否则切走就丢掉了那段回答
  const start = code.indexOf('// 换标的 → 载入该标的的会话')
  const eff = code.slice(start, start + 900)
  assert.ok(!/abort\(/.test(eff), '换标的的 effect 里不该 abort')
  assert.ok(code.includes('backgroundSymbol'), '应能提示"另一个标的仍在回答"')
})
t('免责声明常驻在输入区下方（不是每条消息重复）', () => {
  assert.ok(code.includes('sl-chat-disclaimer'))
  assert.ok(code.includes('不构成投资建议'))
  // 常驻意味着它不在消息渲染分支里
  const msgFnIdx = code.indexOf('function MessageBlock')
  const msgFn = code.slice(msgFnIdx, msgFnIdx + 1200)
  assert.ok(!msgFn.includes('不构成投资建议'), '免责声明不该写在每条消息里')
})
t('输入框支持 Enter 发送 / Shift+Enter 换行，且兼容输入法组合', () => {
  assert.ok(code.includes('!e.shiftKey'))
  assert.ok(code.includes('isComposing'), '中文输入法要用 isComposing 避免误发送')
})
t('空状态给出可点击的示例问题', () => {
  assert.ok(Array.isArray(CHAT_SUGGESTIONS) && CHAT_SUGGESTIONS.length >= 3)
  assert.ok(code.includes('CHAT_SUGGESTIONS.map'))
  assert.ok(CHAT_SUGGESTIONS.every((q) => typeof q === 'string' && q.endsWith('？')))
})
t('工具调用可见（调了什么、成功还是失败、可展开看返回）', () => {
  assert.ok(code.includes('sl-tool-name'))
  assert.ok(code.includes('调用中…'))
  assert.ok(code.includes('失败（已回灌给模型）'), '失败要如实标注')
  assert.ok(code.includes('展开查看工具返回'))
})
t('流式时有可见光标与状态行', () => {
  assert.ok(code.includes('sl-stream-cursor'))
  assert.ok(code.includes('正在回答…'))
  assert.ok(code.includes('正在调用工具…'))
})
t('如实展示驱动模型与可用工具数', () => {
  assert.ok(code.includes('info.model.provider'))
  assert.ok(code.includes('info.toolCount'), '应显示可用工具数')
})
t('切标的时清掉上一个标的的流式残影', () => {
  // 换标的 effect 必须重置 live/tools，否则会把上一只的文本显示在新标的下
  const start = code.indexOf('// 换标的 → 载入该标的的会话')
  const eff = code.slice(start, start + 500)
  assert.ok(eff.includes("setLive('')"), '应清空流式文本')
  assert.ok(eff.includes('setTools([])'), '应清空工具记录')
})
t('完成时先载入权威内容再清流式文本（否则答案会闪一下消失）', () => {
  const idx = code.indexOf('// 以服务端为准重新载入。')
  const block = code.slice(idx, idx + 700)
  const loadAt = block.indexOf("apiFetch('/chat/messages'")
  const clearAt = block.indexOf("setLive('')")
  assert.ok(loadAt > 0 && clearAt > 0, '应同时有载入与清理')
  assert.ok(loadAt < clearAt, '必须先载入、后清空 live')
})
t('乐观显示的用户消息带唯一 key（避免多条 pending 撞 key）', () => {
  assert.ok(code.includes("id: 'pending-' + Date.now()"))
})

t('CSS 里不能出现反引号（会提前闭合模板字符串）', () => {
  // 真实踩过：在 CSS 注释里写 `--dsw-alias-*` 反引号，模板字符串被提前闭合，
  // 后半段 CSS 被当成 JS 解析（-- 成了自减运算符），报 "postfix operation" 语法错误。
  // 这条测试把该类错误变成一个明确的失败信息，而不是难懂的语法报错。
  assert.ok(!mod.__test.CSS.includes('`'), 'CSS 里出现了反引号')
  assert.ok(!mod.__test.CSS.includes('${'), 'CSS 里出现了 ${（模板插值）')
})
t('CSS 里不能出现硬编码色值（必须走主题 token；注释里的说明不算）', () => {
  const hard = hardColorsIn(mod.__test.CSS)
  assert.equal(hard.length, 0, '硬编码颜色: ' + hard.join(','))
})
t('对话样式使用 DSH 原生视觉词汇（而不是自编数值）', () => {
  const css = mod.__test.CSS
  // 这几条是"看起来和谐"的关键：与原生用同一套字体/气泡/输入框/圆角
  for (const token of [
    '--dsw-font-markdown-base', '--dsw-font-xxxs-11', '--dsw-font-xxs-12',
    '--dsw-specific-bubble', '--dsw-specific-input-major', '--dsw-specific-sidebar-fill',
    '--dsw-radius-', '--dsw-alias-markdown-code-block', '--dsw-alias-label-tertiary',
    '--dsw-focus-ring-',
  ]) {
    assert.ok(css.includes(token), '缺少原生词汇: ' + token)
  }
})
t('非颜色 token 带兜底值（主题改名时退化为兜底而非整体失效）', () => {
  const css = mod.__test.CSS
  // 抽查几个：这些变量不在官方承诺的 14 个之列，必须有兜底
  for (const [tok, fb] of [
    ['--dsw-radius-lg', '12px'],
    ['--dsw-font-markdown-base-font-size', '13px'],
    ['--dsw-font-xxxs-11-font-size', '11px'],
  ]) {
    assert.ok(css.includes(`var(${tok},${fb})`), `缺少兜底: var(${tok}, ${fb})`)
  }
})
t('宽度提示不常驻：默认隐藏，仅在调整时显示', () => {
  const css = mod.__test.CSS
  assert.ok(css.includes('.sl-pane-size-off{opacity:0}'), '应有隐藏态样式')
  assert.ok(css.includes('transition:opacity'), '应有淡出过渡')
})

console.log('\n宽度提示的显隐规则（纯函数，被 useTransientHint 真正使用）')
const { shouldShowSizeHint } = mod.__test
const HINT = 3000

t('从未调整过 → 不显示（初始状态不能常驻）', () => {
  assert.equal(shouldShowSizeHint(false, 0, 1000, HINT), false)
})
t('拖动中 → 始终显示（不管过去多久）', () => {
  assert.equal(shouldShowSizeHint(true, 0, 999999, HINT), true)
  assert.equal(shouldShowSizeHint(true, 1000, 999999, HINT), true)
})
t('键盘微调后 → 保留一段时间', () => {
  const at = 10000
  assert.equal(shouldShowSizeHint(false, at, at + 1, HINT), true)
  assert.equal(shouldShowSizeHint(false, at, at + 2999, HINT), true)
})
t('停手超过 3 秒 → 隐藏', () => {
  const at = 10000
  assert.equal(shouldShowSizeHint(false, at, at + 3000, HINT), false)
  assert.equal(shouldShowSizeHint(false, at, at + 60000, HINT), false)
})
t('默认保留时长是 3 秒', () => {
  assert.equal(RIGHT_PANE.sizeHintMs, 3000)
})

console.log('\nmarkdown 渲染（助手输出必须渲染，否则很难读）')
const { renderMarkdown, renderInline } = mod.__test

/** 把 React 元素树压成紧凑字符串，便于断言结构（含链接属性，否则查不出 href 问题） */
function flat(n) {
  if (n === null || n === undefined || n === true || n === false) return ''
  if (typeof n === 'string' || typeof n === 'number') return String(n)
  if (Array.isArray(n)) return n.map(flat).join('')
  const tag = typeof n.type === 'string' ? n.type : 'C'
  const kids = (n.children || []).map(flat).join('')
  const p = n.props || {}
  let attrs = p.className ? '@' + p.className : ''
  if (p.href !== undefined) attrs += ' href="' + p.href + '"'
  if (p.target !== undefined) attrs += ' target="' + p.target + '"'
  return '<' + tag + attrs + '>' + kids + '</' + tag + '>'
}
const flatInline = (s) => flat(renderInline(s))

t('标题渲染成带层级的块（不再是一堆井号）', () => {
  const out = flat(renderMarkdown('### 结论\n正文'))
  assert.ok(out.includes('<div@sl-md-h sl-md-h3>结论</div>'), out)
  assert.ok(!out.includes('###'), '井号不该出现在结果里')
})
t('粗体 / 斜体 / 行内代码', () => {
  assert.equal(flatInline('**粗**'), '<strong>粗</strong>')
  assert.equal(flatInline('*斜*'), '<em>斜</em>')
  assert.equal(flatInline('_斜_'), '<em>斜</em>')
  assert.equal(flatInline('`码`'), '<code@sl-md-code>码</code>')
})
t('行内代码里的星号不当粗体（处理顺序：代码优先）', () => {
  assert.equal(flatInline('`**a**`'), '<code@sl-md-code>**a**</code>')
})
t('粗体里可以嵌行内代码', () => {
  assert.equal(flatInline('**a `b` c**'), '<strong>a <code@sl-md-code>b</code> c</strong>')
})
t('围栏代码块保留原文（缩进/换行不丢）', () => {
  const out = flat(renderMarkdown('```\nline1\n  line2\n```'))
  assert.ok(out.includes('<pre@sl-md-pre><code>line1\n  line2</code></pre>'), JSON.stringify(out))
})
t('无序列表与有序列表', () => {
  const ul = flat(renderMarkdown('- 甲\n- 乙'))
  assert.ok(ul.includes('<ul@sl-md-ul><li>甲</li><li>乙</li></ul>'), ul)
  const ol = flat(renderMarkdown('1. 甲\n2. 乙'))
  assert.ok(ol.includes('<ol@sl-md-ol><li>甲</li><li>乙</li></ol>'), ol)
})
t('引用', () => {
  const out = flat(renderMarkdown('> 数据源仅返回 1 个交易日'))
  assert.ok(out.includes('<div@sl-md-quote>数据源仅返回 1 个交易日</div>'), out)
})
t('分隔线', () => {
  assert.ok(flat(renderMarkdown('---')).includes('<hr@sl-md-hr>'))
})
t('表格渲染成真正的表格（含表头与数据行）', () => {
  const out = flat(renderMarkdown('| 项 | 值 |\n|---|---|\n| 现价 | 41.77 |\n| 涨幅 | -0.12% |'))
  assert.ok(out.includes('<table@sl-md-table>'), out)
  assert.ok(out.includes('<thead><tr><th>项</th><th>值</th></tr></thead>'), out)
  assert.ok(out.includes('<tbody><tr><td>现价</td><td>41.77</td></tr>'), out)
  assert.ok(out.includes('<tr><td>涨幅</td><td>-0.12%</td></tr>'), out)
})
t('http/https 链接可点击', () => {
  const out = flat(renderInline('[东财](https://example.com/a)'))
  assert.ok(out.includes('href="https://example.com/a"'), out)
  assert.ok(out.includes('target="_blank"'), '外链应新窗口打开')
})
t('非 http(s) 链接不生成可点击链接（防注入），但内容不丢', () => {
  const out = flat(renderInline('[点我](javascript:alert(1))'))
  assert.ok(!out.includes('href'), '不该生成 href：' + out)
  assert.ok(out.includes('点我'), '原文要保留')
})
t('HTML 标签不会被当成 HTML（我们构造元素，不拼字符串）', () => {
  const out = flat(renderMarkdown('<img src=x onerror=alert(1)>'))
  assert.ok(out.includes('&lt;img') === false, 'flat 不应做转义')
  assert.ok(out.includes('<img'), '原文应作为纯文本存在于 <p> 内')
  // 关键：它必须是文本节点，而不是真的 img 元素
  const tree = renderMarkdown('<img src=x onerror=alert(1)>')
  const tags = []
  const walk = (n) => {
    if (Array.isArray(n)) return n.forEach(walk)
    if (!n || typeof n !== 'object') return
    if (typeof n.type === 'string') tags.push(n.type)
    ;(n.children || []).forEach(walk)
  }
  tree.forEach(walk)
  assert.ok(!tags.includes('img'), '不该出现 img 元素')
})
t('认不出的内容原样保留（绝不吞内容）', () => {
  const weird = '这是一段|没有规则\n的文字 @@## \t结束'
  const out = flat(renderMarkdown(weird))
  for (const piece of ['这是一段|没有规则', '的文字', '@@##', '结束']) {
    assert.ok(out.includes(piece), `丢了内容: ${piece} → ${out}`)
  }
})
t('空输入不崩', () => {
  assert.deepEqual(renderMarkdown(''), [])
  assert.deepEqual(renderMarkdown(null), [])
  assert.deepEqual(renderInline(''), [])
})
t('未闭合标记不误吞（如单个星号）', () => {
  const out = flatInline('2 * 3 = 6')
  assert.equal(out, '2 * 3 = 6')
})
t('真实模型输出（带表格与多级结构）端到端渲染不崩且结构齐全', () => {
  const real = [
    '### 结论',
    '',
    '招商银行 **现价 41.77 元**，跌 `0.12%`。',
    '',
    '- 主力净流出 3.81 亿元',
    '- 振幅 2.30%',
    '',
    '| 项 | 值 |',
    '|---|---|',
    '| 现价 | 41.77 |',
    '',
    '> 数据源仅返回 1 个交易日的资金流序列',
    '',
    '```',
    'SH600036 41.77',
    '```',
    '',
    '⚠️ 以上为公开信息整理，不构成投资建议。',
  ].join('\n')
  const out = flat(renderMarkdown(real))
  for (const must of ['sl-md-h3', 'sl-md-ul', 'sl-md-table', 'sl-md-quote', 'sl-md-pre', '<strong>', 'sl-md-code']) {
    assert.ok(out.includes(must), '缺少结构 ' + must)
  }
  assert.ok(out.includes('不构成投资建议'))
  assert.ok(!out.includes('### '), '不该残留井号')
  assert.ok(!out.includes('**'), '不该残留星号')
})

console.log('\n输入框：发送按钮内嵌 + 上边缘拖拽调高')
t('发送按钮在输入框容器内部，而不是外面另起一行', () => {
  assert.ok(code.includes('sl-composer'), '缺少复合输入框容器')
  const comp = code.indexOf("className: 'sl-composer'")
  const disc = code.indexOf("className: 'sl-chat-disclaimer'")
  assert.ok(comp > 0 && disc > comp, '结构顺序不对')
  const inner = code.slice(comp, disc)
  assert.ok(inner.includes('sl-composer-btn'), '按钮应在复合容器内')
  assert.ok(inner.includes('textarea'), '输入框应在同一容器内')
})
t('空闲时是向上箭头，回答中是方块停止', () => {
  assert.ok(code.includes('M6 10V2.6M2.8 5.6L6 2.4l3.2 3.2'), '缺少向上箭头路径')
  assert.ok(code.includes('sl-composer-stop'), '缺少停止态')
  assert.ok(code.includes("h('rect'"), '停止应是方块')
})
t('无内容时发送按钮禁用（原生也是灰的）', () => {
  assert.ok(code.includes("disabled: draft.trim() === ''"))
})
t('输入框给右侧按钮留出内边距（文字不被压住）', () => {
  assert.ok(mod.__test.CSS.includes('padding-right:44px'), '缺少 padding-right')
})
t('关掉原生 resize（右下角小三角手柄）', () => {
  const css = mod.__test.CSS
  const rule = css.match(/\.sl-chat-input\{[^}]*\}/)
  assert.ok(rule, '缺少 .sl-chat-input 规则')
  assert.match(rule[0], /resize:\s*none/, '应关掉原生 resize')
  assert.ok(!/resize:\s*vertical/.test(rule[0]), '不该再用原生垂直 resize')
})
t('高度由「上边缘」的拖拽条控制', () => {
  const css = mod.__test.CSS
  const g = css.match(/\.sl-composer-grip\{[^}]*\}/)
  assert.ok(g, '缺少拖拽条规则')
  assert.match(g[0], /cursor:\s*row-resize/, '应是上下拖动光标')
  assert.match(g[0], /touch-action:\s*none/, '触摸设备需要 touch-action')
  // 拖拽条必须排在 textarea 之前（上边缘）
  const gripAt = code.indexOf("className: 'sl-composer-grip'")
  const taAt = code.indexOf("className: 'sl-chat-input'")
  assert.ok(gripAt > 0 && taAt > gripAt, '拖拽条应在输入框之前（上边缘）')
})
t('拖动方向语义正确：指针往上 → 变高（边缘跟手）', () => {
  // 上边缘跟手意味着 startY - clientY 为正时高度增加
  assert.ok(code.includes('startRef.current.y - e.clientY'), '缺少「上边缘跟手」的换算')
})
t('拖拽条可键盘调整（与右栏分隔条语义一致）', () => {
  const start = code.indexOf('function useComposerResize')
  const fn = fnBody('useComposerResize')
  for (const k of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter']) {
    assert.ok(fn.includes(`'${k}'`), '缺少键盘支持 ' + k)
  }
  assert.ok(fn.includes('shiftKey'), 'Shift 应放大步长')
})
t('高度跨会话记住', () => {
  assert.ok(code.includes("'stock-lab:composerHeight'"), '缺少持久化 key')
})

console.log('\n输入框高度夹取（纯函数）')
const { COMPOSER, clampComposerHeight } = mod.__test

t('默认/最小/最大关系合理', () => {
  assert.ok(COMPOSER.min <= COMPOSER.default && COMPOSER.default <= COMPOSER.max)
  assert.equal(COMPOSER.min, 56)
})
t('非有限值回落到默认', () => {
  for (const bad of [NaN, undefined, null, '120', Infinity, -Infinity]) {
    assert.equal(clampComposerHeight(bad, 600), COMPOSER.default, String(bad))
  }
})
t('夹到 [min, max]', () => {
  assert.equal(clampComposerHeight(1, 600), COMPOSER.min)
  assert.equal(clampComposerHeight(99999, 600), COMPOSER.max)
  assert.equal(clampComposerHeight(120, 600), 120)
})
t('面板矮时进一步压低上限（不吃掉整块对话区）', () => {
  const h = clampComposerHeight(99999, 400)   // 400 * 0.6 = 240
  assert.equal(h, 240)
  assert.ok(h < COMPOSER.max)
})
t('面板高度未知时不崩，退回绝对上限', () => {
  assert.equal(clampComposerHeight(99999, null), COMPOSER.max)
  assert.equal(clampComposerHeight(99999, NaN), COMPOSER.max)
  assert.equal(clampComposerHeight(99999, 0), COMPOSER.max)
})
t('上限永远不会低于下限', () => {
  const h = clampComposerHeight(100, 50)      // 50*0.6=30 < min
  assert.equal(h, COMPOSER.min)
})

console.log('\n「清空记录」按钮已移除（工作区里删对话即可）')
t('UI 里不再有清空记录按钮', () => {
  assert.ok(!code.includes('清空记录'), '不该再出现清空记录按钮')
  assert.ok(!code.includes('sl-chat-actions'), '空操作行也应删掉')
})
t('也不再有删除确认弹窗（按钮没了，确认框自然也不需要）', () => {
  assert.ok(!code.includes('window.confirm'), '不该再需要 confirm')
})

console.log('\nCSS 定义了全部 markdown 结构样式')
t('markdown 结构样式齐全', () => {
  const css = mod.__test.CSS
  for (const sel of ['.sl-md-p', '.sl-md-h', '.sl-md-ul', '.sl-md-ol', '.sl-md-quote',
    '.sl-md-hr', '.sl-md-code', '.sl-md-pre', '.sl-md-table', '.sl-md-link']) {
    assert.ok(css.includes(sel), '缺少 ' + sel)
  }
})
t('复合输入框与按钮样式齐全', () => {
  const css = mod.__test.CSS
  for (const sel of ['.sl-composer{', '.sl-composer-btn{', '.sl-composer-grip{']) {
    assert.ok(css.includes(sel), '缺少 ' + sel)
  }
  assert.ok(css.includes('position:absolute'), '按钮应绝对定位在框内')
})
t('停止态是同一个按钮换图标（不另换配色，避免对比风险）', () => {
  // 曾用 warn 色做停止态背景，但它与前景色的对比无法保证；原生也是同一个按钮换图标
  assert.ok(code.includes('sl-composer-stop'), '应保留语义类名')
  assert.ok(!mod.__test.CSS.includes('sl-composer-stop{'), '不该再单独覆盖停止态配色')
  assert.ok(code.includes('SendGlyph'), '图标应抽成一个组件（同一按钮换图形）')
})

console.log('\n按钮配色的真实缺陷：禁用态对比度（必须按实际色值判断）')
t('禁用态前景色必须用 label-secondary，且不能用"几乎同色"的 token', () => {
  // 两次踩坑都被**实际色值**揭穿（从主题包解析得到）：
  //   1) 只换背景不改 color → #fff 白箭头画在 #ebeef2 浅灰圆上
  //   2) 改用 label-dimmed  → 它是 #e1e5ee，与背景 #ebeef2 几乎同色，对比度 1.10 → 看不见
  // 现在用 label-secondary(#61666b)：对 #ebeef2 对比度≈4.97
  const rule = mod.__test.CSS.match(/\.sl-composer-btn:disabled\{[^}]*\}/)
  assert.ok(rule, '缺少禁用态规则')
  assert.match(rule[0], /color:\s*var\(--dsw-alias-label-secondary\)/,
    '禁用态前景色必须是 label-secondary：' + rule[0])
  assert.ok(!rule[0].includes('label-dimmed'),
    'label-dimmed(#e1e5ee) 与禁用背景几乎同色，不能用')
})
t('启用态必须是 DSH 的蓝（button-info-fill，实际值 #4176e6）', () => {
  // 曾经用 button-primary-fill 是错的：它在本主题解析成 brand-primary = #0f1115(近黑)，
  // 而原生发送按钮是 DeepSeek 蓝。名字带 primary 不代表它是那个蓝。
  const rule = mod.__test.CSS.match(/\.sl-composer-btn\{[^}]*\}/)
  assert.ok(rule, '缺少按钮规则')
  assert.match(rule[0], /--dsw-alias-button-info-fill/, '应该用 button-info-fill(#4176e6)：' + rule[0])
  assert.ok(!/background:var\(--dsw-alias-button-primary-fill\)/.test(rule[0]),
    '不该再用近黑的 button-primary-fill')
  // 蓝底必须配白图标，且白在明暗主题下都成立 → 用静态白
  assert.match(rule[0], /color:\s*var\(--dsw-static-neutral-bluish-00/, '蓝底应配静态白前景')
})
t('悬停用原生 info 悬停色', () => {
  const rule = mod.__test.CSS.match(/\.sl-composer-btn:hover[^{]*\{[^}]*\}/)
  assert.ok(rule, '缺少悬停规则')
  assert.match(rule[0], /--dsw-alias-button-info-hover/)
})
t('右栏不加那层浅灰底色（否则用户气泡不突出）', () => {
  // 只看声明部分：注释里说明"曾用过 sidebar-fill"是有价值的文档，不该判违规
  const decl = stripComments(mod.__test.CSS)
  assert.ok(!decl.includes('--dsw-specific-sidebar-fill'),
    '右栏不该再用 sidebar-fill(#f9fafb)，让气泡(#edf3fe)在白底上更明显')
  // 但 .sl-right 本身应保留 bg-layer-1(#fff)
  assert.match(decl, /\.sl-right\{[^}]*background:var\(--dsw-alias-bg-layer-1\)/,
    '右栏应回到 bg-layer-1(#fff)')
})

console.log('\n用户消息：右对齐、左侧刻意留白、不标角色')
t('用户消息右对齐（与原生 DSH 一致）', () => {
  const rule = mod.__test.CSS.match(/\.sl-msg-user\{[^}]*\}/)
  assert.ok(rule, '缺少 .sl-msg-user 规则')
  assert.match(rule[0], /align-items:\s*flex-end/, '应右对齐')
})
t('气泡收缩到内容宽度并限制最大宽度（左侧因此留出距离）', () => {
  const rule = mod.__test.CSS.match(/\.sl-msg-user \.sl-msg-body\{[^}]*\}/)
  assert.ok(rule, '缺少用户气泡规则')
  assert.match(rule[0], /max-width:\s*\d+%/, '需要 max-width，否则长消息会撑满整行')
  assert.ok(!/margin-left:\s*calc\(-1/.test(mod.__test.CSS),
    '不该再有"贴左边缘"的负边距（那是上一版理解错的做法）')
})
t('用户消息不再渲染角色标签', () => {
  const idx = code.indexOf('function MessageBlock')
  const fn = fnBody('MessageBlock')
  assert.ok(!fn.includes('sl-msg-role'), '不该再有角色标签元素')
  assert.ok(!fn.includes("'我'"), '不该再有「我」')
})
t('助手消息也不再带标签（用户要求去掉；左右分栏已足够区分）', () => {
  // 注意：不能全文件搜 'AI 研究助手' —— 面板标题就是这个名字，那是应该保留的。
  // 这里只检查**消息渲染**的两处（MessageBlock 与流式块）。
  const mb = code.slice(code.indexOf('function MessageBlock'), code.indexOf('function ChatPane'))
  assert.ok(!mb.includes('sl-msg-role'), 'MessageBlock 不该有角色标签：' + mb.slice(0, 200))
  const liveIdx = code.indexOf("className: 'sl-msg sl-msg-assistant', key: 'live'")
  const live = code.slice(liveIdx, liveIdx + 300)
  assert.ok(!live.includes('sl-msg-role'), '流式块不该有角色标签')
  assert.ok(!mod.__test.CSS.includes('sl-msg-role'), '该 CSS 规则也应删除（避免死样式）')
  // 面板标题仍应保留
  assert.ok(code.includes("title: 'AI 研究助手'"), '面板标题不该被误删')
})

console.log('\n工具返回不再当内容展示（中间过程不该挡在回答前面）')
const { groupMessages, toolItemOf } = mod.__test

const T = (name, isError = false, content = '工具原始返回') => ({
  role: 'tool', content, toolCalls: [{ name, args: { s: '600519' }, isError }],
})
const U = (c) => ({ role: 'user', content: c, id: 'u' + c })
const A = (c) => ({ role: 'assistant', content: c, id: 'a' + c })

t('一轮 = 用户提问 + 工具 + 助手回答，归到同一组', () => {
  const g = groupMessages([U('问'), T('stock_quote'), T('stock_money_flow'), A('答')])
  assert.equal(g.length, 1)
  assert.equal(g[0].user.content, '问')
  assert.equal(g[0].assistant.content, '答')
  assert.equal(g[0].tools.length, 2)
})
t('多轮各自成组（工具不串到别的轮次）', () => {
  const g = groupMessages([
    U('问1'), T('a'), A('答1'),
    U('问2'), T('b'), T('c'), A('答2'),
  ])
  assert.equal(g.length, 2)
  assert.deepEqual(g[0].tools.map((x) => x.toolCalls[0].name), ['a'])
  assert.deepEqual(g[1].tools.map((x) => x.toolCalls[0].name), ['b', 'c'])
})
t('未调工具的一轮：tools 为空', () => {
  const g = groupMessages([U('问'), A('答')])
  assert.equal(g.length, 1)
  assert.deepEqual(g[0].tools, [])
})
t('中途取消（有工具没回答）：过程不丢，仍能渲染出摘要', () => {
  const g = groupMessages([U('问'), T('stock_quote')])
  assert.equal(g.length, 1)
  assert.equal(g[0].assistant, null)
  assert.equal(g[0].tools.length, 1, '工具不能因为"没回答"就被丢掉')
})
t('历史开头不是用户消息（只有助手回答）也不丢内容', () => {
  const g = groupMessages([A('孤立回答')])
  assert.equal(g.length, 1)
  assert.equal(g[0].user, null)
  assert.equal(g[0].assistant.content, '孤立回答')
})
t('空输入不崩', () => {
  assert.deepEqual(groupMessages([]), [])
  assert.deepEqual(groupMessages(null), [])
})
t('toolItemOf 把落库形状转成明细项形状', () => {
  const it = toolItemOf({
    role: 'tool', content: '{"price":1335}',
    toolCalls: [{ name: 'stock_quote', args: { symbols: ['600519'] }, isError: false }],
  })
  assert.equal(it.name, 'stock_quote')
  assert.equal(it.isError, false)
  assert.equal(it.text, '{"price":1335}')
  assert.ok(it.argsRaw.includes('600519'), '参数要能显示出来')
})
t('toolItemOf 对缺失字段不崩（返回"未知工具"）', () => {
  const it = toolItemOf({ role: 'tool', content: 'x' })
  assert.equal(it.name, '(未知工具)')
  assert.equal(it.isError, false)
})
t('渲染时不再把工具消息当独立内容（只出现在摘要里）', () => {
  // 渲染循环里不该再有"直接 for msgs 渲染 MessageBlock"的写法
  const loopIdx = code.indexOf('for (const g of groupMessages(msgs))')
  assert.ok(loopIdx > 0, '应改为按轮次分组渲染')
  const block = code.slice(loopIdx, loopIdx + 700)
  assert.ok(block.includes('ToolGroup'), '工具应折进 ToolGroup')
  assert.ok(!code.includes("h('div', { className: 'sl-msg-role' }, '工具返回')"), '不该再有"工具返回"独立块')
})
t('摘要默认收起，点"明细"才展开', () => {
  const idx = code.indexOf('function ToolGroup')
  const fn = fnBody('ToolGroup')
  assert.ok(fn.includes('useState(false)'), '默认应是收起状态')
  assert.ok(fn.includes("'明细'"), '应有展开入口')
  assert.ok(fn.includes("'收起'"), '展开后应能收起')
})
t('工具失败在收起状态下也能看出来（不藏问题）', () => {
  const idx = code.indexOf('function ToolGroup')
  const fn = fnBody('ToolGroup')
  assert.ok(fn.includes('个失败'), '失败数量应写进那一行')
  assert.ok(fn.includes('sl-tools-warn'), '失败应有警示样式')
})
t('摘要只说"用了几个工具"，不列举名称（点展开就能看是哪些）', () => {
  const idx = code.indexOf('function ToolGroup')
  const fn = fnBody('ToolGroup')
  assert.ok(fn.includes('使用了'), '应说明数量')
  assert.ok(!fn.includes('sl-tools-names'), '不该再列举工具名')
  assert.ok(!fn.includes('uniq.join'), '不该再把名称拼进这一行')
  assert.ok(fn.includes("'明细'"), '仍应保留展开入口（名称在那里看）')
  assert.ok(!mod.__test.CSS.includes('sl-tools-names'), '对应的 CSS 规则也应删除')
})
t('流式过程中工具也只占一行（不逐个铺开）', () => {
  // 注意：要定位 JSX 用法，不能 indexOf('sl-tools-live')——那会先命中 CSS 规则
  const idx = code.indexOf("className: 'sl-tools-live'")
  assert.ok(idx > 0, '缺少流式紧凑行')
  const block = code.slice(idx, idx + 400)
  assert.ok(block.includes('.join('), '应把多个工具名合成一行：' + block)
  assert.ok(block.includes('pending'), '应能看出哪个还在调用中')
})

console.log('\nCSS 定义了工具摘要与紧凑行的样式')
t('工具摘要样式齐全', () => {
  const css = mod.__test.CSS
  for (const sel of ['.sl-tools{', '.sl-tools-head{', '.sl-tools-toggle{',
    '.sl-tools-body{', '.sl-tools-live{', '.sl-tools-warn{']) {
    assert.ok(css.includes(sel), '缺少 ' + sel)
  }
})

console.log('\nK线可视窗口：缩放/平移（纯函数，替代根数预设）')
const {
  CHART_VIEW, CHART_GEO, BARS_BUFFER,
  clampView, resolveView, sliceRange, sliceSeries, zoomView, panView, jumpView,
} = mod.__test

t('窗口永远落在缓冲区范围内（不越界）', () => {
  const total = 300
  for (const v of [
    { count: 120, end: 299 }, { count: 120, end: 0 }, { count: 5, end: 299 },
    { count: 9999, end: 299 }, { count: 120, end: -1 }, { count: 120, end: 99999 },
  ]) {
    const r = clampView(v, total)
    assert.ok(r.count >= 1 && r.count <= total, `count 越界: ${r.count}`)
    assert.ok(r.end >= r.count - 1 && r.end <= total - 1, `end 越界: ${r.end}`)
  }
})
t('缓冲区为空时不崩', () => {
  assert.deepEqual(clampView({ count: 120, end: 10 }, 0), { count: 0, end: -1 })
  assert.deepEqual(sliceRange({ count: 120, end: 10 }, 0), { start: 0, end: -1 })
  assert.deepEqual(resolveView(120, -1, 0), { count: 0, end: -1 })
})
t('数据不足时窗口收窄到实际根数（而不是显示空白）', () => {
  const r = clampView({ count: 800, end: 4 }, 5)
  assert.equal(r.count, 5)
  assert.equal(r.end, 4)
})
t('非有限输入回落到默认根数', () => {
  const r = clampView({ count: NaN, end: NaN }, 300)
  assert.equal(r.count, CHART_VIEW.default)
  assert.equal(r.end, 299, '未指定位置时应停在最新')
})
t('end<0 表示"跟随最新"（换标的/周期后看最新，而不是钉在旧位置）', () => {
  assert.equal(resolveView(120, -1, 300).end, 299)
  assert.equal(resolveView(120, -1, 300).count, 120)
  assert.equal(resolveView(120, 150, 300).end, 150, '用户平移过就尊重绝对下标')
})
t('切片区间与可见根数一致', () => {
  const total = 300
  const view = { count: 60, end: 299 }
  const r = sliceRange(view, total)
  assert.deepEqual(r, { start: 240, end: 299 })
  assert.equal(r.end - r.start + 1, 60)
})
t('sliceSeries 切出的长度与窗口一致（线不会与柱体错位）', () => {
  const total = 300
  const series = Array.from({ length: total }, (_, i) => i)
  const view = { count: 50, end: 200 }
  const out = sliceSeries(series, view, total)
  assert.equal(out.length, 50)
  assert.equal(out[0], 151)
  assert.equal(out.at(-1), 200)
})
t('缩放：放大 = 更少根，缩小 = 更多根', () => {
  const total = 800
  const v = { count: 200, end: 799 }
  assert.ok(zoomView(v, 1 / CHART_VIEW.keyFactor, total).count < 200, '放大应减少根数')
  assert.ok(zoomView(v, CHART_VIEW.keyFactor, total).count > 200, '缩小应增加根数')
})
t('缩放锚定：鼠标指着哪一根，缩放后那一根位置不变', () => {
  // 注意：必须用**缓冲区中间**的窗口。若窗口贴在最右端，
  // 缩小后右边缘会超出最新一根 → 必须夹取，此时锚点位移是**正确行为**（单独一条测）。
  const total = 800
  const v = { count: 200, end: 600 }
  const anchor = 500          // 窗口内倒数第 100 根
  const relBefore = v.end - anchor
  for (const f of [1 / CHART_VIEW.keyFactor, CHART_VIEW.keyFactor, 1 / 1.5, 1.5]) {
    const next = zoomView(v, f, total, anchor)
    assert.ok(next.end < total - 1, `这一步不该触发夹取（否则测的不是锚定）：${JSON.stringify(next)}`)
    const relAfter = next.end - anchor
    const expected = Math.round(relBefore * (next.count / v.count))
    assert.ok(Math.abs(relAfter - expected) <= 1,
      `锚点漂移过大：f=${f} 前 ${relBefore} 后 ${relAfter} 期望 ${expected}`)
  }
})
t('贴在最右端缩放时，夹取优先于锚定（否则会滑出数据）', () => {
  const total = 800
  const v = { count: 200, end: 799 }
  const next = zoomView(v, CHART_VIEW.keyFactor, total, 700)
  assert.equal(next.end, total - 1, '右边缘不能越过最新一根')
  assert.ok(next.count > 200, '根数仍应增加')
})
t('缩放倍率为 1 时不改变窗口', () => {
  const v = clampView({ count: 200, end: 500 }, 800)
  assert.deepEqual(zoomView(v, 1, 800), v)
})
t('平移：正数往更近（右），负数往更早（左）', () => {
  const total = 800
  const v = { count: 200, end: 799 }
  assert.equal(panView(v, -50, total).end, 749)
  assert.equal(panView({ count: 200, end: 400 }, 50, total).end, 450)
})
t('平移不会越过两端（不会滑出历史）', () => {
  const total = 800
  const atStart = panView({ count: 200, end: 199 }, -9999, total)
  assert.equal(atStart.end, atStart.count - 1, '左端：窗口右边缘最少留 count 根')
  const atEnd = panView({ count: 200, end: 400 }, 9999, total)
  assert.equal(atEnd.end, total - 1, '右端：不能超过最新一根')
})
t('缩放不会越过上下限，也不会越出缓冲区', () => {
  const total = 100
  let v = { count: 20, end: 99 }
  for (let i = 0; i < 30; i++) v = zoomView(v, 1 / 2, total)     // 一直放大
  assert.equal(v.count, Math.min(CHART_VIEW.min, total))
  let w = { count: 20, end: 99 }
  for (let i = 0; i < 30; i++) w = zoomView(w, 2, total)          // 一直缩小
  assert.equal(w.count, total, '最多显示全部可用数据')
})
t('跳到最早/最新', () => {
  const total = 800
  const v = { count: 120, end: 400 }
  assert.equal(jumpView(v, 'last', total).end, 799)
  assert.equal(jumpView(v, 'first', total).end, 119)
})
t('连续操作后窗口始终合法（随机走 200 步验证不变量）', () => {
  const total = 500
  let v = resolveView(120, -1, total)
  const ops = [() => zoomView(v, 1.25, total, 60), () => zoomView(v, 0.8, total, 10),
    () => panView(v, -37, total), () => panView(v, 88, total),
    () => jumpView(v, 'first', total), () => jumpView(v, 'last', total)]
  for (let i = 0; i < 200; i++) {
    v = ops[(i * 7) % ops.length]()
    assert.ok(v.count >= Math.min(CHART_VIEW.min, total) && v.count <= total, `count=${v.count}`)
    assert.ok(v.end >= v.count - 1 && v.end <= total - 1, `end=${v.end} count=${v.count}`)
    const r = sliceRange(v, total)
    assert.equal(r.end - r.start + 1, v.count, '切片长度必须等于可见根数')
  }
})
t('图表几何与交互层共用同一份常量（否则容器一宽就会算偏）', () => {
  assert.ok(CHART_GEO && CHART_GEO.W > 0 && CHART_GEO.PAD_L >= 0 && CHART_GEO.PAD_R >= 0)
  // KLineChart 必须从 CHART_GEO 取值，而不是自己再写一遍 900/8/56
  const idx = code.indexOf('function KLineChart')
  const head = fnBody('KLineChart').slice(0, 400)
  assert.ok(head.includes('CHART_GEO'), 'KLineChart 应引用共享几何常量')
  assert.ok(!/const W = 900/.test(code), '不该再硬编码 900')
})

console.log('\nK线交互：键位与滚轮')
t('方向键上下缩放、左右平移（与看盘软件一致的键位）', () => {
  const idx = code.indexOf('function ChartStage')
  const fn = fnBody('ChartStage')
  for (const k of ["'ArrowUp'", "'ArrowDown'", "'ArrowLeft'", "'ArrowRight'",
    "'PageUp'", "'PageDown'", "'Home'", "'End'"]) {
    assert.ok(fn.includes(k), '缺少键位 ' + k)
  }
  assert.ok(fn.includes('preventDefault'), '必须阻止默认滚动，否则按键时页面也在动')
})
t('滚轮用原生非 passive 监听（React 的 onWheel 是被动的，preventDefault 无效）', () => {
  const idx = code.indexOf('function ChartStage')
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes("addEventListener('wheel'"), '应挂原生 wheel 监听')
  assert.ok(fn.includes('passive: false'), '必须 passive:false 才能阻止页面滚动')
  assert.ok(fn.includes('removeEventListener'), '卸载要移除监听，避免泄漏')
})
t('滚轮以指针所在那根为锚（"鼠标指着哪里，哪里不动"）', () => {
  const idx = code.indexOf('function ChartStage')
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes('barIndexAt'), '应反算指针所在的下标')
  assert.ok(fn.includes('getBoundingClientRect'), '需要把 client 坐标换算到 viewBox 单位')
  assert.ok(fn.includes('CHART_GEO.W'), '换算必须用共享几何常量')
})
t('容器可聚焦（否则接不到键盘）', () => {
  const idx = code.indexOf('function ChartStage')
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes('tabIndex: 0'), '需要 tabIndex 才能聚焦')
  assert.ok(mod.__test.CSS.includes('.sl-stage:focus-visible'), '应有可见焦点环')
})

console.log('\nK线数据流：缓冲区 + 窗口切片')
t('K线一次取整段缓冲区，不再按可视根数请求', () => {
  assert.ok(code.includes('count: BARS_BUFFER'), '应请求整段缓冲区')
  assert.ok(!code.includes('COUNTS'), '根数预设应已移除')
  const idx = code.indexOf('COUNTS')
  assert.equal(idx, -1, '不该再有根数预设常量')
})
t('指标在缓冲区上求值（否则窗口左边缘的 MA 会变空值）', () => {
  const idx = code.indexOf("apiFetch('/formula/run'")
  const block = code.slice(idx, idx + 260)
  assert.ok(block.includes('bufferCount'), '公式应按缓冲区长度求值：' + block)
  assert.ok(!block.includes('count: view'), '不该按可见窗口求值')
  assert.ok(code.includes('const bufferCount = bars.length > 0 ? bars.length : BARS_BUFFER'))
})
t('图表收到的是**切片后**的数据', () => {
  assert.ok(code.includes('bars: visBars'), '图表应收到可见切片')
  assert.ok(code.includes('sliceSeries(o.values, view, total)'), '公式线也要按同一窗口切片')
})
t('信号下标从缓冲区绝对值换算成窗口相对值', () => {
  assert.ok(code.includes('Number(i) - range.start'), '应做下标换算')
  assert.ok(code.includes('i >= 0 && i < visBars.length'), '应过滤掉窗口外的信号')
})
t('窗口变化（缩放/平移）不触发重新取数或重算指标', () => {
  const klineIdx = code.indexOf("apiFetch('/kline'")
  const klineBlock = code.slice(klineIdx, klineIdx + 400)
  assert.ok(!klineBlock.includes('viewCount'), 'K线请求不该依赖可视根数')
  assert.ok(!klineBlock.includes('viewEnd'), 'K线请求不该依赖平移位置')
  const fIdx = code.indexOf("apiFetch('/formula/run'")
  const fDeps = code.slice(fIdx, fIdx + 700)
  assert.ok(!fDeps.includes('viewCount'), '公式求值不该依赖可视根数（否则每滚一格就重算）')
})
t('看盘软件习惯：切标的/周期/复权回到最新', () => {
  const idx = code.indexOf("apiFetch('/kline'")
  const block = code.slice(idx - 400, idx + 100)
  assert.ok(block.includes('setViewEnd(-1)'), '换标的/周期/复权时应把窗口拉回最新')
})
t('不在最新位置时给出提示（看盘软件也会告诉你）', () => {
  assert.ok(code.includes('正在看历史'), '应提示正在看历史')
  assert.ok(code.includes("onJump('last')") || code.includes('按 End 回到最新'), '应告诉用户怎么回去')
})
t('缩放到数据起点要说明是"数据只到这里"，而不是默默停住', () => {
  // 腾讯日线上限约 800 根（≈3.2 年），缩到头是数据限制而非软件问题，必须讲清
  assert.ok(code.includes('已到数据起点'), '应说明已到数据起点')
  assert.ok(code.includes('range.start === 0'), '应判断窗口左边缘是否贴到缓冲区开头')
})
t('可见根数只在调整时短暂显示（与右栏宽度提示同一处理）', () => {
  const idx = code.indexOf('function ChartStage')
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes('useTransientHint'), '应复用"短暂显示"机制')
  assert.ok(mod.__test.CSS.includes('.sl-view-hint-off{opacity:0}'), '应有淡出态')
})

console.log('\n画线：锚点解析与几何投影（纯函数）')
const { resolveDrawings, indexOfDate, summarizeDrawingIssues, DRAW_ISSUE } = mod.__test

/** 造一段连续交易日的 K 线（跳过周末，够用即可） */
function makeBars(n, start = '2026-01-05') {
  const out = []
  let d = new Date(start + 'T00:00:00Z')
  while (out.length < n) {
    const wd = d.getUTCDay()
    if (wd !== 0 && wd !== 6) out.push({ time: d.toISOString().slice(0, 10), close: 100 + out.length })
    d = new Date(d.getTime() + 86400000)
  }
  return out
}
const BARS = makeBars(60)
const D = (i) => BARS[i].time

t('indexOfDate 精确匹配，找不到返回 -1', () => {
  assert.equal(indexOfDate(BARS, D(10)), 10)
  assert.equal(indexOfDate(BARS, '1999-01-01'), -1)
  assert.equal(indexOfDate(BARS, null), -1)
  assert.equal(indexOfDate(null, D(1)), -1)
})
t('水平线：只需价格，锚点日期缺失也不影响绘制', () => {
  const r = resolveDrawings(BARS, 0, [{ id: 'a', type: 'hline', anchors: [{ date: null, price: 1335 }], adjust: 'qfq' }], 'qfq')
  assert.equal(r.shapes.length, 1)
  assert.equal(r.shapes[0].price, 1335)
  assert.equal(r.issues.length, 0, 'hline 不该因为日期缺失而报问题')
})
t('趋势线：两个锚点解析成窗口相对下标', () => {
  const r = resolveDrawings(BARS, 0, [{
    id: 't', type: 'trend', adjust: 'qfq',
    anchors: [{ date: D(5), price: 100 }, { date: D(25), price: 120 }],
  }], 'qfq')
  assert.equal(r.shapes.length, 1)
  assert.deepEqual(r.shapes[0].points.map((p) => p.i), [5, 25])
  assert.deepEqual(r.shapes[0].points.map((p) => p.price), [100, 120])
})
t('窗口平移后：下标随之改变（锚点却不变）', () => {
  const dr = [{ id: 't', type: 'trend', adjust: 'qfq', anchors: [{ date: D(30), price: 100 }, { date: D(40), price: 110 }] }]
  assert.deepEqual(resolveDrawings(BARS, 0, dr, 'qfq').shapes[0].points.map((p) => p.i), [30, 40])
  assert.deepEqual(resolveDrawings(BARS, 20, dr, 'qfq').shapes[0].points.map((p) => p.i), [10, 20])
})
t('窗口外的端点会得到负下标/超出下标（靠线性外推，交给画布裁掉）', () => {
  const dr = [{ id: 't', type: 'trend', adjust: 'qfq', anchors: [{ date: D(5), price: 100 }, { date: D(50), price: 130 }] }]
  const r = resolveDrawings(BARS, 20, dr, 'qfq')
  assert.deepEqual(r.shapes[0].points.map((p) => p.i), [-15, 30])
})
t('锚点日期不在数据范围内 → 不画，并说明是哪一天、范围是多少', () => {
  const r = resolveDrawings(BARS, 0, [{
    id: 'x', type: 'trend', adjust: 'qfq', anchors: [{ date: D(5), price: 100 }, { date: '1999-01-01', price: 1 }],
  }], 'qfq')
  assert.equal(r.shapes.length, 0, '一个端点定位不到就不该画半截线')
  assert.equal(r.issues.length, 1)
  assert.equal(r.issues[0].code, DRAW_ISSUE.NO_DATE)
  assert.match(r.issues[0].message, /1999-01-01/)
  assert.match(r.issues[0].message, /不在当前数据范围内/)
})
t('标记点：单点解析', () => {
  const r = resolveDrawings(BARS, 0, [{
    id: 'm', type: 'marker', label: '财报日', adjust: 'qfq', anchors: [{ date: D(7), price: 104 }],
  }], 'qfq')
  assert.equal(r.shapes[0].type, 'marker')
  assert.equal(r.shapes[0].points[0].i, 7)
})
t('复权模式不一致：**照画但标注**（不画会以为丢了，不标注会以为它还对得上）', () => {
  const r = resolveDrawings(BARS, 0, [{ id: 'a', type: 'hline', anchors: [{ date: D(1), price: 100 }], adjust: 'qfq' }], 'none')
  assert.equal(r.shapes.length, 1, '仍应绘制')
  assert.equal(r.shapes[0].staleAdjust, true, '应标记为复权不一致')
  assert.equal(r.issues.filter((x) => x.code === DRAW_ISSUE.ADJUST).length, 1)
  assert.match(r.issues[0].message, /前复权/)
})
t('复权模式一致时不标记', () => {
  const r = resolveDrawings(BARS, 0, [{ id: 'a', type: 'hline', anchors: [{ date: D(1), price: 100 }], adjust: 'qfq' }], 'qfq')
  assert.equal(r.shapes[0].staleAdjust, false)
  assert.equal(r.issues.length, 0)
})
t('缺锚点 / 价格非法 → 报问题而不是静默跳过', () => {
  const r = resolveDrawings(BARS, 0, [
    { id: 'no-anchor', type: 'hline', anchors: [], adjust: 'qfq' },
    { id: 'bad-price', type: 'hline', anchors: [{ date: D(1), price: NaN }], adjust: 'qfq' },
  ], 'qfq')
  assert.equal(r.shapes.length, 0)
  assert.equal(r.issues.length, 2)
  assert.ok(r.issues.every((x) => x.code === DRAW_ISSUE.BAD))
})
t('空输入不崩', () => {
  assert.deepEqual(resolveDrawings(BARS, 0, [], 'qfq'), { shapes: [], issues: [] })
  assert.deepEqual(resolveDrawings(null, 0, null, 'qfq').shapes, [])
})
t('问题汇总能读（区分"未显示"与"位置可能对不上"）', () => {
  assert.equal(summarizeDrawingIssues([]), null)
  const text = summarizeDrawingIssues([
    { code: DRAW_ISSUE.NO_DATE }, { code: DRAW_ISSUE.NO_DATE },
    { code: DRAW_ISSUE.ADJUST },
  ])
  assert.match(text, /2 条因锚点日期不在当前数据范围内未显示/)
  assert.match(text, /1 条是在别的复权模式下画的/)
})

console.log('\n交互画线：吸附 / 命中 / 坐标换算（纯函数）')
const {
  snapAnchor, hitTestDrawings, distanceToSegment, computePriceScale, priceAtY,
  DRAW_TOOLS, extendLine, ghostFromPoint, LINE_EXTS, DRAW_COLORS, drawingColorCss, draftFromPoint, paletteAnchor, PALETTE_W, hitTestRect, resolveMeasure,
} = mod.__test

const SB = [
  { time: '2026-01-05', open: 100, high: 106, low: 98, close: 104 },
  { time: '2026-01-06', open: 104, high: 110, low: 103, close: 109 },
  { time: '2026-01-07', open: 109, high: 112, low: 105, close: 107 },
]
const HIT_GEO = { padL: 8, padT: 10, plotW: 836, priceH: 240, n: 60 }
const HIT_SCALE = { minP: 100, maxP: 120, span: 20 }
const xC60 = (i) => 8 + (836 / 60) * (i + 0.5)
const yP60 = (p) => 10 + (1 - (p - 100) / 20) * 240

t('吸附：把价格吸到那根 K 线的 高/低/收 三者中最近的一个', () => {
  assert.equal(snapAnchor(SB, 0.0, 105.5).price, 106, '靠 high 更近')
  assert.equal(snapAnchor(SB, 0.0, 97.2).price, 98, '靠 low 更近')
  assert.equal(snapAnchor(SB, 0.0, 103.9).price, 104, '靠 close 更近')
  assert.equal(snapAnchor(SB, 0.0, 105.5).kind, 'high')
})
t('吸附：同时吸到最近的那根 K 线（下标四舍五入并夹进范围）', () => {
  assert.equal(snapAnchor(SB, 1.4, 110).i, 1)
  assert.equal(snapAnchor(SB, 1.6, 110).i, 2)
  assert.equal(snapAnchor(SB, -5, 100).i, 0, '越界夹到第一根')
  assert.equal(snapAnchor(SB, 99, 100).i, 2, '越界夹到最后一根')
})
t('吸附：返回该根的日期（锚点要存日期，不能存序号）', () => {
  assert.equal(snapAnchor(SB, 1, 110).date, '2026-01-06')
})
t('吸附：拿不到 K 线时保留原值，不硬掰', () => {
  const r = snapAnchor([], 3.2, 108)
  assert.equal(r.snapped, false)
  assert.equal(r.i, 3.2)
  assert.equal(r.price, 108)
  assert.equal(snapAnchor(SB, NaN, 100).snapped, false)
})
t('点到线段距离（命中判定的基础）', () => {
  assert.equal(distanceToSegment(0, 5, 0, 0, 10, 0), 5, '垂直距离')
  assert.equal(distanceToSegment(-5, 0, 0, 0, 10, 0), 5, '端点外按端点算')
  assert.equal(distanceToSegment(0, 0, 0, 0, 0, 0), 0, '退化成一个点')
})
t('命中测试：水平线按垂直距离判定', () => {
  const shapes = [{ id: 'h1', type: 'hline', price: 110 }]
  const y = yP60(110)
  assert.equal(hitTestDrawings(shapes, 400, y, 6, HIT_GEO, HIT_SCALE), 'h1')
  assert.equal(hitTestDrawings(shapes, 400, y + 30, 6, HIT_GEO, HIT_SCALE), null, '离太远不命中')
})
t('命中测试：趋势线按点到线段距离，取最近的一条', () => {
  const shapes = [
    { id: 'near', type: 'trend', points: [{ i: 0, price: 100 }, { i: 60, price: 120 }] },
    { id: 'far', type: 'trend', points: [{ i: 0, price: 100 }, { i: 60, price: 100 }] },
  ]
  assert.equal(hitTestDrawings(shapes, xC60(30), yP60(110), 6, HIT_GEO, HIT_SCALE), 'near')
  assert.equal(hitTestDrawings([], xC60(30), yP60(110), 6, HIT_GEO, HIT_SCALE), null)
})
t('命中测试：标记点按半径', () => {
  const shapes = [{ id: 'm1', type: 'marker', points: [{ i: 10, price: 105 }] }]
  assert.equal(hitTestDrawings(shapes, xC60(10), yP60(105), 6, HIT_GEO, HIT_SCALE), 'm1')
  assert.equal(hitTestDrawings(shapes, xC60(10) + 50, yP60(105), 6, HIT_GEO, HIT_SCALE), null)
})
t('比例尺：把叠加线一起纳入（否则均线被裁）', () => {
  const bars = [{ high: 110, low: 100 }, { high: 112, low: 101 }]
  assert.equal(computePriceScale(bars, []).maxP, 112)
  assert.equal(computePriceScale(bars, []).minP, 100)
  const withLine = computePriceScale(bars, [{ values: [130, null, 90] }])
  assert.equal(withLine.maxP, 130)
  assert.equal(withLine.minP, 90, '公式线超出的部分要纳入')
})
t('比例尺：空数据不产生 NaN 或 0 span（否则后面会除零）', () => {
  const s = computePriceScale([], [])
  assert.ok(Number.isFinite(s.maxP) && Number.isFinite(s.minP))
  assert.ok(s.span > 0)
})
t('y → 价格：与图表 yP 互逆（顶=最高，底=最低）', () => {
  const scale = { minP: 100, maxP: 120, span: 20 }
  const geo = { priceH: 240, padT: 10 }
  assert.equal(priceAtY(10, scale, geo), 120, '顶部对应最高价')
  assert.equal(priceAtY(250, scale, geo), 100, '底部对应最低价')
  assert.equal(priceAtY(130, scale, geo), 110, '中点对应中价')
})
t('y → 价格：比例尺高度为 0 时返回 null 而不是 NaN', () => {
  assert.equal(priceAtY(100, { minP: 1, maxP: 1, span: 0 }, { priceH: 0, padT: 0 }), null)
})
t('画线工具有四种，与宿主侧类型一致', () => {
  assert.deepEqual(DRAW_TOOLS.map((t) => t.k).sort(), ['circle', 'hline', 'marker', 'trend'])
  assert.ok(DRAW_TOOLS.every((t) => t.label && t.tip))
})
t('趋势线提供 线段 / 射线 / 直线 三种延伸方式', () => {
  assert.deepEqual(LINE_EXTS.map((x) => x.k), ['segment', 'ray', 'line'])
  assert.ok(code.includes('saveDrawingMemo(selectedDrawingId, drawingEdit.label, drawingEdit.reason, x.k)'),
    '切换延伸方式要立刻保存')
})

console.log('\n交互画线：接线契约')
t('提供画线工具条（含"选择"与"删除选中"）', () => {
  assert.ok(code.includes('DRAW_TOOLS.map'), '缺少工具列表')
  assert.ok(code.includes("'选择'"), '需要"选择"模式（否则无法点选）')
  assert.ok(code.includes('删除选中'), '需要删除入口')
})
t('画图工具常驻在工具栏（不再需要点开）', () => {
  // 用户反馈：没必要收起，常驻也没问题
  assert.ok(code.includes('sl-tool-palette'), '工具组应有独立容器（同一行内靠右延续）')
  assert.ok(!code.includes("}, '画图')"), '不该再有「画图」折叠按钮')
  assert.ok(!code.includes('paletteOpen'), '折叠状态应已移除')
  assert.ok(mod.__test.CSS.includes('.sl-tool-palette{'), '缺少工具组样式')
})
t('吸附开关：按钮显示"吸附开/吸附关"两种状态', () => {
  assert.ok(code.includes('snapOn'), '应有吸附开关状态')
  assert.ok(code.includes("snapEffective ? '吸附开' : '吸附关'"), '按钮应显示当前状态')
  assert.ok(code.includes('setSnapOn(!snapOn)'), '点击应切换')
})
t('按钮显示的是**实际生效**状态：按住 Ctrl 时跟着变', () => {
  // 用户反馈：按着 Ctrl 画完，若按钮仍显示"吸附开"会让人以为没生效
  assert.ok(code.includes('const snapEffective = ctrlHeld ? !snapOn : snapOn'), '应算出实际生效状态')
  assert.ok(code.includes('setCtrlHeld'), '应跟踪 Ctrl 是否按住')
  const fn = fnBody('Panel')
  assert.ok(fn.includes("e.key === 'Control' || e.key === 'Meta'"), '应识别 Ctrl/Cmd')
  assert.ok(fn.includes("addEventListener('blur'"), '窗口失焦要清掉按键状态（否则会一直显示按下）')
  assert.ok(fn.includes('removeEventListener'), '卸载要移除监听')
})
t('按住 Ctrl 临时取反吸附状态（想画"半路"价位时用）', () => {
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes('e.ctrlKey || e.metaKey'), '应识别 Ctrl/Cmd')
  assert.ok(fn.includes('!snapOn : snapOn !== false'), '按住时应取反')
})
t('指针处理常驻挂载，由模式分流（画线 / 框选 / 框选放大）', () => {
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes('const mode = tool ==='), '应算出当前模式')
  assert.ok(fn.includes('onPointerDown: onPointerDown'), '指针处理常驻（三种模式都要用）')
  assert.ok(fn.includes('onPointerUp: endDraw'), '指针处理常驻')
})
t('预览线：草稿上提到 Panel 以便交给图表渲染', () => {
  assert.ok(code.includes('onDraftChange: setDraftDrawing'), '草稿状态应上提')
  assert.ok(code.includes('draftDrawing ? [draftDrawing] : []'), '草稿要并入画线交给图表')
  assert.ok(code.includes('preview: true'), '草稿应带 preview 标记')
})
t('保存时带上日期锚点与当前复权模式', () => {
  const block = fnBody('Panel')
  assert.ok(block.includes("'/drawings/add'"), '应调用保存接口')
  assert.ok(block.includes('anchors'), '要传锚点')
  assert.ok(block.includes('adjust'), '要带复权模式（不记就会错位）')
})
t('定位不到真实交易日的锚点不落库（存下来也对不齐）', () => {
  assert.ok(fnBody('ChartStage').includes('anchors.every(Boolean)'), '锚点为 null 时应放弃保存')
})
t('点选与 Delete/Esc 键', () => {
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes("'Delete'"), 'Delete 删除选中（含多选）')
  assert.ok(fn.includes("'Escape'"), 'Esc 取消选中')
  assert.ok(fn.includes('onDelete(selectedIds)'), '多选时应一次删掉全部')
  // 点选走 pointerup 的"小位移"路径（不再单独挂 onClick，避免两处处理同一次点击）
  assert.ok(fn.includes("onMarqueeDone(null, 'click', vb)"), '小位移应走点击选中')
  const panel = fnBody('Panel')
  assert.ok(panel.includes('hitTestDrawings(dr.shapes'), '命中判定在 Panel 里做')
})
t('画线模式下不触发选中（避免边画边选）', () => {
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes("if (mode !== 'draw')"), '框选/点选只在非画线模式处理')
})
t('画线模式有十字光标', () => {
  assert.ok(mod.__test.CSS.includes('.sl-stage-draw{cursor:crosshair}'))
})
t('换标的时收起画线状态（选中/草稿只对上一个标的有效）', () => {
  const idx = code.indexOf("apiFetch('/drawings'")
  const block = code.slice(idx - 300, idx + 60)
  assert.ok(block.includes('setDrawTool(null)'), '应重置工具')
  assert.ok(block.includes('setSelectedDrawingId(null)'), '应清空选中')
})

console.log('\n组件契约：父级传入的 prop 必须被解构（否则运行期 ReferenceError）')
/**
 * 真实缺陷：ChartStage 的解构列表漏了 windowStart，但函数体里用了它
 * → 一按鼠标就抛 ReferenceError，草稿建不起来，表现是"线画不上"。
 * 纯函数测试抓不到（只有 React 事件路径才会执行到），静态断言可以。
 * 所以这里做一条**通用**检查：调用点传的每个 prop，组件必须解构。
 */
function destructuredNames(compName) {
  const body = fnBody(compName)
  const m = new RegExp(`function ${compName}\\(\\{([\\s\\S]*?)\\}`).exec(body)
  assert.ok(m, `解析不出 ${compName} 的解构列表`)
  return new Set(m[1].split(',')
    .map((s) => s.trim().split(/[:=]/)[0].trim())
    .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s)))
}
function propsPassedAt(callMarker) {
  const idx = code.indexOf(callMarker)
  assert.ok(idx >= 0, '找不到调用点 ' + callMarker)
  const open = code.indexOf('{', idx + callMarker.length - 1)
  // 按**括号深度**取出该调用的对象字面量：否则嵌套调用里的 prop 会被误当成顶层的
  // （曾把 KLineChart 的 onHover 误报成 ChartStage 的 prop）
  let depth = 0
  let end = -1
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  assert.ok(end > 0, '解析不出调用点的对象字面量')
  const body = code.slice(open + 1, end)
  const parts = []
  let d2 = 0
  let cur = ''
  for (const ch of body) {
    if (ch === '{' || ch === '(' || ch === '[') d2++
    else if (ch === '}' || ch === ')' || ch === ']') d2--
    if (ch === ',' && d2 === 0) { parts.push(cur); cur = '' } else cur += ch
  }
  parts.push(cur)
  return parts
    .map((p) => { const m = /^\s*([A-Za-z_$][\w$]*)\s*[:(]?/.exec(p); return m ? m[1] : null })
    .filter(Boolean)
}
t('ChartStage 解构了所有传入的 prop', () => {
  const destructured = destructuredNames('ChartStage')
  const passed = propsPassedAt('h(ChartStage, {')
  assert.ok(passed.length >= 8, '没解析到 props（实际 ' + passed.length + ' 个）')
  for (const p of passed) {
    assert.ok(destructured.has(p), `传入了 ${p} 但没有解构 —— 一执行到就 ReferenceError`)
  }
})
t('KLineChart 解构了所有传入的 prop', () => {
  const destructured = destructuredNames('KLineChart')
  for (const p of propsPassedAt('h(KLineChart, {')) {
    assert.ok(destructured.has(p), `传入了 ${p} 但没有解构`)
  }
})
t('把这次踩的坑固定下来：不许再有"用到却没解构"的参数', () => {
  // 剥掉注释再查：注释里说明"曾经漏解构 windowStart"是有价值的文档，不该被判违规
  assert.ok(!stripComments(fnBody('ChartStage')).includes('windowStart'), 'ChartStage 不该再引用 windowStart')
  assert.ok(!stripComments(fnBody('snapAnchor')).includes('windowStart'), 'snapAnchor 不该再留用不到的 windowStart')
})
t('选中画线后可以写「标签」与「为什么画在这里」', () => {
  // 不做这一步，手画的线就只是条线；画线的价值在于记下一个判断。
  // （AI 画的线能带 reason，人画的也应该能带。）
  assert.ok(code.includes('sl-draw-edit'), '缺少说明编辑区')
  assert.ok(code.includes('为什么画在这里'), '应能写判断依据')
  assert.ok(code.includes('saveDrawingMemo'), '应有保存说明的动作')
  const fn = fnBody('Panel')
  assert.ok(fn.includes('saveDrawingMemo'), 'Panel 里应接入保存说明')
  // 保存说明必须复用同一条线（同 id），不能新增一条
  const idx = code.indexOf('const saveDrawingMemo')
  const block = code.slice(idx, idx + 700)
  assert.ok(block.includes('id: cur.id'), '应带原 id（否则会变成新增一条）')
  assert.ok(block.includes('anchors: cur.anchors'), '应保留原锚点')
  assert.ok(block.includes('adjust: cur.adjust'), '应保留原复权模式')
})

console.log('\n趋势线延伸：线段 / 射线 / 直线（裁剪到画布，纯函数）')
const R = { x0: 0, x1: 100, y0: 0, y1: 100 }
t('线段：只在两点之间（不超出）', () => {
  const s = extendLine(20, 20, 80, 80, R, 'segment')
  assert.equal(s.x1, 20); assert.equal(s.y1, 20)
  assert.equal(s.x2, 80); assert.equal(s.y2, 80)
})
t('线段：两点都在画布外时按区间裁剪（而不是整条丢掉）', () => {
  const s = extendLine(-50, 50, 150, 50, R, 'ray')   // ray 向左不延伸，向右延伸
  assert.ok(s, '应可见')
  assert.equal(Math.round(s.y1), 50)
  const seg = extendLine(-50, 50, 150, 50, R, 'segment')
  assert.ok(seg, '线段穿过画布也应可见')
  assert.equal(Math.round(seg.x1), 0, '裁剪到左边界')
  assert.equal(Math.round(seg.x2), 100, '裁剪到右边界')
})
t('射线：只往第二个点的方向延伸', () => {
  const s = extendLine(50, 50, 60, 50, R, 'ray')
  assert.equal(Math.round(s.x1), 50, '起点就是第一个锚点')
  assert.equal(Math.round(s.x2), 100, '右端延伸到画布边缘')
})
t('直线：两端都延伸到画布边缘', () => {
  const s = extendLine(50, 50, 60, 50, R, 'line')
  assert.equal(Math.round(s.x1), 0)
  assert.equal(Math.round(s.x2), 100)
})
t('直线：斜线的延长线被正确裁剪', () => {
  const s = extendLine(20, 20, 40, 40, R, 'line')
  assert.equal(Math.round(s.x1), 0); assert.equal(Math.round(s.y1), 0)
  assert.equal(Math.round(s.x2), 100); assert.equal(Math.round(s.y2), 100)
})
t('完全在画布外（平行且不相交）→ 返回 null，不画到天外', () => {
  assert.equal(extendLine(-10, 50, 0, 50, R, 'segment'), null)
  assert.equal(extendLine(50, 200, 60, 200, R, 'line'), null, '水平线在画布上方')
})
t('竖直/水平退化情形不崩', () => {
  assert.equal(Math.round(extendLine(50, 0, 50, 100, R, 'line').y1), 0)
  assert.equal(Math.round(extendLine(0, 50, 100, 50, R, 'line').x1), 0)
})
t('非有限坐标 → null', () => {
  assert.equal(extendLine(NaN, 0, 10, 10, R, 'line'), null)
  assert.equal(extendLine(0, 0, Infinity, 10, R, 'line'), null)
})

console.log('\n幽灵提示：按下前就能看出"会吸附到哪、松手得到什么"')
t('水平线：给出整条淡色预览线（价格已吸附）', () => {
  const g = ghostFromPoint('hline', { date: '2026-09-28', price: 1228.1 })
  assert.equal(g.type, 'hline')
  assert.equal(g.price, 1228.1)
  assert.equal(g.ghost, true)
})
t('趋势线/圆/标记：第一个点只标出吸附位置', () => {
  for (const tool of ['trend', 'circle', 'marker']) {
    const g = ghostFromPoint(tool, { date: '2026-09-28', price: 1228.1 })
    assert.equal(g.type, 'marker', tool + ' 的第一个点应只显示吸附点')
    assert.equal(g.ghost, true)
  }
})
t('没有工具 / 锚点无效 → 不产生幽灵', () => {
  assert.equal(ghostFromPoint(null, { date: 'x', price: 1 }), null)
  assert.equal(ghostFromPoint('hline', { date: null, price: 1 }), null)
  assert.equal(ghostFromPoint('hline', { date: '2026-01-01', price: NaN }), null)
})

console.log('\n撤销：不必"选中→删除选中"')
t('Ctrl+Z 触发撤销（键位最顺手）', () => {
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes('ctrlKey'), '应支持 Ctrl')
  assert.ok(fn.includes('metaKey'), '应支持 Cmd（Mac）')
  assert.ok(fn.includes("'z'"), '快捷键应为 z')
  assert.ok(fn.includes('onUndo()'), '应调用撤销')
})
t('提供「撤销」按钮（不只是快捷键）', () => {
  assert.ok(code.includes("}, '撤销')"), '应有撤销按钮')
})
t('撤销栈记录三类操作，且各自能反向恢复', () => {
  const fn = fnBody('Panel')
  for (const kind of ["kind: 'create'", "kind: 'delete'", "kind: 'memo'"]) {
    assert.ok(fn.includes(kind), '应记录 ' + kind)
  }
  // create 的反向是删除；delete/memo 的反向是重新写入（带原字段）
  const idx = code.indexOf('const undoDrawing = async')
  const block = code.slice(idx, idx + 1900)
  assert.ok(block.includes("'/drawings/remove'"), '撤销"新建"要删除')
  assert.ok(block.includes("'/drawings/add'"), '撤销"删除/改说明"要写回')
  assert.ok(block.includes('...entry.drawing'), '写回要用原来那份（不能丢字段）')
})
t('撤销栈有上限（不会无限增长）', () => {
  assert.ok(code.includes('s.slice(-29)'), '应保留最近若干步')
})
t('撤销从当前 state 读栈顶（不在 setState updater 里做副作用）', () => {
  // updater 何时执行由 React 决定；把副作用写进去会导致"栈非空却说没有可撤销"
  const idx = code.indexOf('const undoDrawing = async')
  const block = code.slice(idx, idx + 400)
  assert.ok(block.includes('undoStack[undoStack.length - 1]'), '应从当前 state 读栈顶')
  assert.ok(!/setUndoStack\(\(s\) => \{[\s\S]*?entry =/.test(block), '不该在 updater 里赋值 entry')
})
t('换标的时清空撤销栈（跨标的撤销会张冠李戴）', () => {
  const idx = code.indexOf("apiFetch('/drawings'")
  const block = code.slice(idx - 400, idx + 60)
  assert.ok(block.includes('setUndoStack([])'), '应清空撤销栈')
})
t('空栈时撤销给出提示而不是静默无反应', () => {
  assert.ok(code.includes('没有可撤销的操作'))
})

console.log('\n拖动预览必须跟随（真实 bug：hline 草稿缺 price → yP(undefined)=NaN）')
t('水平线草稿带 price（只给 points 会画不出来）', () => {
  const p = { i: 10, price: 1228.1, date: '2026-09-28' }
  const d = draftFromPoint('hline', [p])
  assert.equal(d.price, 1228.1, '必须同时带 price：图表画 hline 用的是 s.price')
  assert.equal(d.preview, true)
})
t('趋势线/圆/标记的草稿不需要 price（用 points）', () => {
  for (const type of ['trend', 'circle', 'marker']) {
    const d = draftFromPoint(type, [{ i: 1, price: 100, date: '2026-01-05' }])
    assert.equal(d.type, type)
    assert.equal(d.preview, true)
  }
})
t('图表画水平线时兼容 price 与 points[0].price 两种形状', () => {
  // ⚠️ 两个坑都踩过：
  //   1) 不能用 code.indexOf("if (s.type === 'hline')")——hitTestDrawings 里也有一处同名分支
  //   2) 也不能靠"从某锚点取 N 个字符"——分支长度会变（anchorDots 加长后就切不到了）
  // 所以在**函数体内**搜，长度无关。
  const fn = fnBody('KLineChart')
  assert.ok(fn.includes('Number.isFinite(s.price) ? s.price'), '应优先用 price')
  assert.ok(fn.includes('s.points[0].price'), '草稿只有 points 时要能回退')
  assert.ok(fn.includes('if (!Number.isFinite(price)) continue'), '价格无效就不画（不画 NaN 线）')
})
t('拖动时不再叠加旧的幽灵线', () => {
  const fn = fnBody('ChartStage')     // 同样不能在全局找 onPointerDown（输入框拖拽里也有）
  assert.ok(fn.includes('onHoverSnap(null)'), '进入拖动应清掉幽灵提示')
})

console.log('\n焦点与快捷键（真实 bug：preventDefault 阻止了容器获得焦点）')
t('画线模式按下时显式聚焦容器（否则 Ctrl+Z/Delete 收不到）', () => {
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes('ref.current?.focus?.()'), 'preventDefault 会阻止默认聚焦，必须显式聚焦')
  assert.ok(fn.indexOf('focus') > fn.indexOf('e.preventDefault()'), '聚焦要在 preventDefault 之后')
})

console.log('\n线宽与颜色')
t('线宽再收细一档（0.8 / 1.2 / 1.5）', () => {
  const idx = code.indexOf('const width = s.selected')
  const line = code.slice(idx, idx + 120)
  assert.match(line, /selected \? 1\.5/)
  assert.match(line, /preview \? 1\.2/)
  assert.match(line, /: 0\.8/)
})
t('提供六种颜色，且都走主题 token（没有硬编码色值）', () => {
  assert.deepEqual(DRAW_COLORS.map((c) => c.k), ['black', 'red', 'green', 'blue', 'orange', 'purple'])
  for (const c of DRAW_COLORS) {
    const css = drawingColorCss(c.k)
    assert.ok(css, `${c.k} 没有映射`)
    assert.ok(/var\(--dsw-/.test(css), `${c.k} 应映射到主题 token：${css}`)
  }
})
t('紫色由两个 token 派生（主题没有紫色 token，也不硬编码）', () => {
  const purple = drawingColorCss('purple')
  assert.ok(purple.includes('color-mix'), '应用 color-mix 派生：' + purple)
  assert.ok(!/#[0-9a-f]{6}/i.test(purple), '不该出现硬编码色值')
})
t('未知色名回落到默认色', () => {
  assert.equal(drawingColorCss('nope'), null)
})
t('颜色调色板贴着图形显示（不在图表下方）', () => {
  // 用户反馈：颜色应该在各种线或形状附近，而不是 K 线图下方
  const fn = fnBody('KLineChart')
  assert.ok(fn.includes('paletteMarks'), '图表里应绘制浮动调色板')
  assert.ok(fn.includes('colorPalette'), '应接收调色板参数')
  assert.ok(fn.includes('DRAW_COLORS.forEach'), '应渲染六个色块')
  // 下方编辑区不该再有颜色块
  const editIdx = code.indexOf("className: 'sl-draw-edit'")
  const editBlock = code.slice(editIdx, editIdx + 1800)
  assert.ok(!editBlock.includes('DRAW_COLORS.map'), '编辑区不该再堆颜色块')
  assert.ok(editBlock.includes('保存说明'), '标签/理由输入仍应保留（文本输入放不进 SVG）')
})
t('浮动调色板位置由纯函数算，并夹进画布内', () => {
  const scale = { minP: 100, maxP: 120, span: 20 }
  const geo = { plotW: 836, n: 60 }
  const at = paletteAnchor({ type: 'hline', price: 110 }, geo, scale)
  assert.ok(Number.isFinite(at.x) && Number.isFinite(at.y))
  assert.ok(at.y < CHART_GEO.PAD_T + CHART_GEO.PRICE_H, '应落在画布内')
  // 极端位置要夹回来
  const top = paletteAnchor({ type: 'hline', price: 120 }, geo, scale)
  assert.ok(top.y >= CHART_GEO.PAD_T + 2, '太靠上要夹回画布内：' + top.y)
  const left = paletteAnchor({ type: 'trend', points: [{ i: 0, price: 100 }, { i: 1, price: 101 }] }, geo, scale)
  assert.ok(left.x >= CHART_GEO.PAD_L + 2, '太靠左要夹回：' + left.x)
  assert.equal(paletteAnchor(null, geo, scale), null)
})
t('点色块后立刻保存该色（走同一条保存路径）', () => {
  const idx = code.indexOf('const colorPalette = palAnchor')
  const block = code.slice(idx, idx + 500)
  assert.ok(block.includes('saveDrawingMemo(selectedDrawingId, drawingEdit.label, drawingEdit.reason, drawingExt, key)'),
    '选色应立刻保存')
})

console.log('\n趋势线：默认射线 + 画完可改')
t('默认延伸方式是射线（不是线段）', () => {
  assert.ok(code.includes("body.ext = drawingExt || 'ray'"), '新建时应默认射线')
  assert.ok(code.includes("ext: type === 'trend' ? 'ray' : null"), '草稿也按射线')
})
t('画完后选中即可改 线段/射线/直线，且立即生效', () => {
  const fn = fnBody('Panel')
  assert.ok(fn.includes('LINE_EXTS.map'), '应有延伸方式按钮')
  assert.ok(fn.includes('saveDrawingMemo(selectedDrawingId, drawingEdit.label, drawingEdit.reason, x.k)'),
    '切换后应立即保存')
  for (const k of ['segment', 'ray', 'line']) assert.ok(code.includes(`k: '${k}'`), '缺少 ' + k)
})

console.log('\n圆：圆心 + 半径（不再用包围框）')
t('圆的半径取"价格差"（不是连线长度）', () => {
  const fn = fnBody('KLineChart')
  assert.ok(fn.includes('Math.abs(yP(edge.price) - cy)'), '半径应是两点的价格差（映射成像素）')
  assert.ok(!fn.includes('Math.hypot(xC(edge.i) - cx'), '不该再用斜距')
  assert.ok(fn.includes('±'), '应把价格差标出来')
})
t('工具提示说明"先点圆心、再拖半径"', () => {
  const tip = DRAW_TOOLS.find((t) => t.k === 'circle').tip
  assert.ok(tip.includes('圆心'), '应说明先点圆心：' + tip)
})

console.log('\n吸附：四个价位都要能吸上')
const SB4 = [{ time: '2026-01-05', open: 102, high: 110, low: 98, close: 105 }]
t('开/高/低/收 四个价位都能吸附（曾漏掉 open，表现为"一根只能吸 3 个"）', () => {
  const near = (p) => snapAnchor(SB4, 0, p).price
  assert.equal(near(102.4), 102, '吸到 open')
  assert.equal(near(109.6), 110, '吸到 high')
  assert.equal(near(98.3), 98, '吸到 low')
  assert.equal(near(104.7), 105, '吸到 close')
})
t('吸附会报出吸到了哪个价位（kind）', () => {
  assert.equal(snapAnchor(SB4, 0, 102.1).kind, 'open')
  assert.equal(snapAnchor(SB4, 0, 109.9).kind, 'high')
})
t('关掉吸附时只对齐时间轴，价格保持原值', () => {
  const r = snapAnchor(SB4, 0.2, 103.37, false)
  assert.equal(r.i, 0, '仍对齐到那根 K 线')
  assert.equal(r.price, 103.37, '价格用鼠标位置')
  assert.equal(r.snapped, false)
  assert.equal(r.date, '2026-01-05', '日期仍要能取到（锚点必须带日期）')
})
t('缺 open 数据时不崩（只吸其它三个）', () => {
  const noOpen = [{ time: '2026-01-05', high: 110, low: 98, close: 105 }]
  assert.equal(snapAnchor(noOpen, 0, 98.2).price, 98)
  assert.equal(snapAnchor(noOpen, 0, 105.1).price, 105)
})

console.log('\n渲染字段必须全部透传（一个根因造成三个症状）')
t('resolveDrawings 透传 color / ext / label / reason', () => {
  /*
   * 真实 bug：resolveDrawings 构造"可绘制形状"时只带了 label/reason，
   * **丢掉了 color 与 ext**。存库完全正确，但渲染前被丢，于是表现为三个症状：
   *   · 改颜色不变色（永远用默认色）
   *   · 趋势线预览是射线、画出来却是线段（ext 被丢 → 回落到 segment）
   *   · 选中后切换延伸方式"没反应"（存进去了，渲染时又丢了）
   */
  const B = [
    { time: '2026-01-05', open: 100, high: 106, low: 98, close: 104 },
    { time: '2026-01-06', open: 104, high: 110, low: 103, close: 109 },
    { time: '2026-01-07', open: 109, high: 112, low: 105, close: 107 },
  ]
  const list = [
    { id: 'h', type: 'hline', adjust: 'qfq', color: 'red', label: '颈线', reason: '跌破则转弱',
      anchors: [{ date: B[1].time, price: 110 }] },
    { id: 't', type: 'trend', adjust: 'qfq', color: 'purple', ext: 'ray', label: '趋势',
      anchors: [{ date: B[0].time, price: 100 }, { date: B[2].time, price: 107 }] },
    { id: 'c', type: 'circle', adjust: 'qfq', color: 'blue',
      anchors: [{ date: B[0].time, price: 100 }, { date: B[1].time, price: 106 }] },
  ]
  const { shapes } = resolveDrawings(B, 0, list, 'qfq')
  const byId = Object.fromEntries(shapes.map((s) => [s.id, s]))
  assert.equal(byId.h.color, 'red', 'hline 的颜色必须透传')
  assert.equal(byId.t.color, 'purple', 'trend 的颜色必须透传')
  assert.equal(byId.t.ext, 'ray', '**趋势线的延伸方式必须透传**（否则永远画成线段）')
  assert.equal(byId.c.color, 'blue', 'circle 的颜色必须透传')
  assert.equal(byId.h.label, '颈线')
  assert.equal(byId.h.reason, '跌破则转弱')
})
t('没有颜色时记为 null（渲染时回落到默认色）', () => {
  const B = [{ time: '2026-01-05', open: 100, high: 106, low: 98, close: 104 }]
  const { shapes } = resolveDrawings(B, 0, [{ id: 'h', type: 'hline', adjust: 'qfq', anchors: [{ date: B[0].time, price: 100 }] }], 'qfq')
  assert.equal(shapes[0].color, null)
  assert.equal(shapes[0].ext, null)
})
t('新增渲染字段时要同时加透传（用 carry 集中处理，避免再漏）', () => {
  const fn = fnBody('resolveDrawings')
  assert.ok(fn.includes('const carry = (d) =>'), '应有集中的透传函数')
  assert.ok(fn.includes('...carry(d)'), '两处形状构造都要用 carry')
  const uses = (fn.match(/\.\.\.carry\(d\)/g) || []).length
  assert.equal(uses, 2, 'hline 与其它形状各一处，实际 ' + uses)
})

console.log('\n调色板必须能用（真实 bug：容器抢走了指针，点色块变成了又画一条线）')
t('调色板独占指针事件（pointerdown 与 click 都 stopPropagation）', () => {
  const fn = fnBody('KLineChart')
  assert.ok(fn.includes('const stop = (e) => { e.stopPropagation() }'), '应有统一的停止冒泡')
  assert.ok(fn.includes('onPointerDown: stop'), '背景板要挡住 pointerdown')
  assert.ok(fn.includes('onClick: stop'), '背景板要挡住 click')
  assert.ok(fn.includes('onClick: (e) => { e.stopPropagation(); onPick(c.k) }'),
    '色块点击要停止冒泡后再选色（否则容器会顺手取消选中）')
})
t('容器在调色板区域不画线、不做选中', () => {
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes('insidePalette'), '应有调色板区域判定')
  assert.ok(fn.includes('if (insidePalette(vb0)) return'), '画线模式的 pointerdown 落在调色板上就不开始画')
  assert.ok(fn.includes('if (!vb || insidePalette(vb)) return'), '选择模式的 pointerdown 也要让开')
  assert.ok(fn.includes('if (!a) return'), '按下被拦掉时，松手不该补做点选（否则点色块会顺手取消选中）')
})
t('调色板区域由 Panel 算出并传下去（与绘制的位置是同一个）', () => {
  assert.ok(code.includes('const paletteRect = palAnchor'), '应算出矩形')
  assert.ok(code.includes('w: PALETTE_W, h: 22'), '尺寸要与绘制一致')
  assert.ok(code.includes('paletteRect,'), '应传给 ChartStage')
})
t('调色板贴**鼠标点选的位置**，不是固定在线的最左端', () => {
  // 用户反馈：位置应跟随点选处
  assert.ok(code.includes('setSelPoint'), '应记录点选位置')
  assert.ok(code.includes('selPoint.x + 10'), '锚点应基于点选位置')
  assert.ok(code.includes('selPoint && Number.isFinite(selPoint.x)'), '无点选位置时退回贴图形')
  assert.ok(code.includes('clampPalette'), '位置要夹进画布（免得点不到）')
})
t('命中后把点击位置一起上报（调色板贴到点选处）', () => {
  const panel = fnBody('Panel')
  assert.ok(panel.includes("applySelect(hit, vb)"), '点击选中要带上坐标')
  assert.ok(panel.includes('setSelPoint(point || null)'), '应记下点选位置')
})

console.log('\n框选：选择模式=多选删除；不选工具=框选放大')
t('框选矩形用包围盒相交判定（宁可多选也别漏）', () => {
  const scale = { minP: 100, maxP: 120, span: 20 }
  const geo = { padL: 8, padT: 10, plotW: 836, priceH: 240, n: 60 }
  const inBox = { x0: 8, x1: 400, y0: 10, y1: 250 }
  const shapes = [
    { id: 'm1', type: 'marker', points: [{ i: 5, price: 110 }] },        // 框内
    { id: 'm2', type: 'marker', points: [{ i: 55, price: 105 }] },       // 框外（右侧）
    { id: 'h1', type: 'hline', price: 118 },                             // 水平线横跨画布 → 与框相交
  ]
  const ids = hitTestRect(shapes, inBox, geo, scale)
  assert.ok(ids.includes('m1'), '框内的点应选中')
  assert.ok(!ids.includes('m2'), '框外的点不该选中')
  assert.ok(ids.includes('h1'), '横跨画布的水平线与框相交，应选中')
  assert.deepEqual(hitTestRect([], inBox, geo, scale), [])
  assert.deepEqual(hitTestRect(shapes, { x0: 900, x1: 905, y0: 0, y1: 5 }, geo, scale), [],
    '选在画布外应选不到东西')
})
t('框选放大把横向范围换算成绝对下标（纵向不参与）', () => {
  const fn = fnBody('Panel')
  assert.ok(fn.includes('const xToAbsIndex = (svgX)'), '应有下标换算')
  assert.ok(fn.includes('Math.round(rel) + range.start'), '窗口下标要换回绝对下标（否则缩放会跳错位置）')
  assert.ok(fn.includes('setViewCount(count)'), '应设窗口根数')
  assert.ok(fn.includes('setViewEnd(hi)'), '应设窗口右端')
})
t('四种模式分开：draw / select / zoom / measure', () => {
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes("const mode = tool === 'select' ? 'select'"), '应有模式判定')
  assert.ok(fn.includes("tool === 'measure' ? 'measure'"), '测幅是第四种模式')
  assert.ok(fn.includes('if (!tool) {'), '不选工具时走框选放大')
  assert.ok(fn.includes("if (tool === 'select') {"), '选择模式走框选多选')
  assert.ok(fn.includes("if (tool === 'measure') {"), '测幅模式走两点测量')
})
t('「选择」「测幅」是真正的工具值（不再等同于"没选工具"）', () => {
  assert.ok(code.includes("k: 'select', label: '选择'"), '选择应在 VIEW_TOOLS 里')
  assert.ok(code.includes("k: 'measure', label: '测幅'"), '测幅应在 VIEW_TOOLS 里')
  assert.ok(code.includes('VIEW_TOOLS.map'), '工具条应渲染它们')
  assert.ok(!code.includes("setDrawTool(drawTool === 'select' ? null : 'select')"), '不该再硬编码选择按钮')
})
t('框选矩形画在最上层且不吃指针', () => {
  assert.ok(code.includes("key: 'marquee'"), '应绘制框选矩形')
  assert.ok(code.includes("pointerEvents: 'none'"), '框选矩形本身不能吃指针')
  assert.ok(code.includes('marquee: marqueeRect'), '要传给图表')
})
t('多选状态与批量删除', () => {
  assert.ok(code.includes('setSelectedIds'), '应有多选状态')
  assert.ok(code.includes("Array.isArray(id) ? id : [id]"), '删除应支持数组')
  assert.ok(code.includes('已框选'), '框选后应给出提示')
  assert.ok(code.includes('删除选中的'), '按钮应说明会删几条')
})
t('画完一条线后调色板出现在落笔处', () => {
  assert.ok(code.includes('onCreate(type, anchors, last ? last.vb : null)'), 'finish 要上报落点')
  assert.ok(code.includes('setSelPoint(vb || null)'), '创建后应记下落点')
})

console.log('\n圆与趋势线：拖动画 或 两次点击画')
t('两点型工具支持"点一下定第一点、再点一下定第二点"', () => {
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes('pendingFirst'), '应有"等第二次点击"的状态')
  assert.ok(fn.includes("const isTwoPoint = (t) => t === 'trend' || t === 'circle'"), '趋势线与圆都属于两点型')
  assert.ok(fn.includes('if (draft && isTwoPoint(draft.type) && pendingFirst.current)'),
    '第二下点击应直接把图形定下来')
})
t('位移够大 = 拖动画完；位移很小 = 进入两次点击模式', () => {
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes('const DRAG_MIN'), '应有拖动判定阈值')
  assert.ok(fn.includes('if (moved >= DRAG_MIN && draft.points.length === 2)'), '拖动应直接完成')
  assert.ok(fn.includes('pendingFirst.current = p0'), '只是点一下则应保留第一点')
})
t('这同时解决了"圆画成一个点"：小拖动不再直接落地', () => {
  // 原来松手就落地，位移≈0 时半径≈0 → 看不见的一个点
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes('pendingFirst.current = p0     // 保留第一点，等下一次点击'),
    '小位移应转入两次点击模式，而不是落成一个点')
})

console.log('\n命中测试补齐：圆 / 射线延长部分 / 圆环')
const HG = { padL: 8, padT: 10, plotW: 836, priceH: 240, n: 60 }
const HS = { minP: 100, maxP: 120, span: 20 }
const hx = (i) => 8 + (836 / 60) * (i + 0.5)
const hy = (p) => 10 + (1 - (p - 100) / 20) * 240
t('圆能被选中（此前完全没有圆的命中分支）', () => {
  // 圆心 i=30/price=110，半径点 price=115 → 屏幕上半径 = 5/20*240 = 60
  const s = [{ id: 'c1', type: 'circle', points: [{ i: 30, price: 110 }, { i: 30, price: 115 }] }]
  assert.equal(hitTestDrawings(s, hx(30), hy(110) - 60, 6, HG, HS), 'c1', '点在圆周上应命中')
  assert.equal(hitTestDrawings(s, hx(30), hy(110), 6, HG, HS), 'c1', '点在圆心附近也应命中')
  assert.equal(hitTestDrawings(s, hx(30), hy(110) - 30, 6, HG, HS), null, '圆内部空白处不抢点击')
})
t('射线延长出去的部分也能选中（此前只有线段那一小段可点）', () => {
  const seg = [{ id: 't1', type: 'trend', ext: 'segment', points: [{ i: 0, price: 100 }, { i: 10, price: 110 }] }]
  const ray = [{ id: 't1', type: 'trend', ext: 'ray', points: [{ i: 0, price: 100 }, { i: 10, price: 110 }] }]
  // 沿直线外推，取一个**超出线段末端、但仍落在画布内**的点
  const x1 = hx(0); const y1 = hy(100); const x2 = hx(10); const y2 = hy(110)
  const t = 1.6
  const px = x1 + (x2 - x1) * t
  const py = y1 + (y2 - y1) * t
  // 先确认测试点确实在画布内——否则被裁剪后本就不该命中，断言会变成空转（踩过）
  assert.ok(px > HG.padL && px < HG.padL + HG.plotW, '测试点 x 应在画布内：' + px)
  assert.ok(py > HG.padT && py < HG.padT + HG.priceH, '测试点 y 应在画布内：' + py)
  assert.equal(hitTestDrawings(seg, px, py, 6, HG, HS), null, '线段模式：延长处不该命中')
  assert.equal(hitTestDrawings(ray, px, py, 6, HG, HS), 't1', '射线模式：延长处应能命中')
})
t('直线两端延长处都能选中', () => {
  const line = [{ id: 't2', type: 'trend', ext: 'line', points: [{ i: 20, price: 105 }, { i: 30, price: 110 }] }]
  const x1 = hx(20); const y1 = hy(105); const x2 = hx(30); const y2 = hy(110)
  const at = (x) => y1 + (x - x1) / (x2 - x1) * (y2 - y1)
  for (const x of [200, 500]) {                      // 线段左侧、右侧各取一点
    const y = at(x)
    assert.ok(y > HG.padT && y < HG.padT + HG.priceH, `x=${x} 的测试点应在画布内（y=${y}）`)
    assert.equal(hitTestDrawings(line, x, y, 6, HG, HS), 't2', `x=${x} 处应能命中`)
  }
})

console.log('\n本轮新增：圆的锚点显示 / ESC 退出 / 日期分列 / 钉住K线 / 测幅')
t('圆平时不画半径锚点（会被误认成"自己不小心画的点"）', () => {
  const fn = fnBody('KLineChart')
  assert.ok(fn.includes('s.selected || s.preview'), '只在选中/预览时才画圆心点')
  assert.ok(!fn.includes('anchorDots([edge])'), '半径点不该画出来')
  assert.ok(fn.includes("'±'"), '半径含义（价格差）仍要标出来')
})
t('ESC 退出画图模式 → 进入选择模式', () => {
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes('onExitTool'), 'Esc 应调用退出工具')
  assert.ok(fn.includes("if (tool && tool !== 'select') onExitTool()"), '当前是画线/测幅 → 退到选择')
  assert.ok(fn.includes('else onSelectNone()'), '已在选择模式 → 取消选中')
  const panel = fnBody('Panel')
  assert.ok(panel.includes("setDrawTool('select')"), '退出后应进入**选择**模式（不是什么都不选）')
})
t('起止日期分列最左与最右', () => {
  const fn = fnBody('KLineChart')
  assert.ok(fn.includes("textAnchor: 'end'"), '结束日期应右对齐')
  assert.ok(fn.includes('x: PAD_L + plotW'), '结束日期放在右边缘')
  assert.ok(!fn.includes("bars[0]?.time || '') + ' → '"), '不该再把两个日期挤在一起')
})
t('点击某根 K 线钉住它的 OCHLV（再点同一根取消）', () => {
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes("onMarqueeDone(null, 'pickbar', vb)"), '不选工具时点一下 = 钉住那根 K 线')
  const panel = fnBody('Panel')
  assert.ok(panel.includes("kind === 'pickbar'"), '应处理 pickbar')
  assert.ok(panel.includes('prev === abs ? null : abs'), '点同一根应取消钉住')
  assert.ok(panel.includes('const shown = (pinnedIdx !== null ? bars[pinnedIdx] : null)'), '读数应优先用钉住的那根')
  assert.ok(panel.includes('pinnedIdx !== null ? \'📌 \''), '要有可见标记')
  assert.ok(panel.includes('pinnedRel'), '图上要标出钉住的位置')
  assert.ok(code.includes('strokeDasharray: \'3 3\''), '钉住位置用虚线竖线')
})
t('读数里带涨跌幅（相对前一根）', () => {
  const panel = fnBody('Panel')
  assert.ok(panel.includes('涨跌 ${pct >= 0'), '应显示涨跌幅')
  assert.ok(panel.includes('const prev = i > 0 ? bars[i - 1] : null'), '相对前一根收盘')
  assert.ok(panel.includes("if (!prev || !prev.close"), '没有前值就不显示（不编数字）')
})
t('测幅：显示涨跌幅 + 价差 + 相隔根数', () => {
  const fn = fnBody('KLineChart')
  assert.ok(fn.includes("s.type === 'measure'"), '应有测幅渲染分支')
  assert.ok(fn.includes("pct.toFixed(2) + '%"), '显示涨跌幅')
  assert.ok(fn.includes('fmt(mb.price - ma.price)'), '显示价差')
  assert.ok(fn.includes("spanBars + ' 根'"), '显示相隔根数（用根数而不是日历天，如实）')
  assert.ok(!fn.includes('const bars = Math.abs'), '别把变量命名成 bars（会遮蔽 K 线数组）')
})
t('测幅不落库（只是临时显示）', () => {
  assert.ok(code.includes("id: '__measure'"), '测幅是一条临时图形')
  assert.ok(!code.includes("type: 'measure', adjust"), '不该把测幅写进库')
  const fn = fnBody('ChartStage')
  assert.ok(fn.includes('onMeasure({'), '测幅走独立回调')
})
t('测幅按**日期**存、按日期解析（存下标会在缩放后漂到别的 K 线上）', () => {
  const B = [
    { time: '2026-01-05', open: 100, high: 106, low: 98, close: 104 },
    { time: '2026-01-06', open: 104, high: 110, low: 103, close: 109 },
    { time: '2026-01-07', open: 109, high: 112, low: 105, close: 107 },
    { time: '2026-01-08', open: 107, high: 108, low: 100, close: 101 },
  ]
  const m = { a: { date: '2026-01-05', price: 100 }, b: { date: '2026-01-07', price: 107 } }
  // 同一个测幅，在**不同窗口**下解析出的相对下标应当跟着窗口变，但指向的日期不变
  const w0 = resolveMeasure(m, B, 0)
  assert.equal(w0.a.i, 0); assert.equal(w0.b.i, 2)
  const w1 = resolveMeasure(m, B, 2)
  assert.equal(w1.a.i, -2, '窗口右移后同一天的相对下标应随之改变')
  assert.equal(w1.b.i, 0)
  assert.equal(w1.a.date, '2026-01-05', '日期不变 → 位置就不会漂')
  assert.equal(w1.b.date, '2026-01-07')
})
t('测幅日期不在当前数据里就不画（不硬掰到别的日子）', () => {
  const B = [{ time: '2026-01-05', open: 100, high: 106, low: 98, close: 104 }]
  assert.equal(resolveMeasure({ a: { date: '2020-01-01', price: 1 }, b: { date: '2026-01-05', price: 2 } }, B, 0), null)
  assert.equal(resolveMeasure(null, B, 0), null)
  assert.equal(resolveMeasure({ a: { date: '2026-01-05', price: NaN }, b: { date: '2026-01-05', price: 1 } }, B, 0), null)
})
t('测幅只存日期+价格（不存下标、不存窗口相关的东西）', () => {
  const panel = fnBody('Panel')
  assert.ok(panel.includes('const norm = (p) =>'), '应归一化测幅点')
  assert.ok(panel.includes('{ date: p.date, price: p.price }'), '只保留日期与价格')
  assert.ok(panel.includes('resolveMeasure(measure, bars, range.start)'), '按窗口解析')
})
t('测幅不该常驻在图上：离开测幅工具就清掉', () => {
  const panel = fnBody('Panel')
  assert.ok(panel.includes('const pickTool = (k, tip) =>'), '应有统一的工具切换')
  assert.ok(panel.includes("if (next !== 'measure') setMeasure(null)"), '离开测幅要清掉结果')
  assert.ok(panel.includes('onClick: () => pickTool(t.k, t.tip)'), '按钮应走统一切换')
})
t('测幅与画图工具分组显示（不是一类东西）', () => {
  const toolbar = code.slice(code.indexOf("className: 'sl-tool-palette'"), code.indexOf("}, '撤销')"))
  const groups = (toolbar.match(/sl-tool-palette/g) || []).length
  assert.ok(groups >= 2, '工具条应至少分成两组（画图 / 选择+测幅），实际 ' + groups)
  assert.ok(code.includes("k: 'measure', label: '测幅'"), '测幅在 VIEW_TOOLS 里')
  assert.ok(!code.includes("k: 'measure', label: '测幅', tip: '测幅：在图上拖出两个点'.replace"), '不该混进 DRAW_TOOLS')
  // DRAW_TOOLS 应只有四种落库图形
  const dt = code.slice(code.indexOf('const DRAW_TOOLS = ['), code.indexOf('const VIEW_TOOLS'))
  assert.equal((dt.match(/\{ k: '/g) || []).length, 4, 'DRAW_TOOLS 应只有四种')
})

console.log('\n显示名（用户看到的名字）')
t('侧栏显示名是「看盘助手」，且不再叫「股票研究」', () => {
  // 用户反馈：原来的名字"听起来好大"
  assert.ok(code.includes("label: '看盘助手'"), '侧栏标签应为「看盘助手」')
  assert.ok(!code.includes("label: '股票研究'"), '不该再叫「股票研究」')
})
t('只改显示名，内部标识保持不变（动了会波及数据与状态）', () => {
  // 路由前缀、localStorage 键、数据目录、slot key 都依赖这些标识
  assert.ok(code.includes("const API = '/stock-lab'"), '路由前缀不该变')
  assert.ok(code.includes("'stock-lab:watchlist'"), 'localStorage 键不该变')
  assert.ok(code.includes("key: 'stock-lab'"), 'slot key 不该变')
  assert.ok(code.includes("id: 'stock-lab'"), 'slot id 不该变')
})

console.log('\nCSS 注入必须在 HMR 后仍然生效（真实故障的行为测试）')
/*
 * 真实故障：apply() 原本写成「head 里没有 sl-styles 才注入」。
 * 客户端 bundle 是热更新的——旧 bundle 已经插过 <style id="sl-styles">，
 * 新 bundle 再 apply 时因"已存在"而跳过，新增的 CSS 永远不生效。
 * 症状：新加的拖拽分隔条完全没样式 → 0 尺寸 → 用户看不见也拖不动
 * （"右栏在，但不能调宽度"），而硬刷新会掩盖它。
 *
 * 因此这里不改静态断言，而是**跑一遍真实行为**：造一个「已经存在样式元素」
 * 的 document，调用 apply()，断言样式内容被覆盖。
 */
function loadBundleWithDocument(doc, ls) {
  let l = null
  const win = { __ModuleLoader__: { load: (def) => { l = def } } }
  const run = new Function('window', 'document', 'fetch', 'localStorage', 'console', code)
  run(win, doc, async () => ({ json: async () => ({ ok: true, data: {} }) }), ls || fakeLS, console)
  return l.factory(requireStub)
}

t('已存在样式元素时，第二次 apply 仍会覆盖 CSS 内容', () => {
  const styleEl = { id: 'sl-styles', textContent: '/* 旧 CSS */' }
  const appended = []
  const doc = {
    head: { appendChild: (el) => appended.push(el) },
    getElementById: (id) => (id === 'sl-styles' ? styleEl : null),
    createElement: () => ({ id: '', textContent: '' }),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const m = loadBundleWithDocument(doc)
  const registered = []
  m.apply({ slots: { inject: (n, cb) => cb(), register: (meta) => { registered.push(meta); return {} } } })

  assert.ok(styleEl.textContent.includes('.sl-split'), 'CSS 未被覆盖 —— HMR 后样式会失效')
  assert.notEqual(styleEl.textContent, '/* 旧 CSS */')
  assert.equal(appended.length, 0, '元素已存在时不该再 append 一个')
})
t('首次 apply（无样式元素）会创建并写入', () => {
  const appended = []
  const doc = {
    head: { appendChild: (el) => appended.push(el) },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const m = loadBundleWithDocument(doc)
  m.apply({ slots: { inject: (n, cb) => cb(), register: () => ({}) } })
  assert.equal(appended.length, 1, '应创建 style 元素')
  assert.ok(appended[0].textContent.includes('.sl-split'))
  assert.equal(appended[0].id, 'sl-styles')
})
t('CSS 里确实定义了三栏布局与拖拽手柄的样式', () => {
  const styl = mod.__test.CSS
  for (const sel of ['.sl-body', '.sl-side', '.sl-main', '.sl-split', '.sl-right', '.sl-rail', '.sl-dragging']) {
    assert.ok(styl.includes(sel), 'CSS 缺少 ' + sel)
  }
  // 手柄必须有非零宽度与 col-resize 光标，否则拖不动/看不见
  const splitRule = styl.match(/\.sl-split\{[^}]*\}/)
  assert.ok(splitRule, '缺少 .sl-split 规则')
  assert.match(splitRule[0], /width:\s*\d+px/, '手柄宽度必须大于 0')
  assert.match(splitRule[0], /cursor:\s*col-resize/, '手柄需要 col-resize 光标')
  assert.match(splitRule[0], /touch-action:\s*none/, '触摸设备需要 touch-action:none')
})

console.log('\n右栏窄窗口自动收起（纯函数）')
const { shouldAutoCollapse } = mod.__test

t('容器较窄且用户从未调整 → 自动收起', () => {
  assert.equal(shouldAutoCollapse(600, {}), true)
  assert.equal(shouldAutoCollapse(879, { width: 380 }), true)
})
t('容器够宽 → 不收起', () => {
  assert.equal(shouldAutoCollapse(880, {}), false)
  assert.equal(shouldAutoCollapse(1600, {}), false)
})
t('用户调整过 → 永不自动改变（避免"它自己乱动"）', () => {
  assert.equal(shouldAutoCollapse(600, { userAdjusted: true }), false)
})
t('已收起 → 不重复处理', () => {
  assert.equal(shouldAutoCollapse(600, { collapsed: true }), false)
})
t('容器宽度未知 → 不收起（首帧测量可能为 0）', () => {
  assert.equal(shouldAutoCollapse(null, {}), false)
  assert.equal(shouldAutoCollapse(0, {}), false)
  assert.equal(shouldAutoCollapse(NaN, {}), false)
})
t('用户操作会标记 userAdjusted（拖拽/收展/复位都算）', () => {
  // 三个操作都必须写这个标记，否则"自动收起"会在用户展开后再次触发
  const commitLine = code.match(/const commit = \(px\) => setStored\(\{[^}]*\}\)/)?.[0] || ''
  const collapseLine = code.match(/const setCollapsed = \(v\) => setStored\(\{[^}]*\}\)/)?.[0] || ''
  const resetLine = code.match(/const reset = \(\) => setStored\(\{[^}]*\}\)/)?.[0] || ''
  for (const [name, line] of [['commit', commitLine], ['setCollapsed', collapseLine], ['reset', resetLine]]) {
    assert.ok(line.includes('userAdjusted: true'), name + ' 未标记 userAdjusted：' + line)
  }
})

console.log(`\n${passed} passed`)
