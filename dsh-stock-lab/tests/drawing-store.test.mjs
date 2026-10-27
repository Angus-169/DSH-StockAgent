/**
 * drawing-store.test.mjs — 画线持久化测试（临时目录，纯离线）
 * 运行：node tests/drawing-store.test.mjs
 *
 * 重点不是 CRUD 能不能跑，而是**三条容易静默出错的约定**：
 *   1. 锚点必须「日期 + 价格」（不是序号），且格式不合法要**报错**而不是默默修正
 *   2. 每条线必须记录**复权模式**（前复权基准会随除权平移，不记就会错位）
 *   3. 文件损坏 / 条目不合法要**如实报告**，不能当成"没有画线"
 */
import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'

const TEST_HOME = join(process.cwd(), '.test-data', 'draw-' + randomUUID().slice(0, 8))
// **两个都设**：DSH_STOCK_LAB_HOME 用于其它 store，DSH_STOCK_LAB_DATA 显式钉住数据根。
// 曾经只设 HOME，而 data-root 在临时目录还没有 meta.db/bars 时会回退到**包内 data**，
// 于是测试把画线写进了插件的真实数据目录（已修 data-root，这里也钉住以防回归）。
process.env.DSH_STOCK_LAB_HOME = TEST_HOME
process.env.DSH_STOCK_LAB_DATA = join(TEST_HOME, 'data')
mkdirSync(TEST_HOME, { recursive: true })

const { DrawingStore, normalizeDrawing, DRAWING_TYPES, ANCHORS_REQUIRED } =
  await import('../src/services/drawing-service/drawing-store.js')

let passed = 0
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

const H = (price, date = '2026-04-27') => ({ type: 'hline', anchors: [{ date, price }], adjust: 'qfq', label: '颈线' })

console.log('规范化：不合法就报错，不静默修正')
await t('hline 需要 1 个锚点', () => {
  assert.equal(ANCHORS_REQUIRED.hline, 1)
  const r = normalizeDrawing({ type: 'hline', anchors: [H(1335).anchors[0]], adjust: 'qfq' })
  assert.equal(r.ok, true)
  assert.equal(r.drawing.type, 'hline')
  assert.equal(r.drawing.anchors[0].price, 1335)
})
await t('trend 需要 2 个锚点（给 1 个要报错）', () => {
  const r = normalizeDrawing({ type: 'trend', anchors: [{ date: '2026-01-05', price: 100 }], adjust: 'qfq' })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('；'), /需要 2 个锚点/)
})
await t('未知类型报错', () => {
  const r = normalizeDrawing({ type: 'triangle', anchors: [H(1).anchors[0]], adjust: 'qfq' })
  assert.equal(r.ok, false)
  assert.match(r.errors.join('；'), /type 必须是/)
})
await t('日期格式不合法报错（不猜、不补）', () => {
  for (const bad of ['2026/04/27', '20260427', '', '2026-4-7']) {
    const r = normalizeDrawing({ type: 'hline', anchors: [{ date: bad, price: 10 }], adjust: 'qfq' })
    assert.equal(r.ok, false, `应拒绝 ${bad}`)
    assert.match(r.errors.join('；'), /date 应为 YYYY-MM-DD/)
  }
})
await t('价格必须是有效数字：null / 空串 / 布尔都要拒绝', () => {
  // 曾经的实现用 Number(a.price)：Number(null)=0、Number('')=0，
  // 会把"没填价格"静默变成「锚点在 0 元」——图上画出一条贴底的线，还看不出错。
  for (const bad of [null, undefined, '', '   ', true, false, '1335元', NaN, Infinity]) {
    const r = normalizeDrawing({ type: 'hline', anchors: [{ date: '2026-04-27', price: bad }], adjust: 'qfq' })
    assert.equal(r.ok, false, `应拒绝 price=${JSON.stringify(bad)}`)
  }
})
await t('纯数字字符串可以接受（模型有时会传字符串）', () => {
  const r = normalizeDrawing({ type: 'hline', anchors: [{ date: '2026-04-27', price: '1335.5' }], adjust: 'qfq' })
  assert.equal(r.ok, true)
  assert.equal(r.drawing.anchors[0].price, 1335.5)
})
await t('复权模式必须是三个之一（关系到会不会错位）', () => {
  for (const bad of [undefined, null, 'qfq2', '前复权']) {
    const r = normalizeDrawing({ type: 'hline', anchors: [{ date: '2026-04-27', price: 1 }], adjust: bad })
    assert.equal(r.ok, false, `应拒绝 adjust=${String(bad)}`)
    assert.match(r.errors.join('；'), /adjust 必须是/)
  }
})
await t('合法时生成 id 与 createdAt（便于回看是什么时候画的）', () => {
  const r = normalizeDrawing(H(1335))
  assert.ok(r.drawing.id)
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(r.drawing.createdAt))
})
await t('label / reason 超长被截断（不无限膨胀文件）', () => {
  const r = normalizeDrawing({ ...H(1), label: 'x'.repeat(200), reason: 'y'.repeat(900) })
  assert.equal(r.drawing.label.length, 80)
  assert.equal(r.drawing.reason.length, 500)
})
await t('允许的四种类型（ellipse 已被"圆心+半径"的 circle 取代）', () => {
  assert.deepEqual([...DRAWING_TYPES].sort(), ['circle', 'hline', 'marker', 'trend'])
})
await t('圆需要 2 个锚点（圆心 + 圆上一点）', () => {
  assert.equal(ANCHORS_REQUIRED.circle, 2)
  const one = normalizeDrawing({ type: 'circle', anchors: [{ date: '2026-01-05', price: 100 }], adjust: 'qfq' })
  assert.equal(one.ok, false, '只给一个锚点应报错')
  const two = normalizeDrawing({
    type: 'circle', adjust: 'qfq',
    anchors: [{ date: '2026-01-05', price: 100 }, { date: '2026-02-05', price: 120 }],
  })
  assert.equal(two.ok, true)
  assert.equal(two.drawing.anchors.length, 2)
})
await t('趋势线延伸方式：默认射线，三种合法值都接受', () => {
  const mk = (ext) => normalizeDrawing({
    type: 'trend', adjust: 'qfq', ext,
    anchors: [{ date: '2026-01-05', price: 100 }, { date: '2026-02-05', price: 120 }],
  })
  assert.equal(mk(undefined).drawing.ext, 'ray', '不传默认**射线**（用户指定）')
  assert.equal(mk(null).drawing.ext, 'ray')
  for (const ok of ['segment', 'ray', 'line']) assert.equal(mk(ok).drawing.ext, ok)
})
await t('趋势线延伸方式非法要报错（不静默当成默认值）', () => {
  for (const bad of ['ray2', '无限', 'LINE']) {
    const r = normalizeDrawing({
      type: 'trend', adjust: 'qfq', ext: bad,
      anchors: [{ date: '2026-01-05', price: 100 }, { date: '2026-02-05', price: 120 }],
    })
    assert.equal(r.ok, false, `应拒绝 ext=${bad}`)
    assert.match(r.errors.join('；'), /ext 必须是/)
  }
})
await t('非趋势线的 ext 记为 null（不引入无意义字段）', () => {
  assert.equal(normalizeDrawing(H(1335)).drawing.ext, null)
  assert.equal(normalizeDrawing({
    type: 'circle', adjust: 'qfq',
    anchors: [{ date: '2026-01-05', price: 100 }, { date: '2026-02-05', price: 120 }],
  }).drawing.ext, null)
})
await t('颜色存色名而不是色值（明暗主题下都要看得清）', () => {
  const r = normalizeDrawing({ ...H(1335), color: 'red' })
  assert.equal(r.ok, true)
  assert.equal(r.drawing.color, 'red')
  assert.equal(normalizeDrawing(H(1335)).drawing.color, null, '不传则用默认色')
})
await t('非法色名要报错，并说明是"存色名并非色值"', () => {
  for (const bad of ['#ff0000', 'rgb(1,2,3)', 'pink']) {
    const r = normalizeDrawing({ ...H(1335), color: bad })
    assert.equal(r.ok, false, `应拒绝 color=${bad}`)
    assert.match(r.errors.join('；'), /color 必须是/)
    assert.match(r.errors.join('；'), /存色名而非色值/)
  }
})

console.log('\n读写：按标的落文件')
const store = new DrawingStore()
await t('没有画线时返回空数组而不是报错', () => {
  const r = store.list('600519')
  assert.equal(r.symbol, 'SH600519')
  assert.deepEqual(r.drawings, [])
  assert.deepEqual(r.warnings, [])
})
await t('写入后用不同写法都能读到（600519 / sh600519）', () => {
  const res = store.add('600519', H(1335))
  assert.equal(res.ok, true, JSON.stringify(res))
  for (const s of ['600519', 'SH600519', 'sh600519']) {
    assert.equal(store.list(s).drawings.length, 1, s)
  }
})
await t('锚点原样保留（日期 + 价格 + 复权模式）', () => {
  const d = store.list('600519').drawings[0]
  assert.equal(d.anchors[0].date, '2026-04-27')
  assert.equal(d.anchors[0].price, 1335)
  assert.equal(d.adjust, 'qfq')
})
await t('追加第二条（id 不同则两条都在）', () => {
  store.add('600519', { type: 'trend', adjust: 'qfq', label: '上升趋势', anchors: [
    { date: '2026-01-05', price: 1200 }, { date: '2026-06-01', price: 1400 }] })
  assert.equal(store.list('600519').drawings.length, 2)
})
await t('同 id 追加 = 替换，不会重复', () => {
  const first = store.list('600519').drawings[0]
  store.add('600519', { ...H(1400), id: first.id })
  const list = store.list('600519').drawings
  assert.equal(list.length, 2, '不该变成 3 条')
  assert.equal(list.find((d) => d.id === first.id).anchors[0].price, 1400)
})
await t('不同标的互不影响', () => {
  store.add('300750', H(200))
  assert.equal(store.list('600519').drawings.length, 2)
  assert.equal(store.list('300750').drawings.length, 1)
})
await t('删除：找不到时如实返回 false 与原因', () => {
  const r = store.remove('600519', 'nope')
  assert.equal(r.ok, false)
  assert.match(r.errors.join('；'), /找不到画线/)
})
await t('删除成功', () => {
  const id = store.list('300750').drawings[0].id
  assert.equal(store.remove('300750', id).ok, true)
  assert.equal(store.list('300750').drawings.length, 0)
})
await t('listSymbols / stats', () => {
  assert.ok(store.listSymbols().includes('SH600519'))
  const s = store.stats()
  assert.ok(s.drawings >= 2)
  assert.ok(s.dir.includes('drawings'))
})
await t('重开 store 数据仍在（跨重启）', () => {
  const s2 = new DrawingStore()
  assert.equal(s2.list('600519').drawings.length, 2)
})
await t('替换全部：非法条目整体拒绝（不写入半截）', () => {
  const r = store.replaceAll('600519', [H(1), { type: 'bad-type', anchors: [], adjust: 'qfq' }])
  assert.equal(r.ok, false)
  assert.equal(store.list('600519').drawings.length, 2, '失败时不该改动原文件')
})
await t('清空某标的的画线', () => {
  assert.equal(store.clear('600519').ok, true)
  assert.equal(store.list('600519').drawings.length, 0)
})

console.log('\n文件损坏 / 条目不合法：如实报告，不当成"没有画线"')
await t('JSON 损坏 → 报 warning，而不是静默返回空', () => {
  const dir = join(TEST_HOME, 'data', 'drawings')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SZ000001.json'), '{ this is not json', 'utf8')
  const r = store.list('000001')
  assert.deepEqual(r.drawings, [])
  assert.ok(r.warnings.length > 0, '必须报告文件有问题')
  assert.match(r.warnings.join('；'), /不是合法 JSON/)
})
await t('个别条目不合法 → 跳过它但保留合法条目，并报告', () => {
  const dir = join(TEST_HOME, 'data', 'drawings')
  const payload = {
    version: 1,
    symbol: 'SH601318',
    drawings: [
      { type: 'hline', anchors: [{ date: '2026-04-27', price: 50 }], adjust: 'qfq' },
      { type: 'trend', anchors: [{ date: '2026-04-27', price: 50 }], adjust: 'qfq' },
    ],
  }
  writeFileSync(join(dir, 'SH601318.json'), JSON.stringify(payload), 'utf8')
  const r = store.list('601318')
  assert.equal(r.drawings.length, 1, '合法条目要保留')
  assert.ok(r.warnings.length > 0, '非法条目要报告')
})

try { rmSync(TEST_HOME, { recursive: true, force: true }) } catch { }
console.log(`\n${passed} passed`)