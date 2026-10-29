/**
 * screen-service.test.mjs — 公式选股引擎（T5.7）
 *
 * 覆盖：
 *   1. 本地库标的池选股（命中/未命中/缺数据分别计数）
 *   2. latestOnly（只要最新一根满足）
 *   3. 非条件公式（最后一行不是 0/1）→ 明确失败，不把非零当命中
 *   4. 未来函数 → 默认拒绝
 *   5. 取消（任务能在批次之间停下来）
 *   6. 结果缓存（同公式同数据版本 → cached=true）
 *   7. 全市场池（mock）：只评估本地有数据的，缺数据单独计数
 *   8. 自选股池：按传入 symbols
 *   9. 进度与耗时字段
 *
 * 运行：node tests/screen-service.test.mjs
 */
import { strict as assert } from 'node:assert'
import { cleanupTempDir } from './cleanup.mjs'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(process.cwd(), '.test-data', 'screen-service')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'bars'), { recursive: true })
process.env.DSH_STOCK_LAB_DATA = ROOT
delete process.env.DSH_STOCK_LAB_HOME

const { ScreenService } = await import('../src/services/screen-service/index.js')
const local = await import('../src/datasource/local.js')

let passed = 0
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n    ') : e)); process.exitCode = 1 }
}

// ── 造数据 ────────────────────────────────────────────────
const HEADER = ['time', 'open', 'high', 'low', 'close', 'volume', 'amount', 'adjust', 'source']

/** 生成 N 根单调走势的 K 线；closes 可指定关键点 */
function makeRows(closes, start = '2026-01-05') {
  const rows = []
  let d = new Date(start + 'T00:00:00Z')
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i]
    rows.push({
      time: d.toISOString().slice(0, 10),
      open: c - 0.5, high: c + 1, low: c - 1, close: c,
      volume: 1000 + i * 10, amount: '', adjust: 'qfq', source: 'test',
    })
    d = new Date(d.getTime() + 86400000)
  }
  return rows
}

function writeBars(symbol, rows) {
  const dir = join(ROOT, 'bars', symbol)
  mkdirSync(dir, { recursive: true })
  const lines = [HEADER.join(',')]
  for (const r of rows) lines.push(HEADER.map((h) => (r[h] === undefined || r[h] === null ? '' : r[h])).join(','))
  writeFileSync(join(dir, '1d_qfq.csv.gz'), zlib.gzipSync(lines.join('\n') + '\n'))
}

/** 建 meta.db（只登记"声明有数据"的标的；文件缺失时会被判为 missing） */
function writeMeta(entries) {
  const db = new DatabaseSync(join(ROOT, 'meta.db'))
  db.exec(`CREATE TABLE IF NOT EXISTS bars_meta (
    symbol TEXT NOT NULL, timeframe TEXT NOT NULL, adjust TEXT NOT NULL, rows INTEGER NOT NULL,
    first_bar TEXT, last_bar TEXT, source TEXT, fetched_at TEXT NOT NULL, backend TEXT NOT NULL,
    PRIMARY KEY (symbol, timeframe, adjust))`)
  const ins = db.prepare(`INSERT OR REPLACE INTO bars_meta
    (symbol,timeframe,adjust,rows,first_bar,last_bar,source,fetched_at,backend)
    VALUES (?,?,?,?,?,?,?,?,?)`)
  for (const e of entries) {
    ins.run(e.symbol, '1d', 'qfq', e.rows, e.first || '2026-01-05', e.last || '2026-06-30', 'test', new Date().toISOString(), 'csv.gz')
  }
  db.close()
}

// 数据设计：
//   SH600000 —— 收盘价一路上涨（CLOSE>MA5 恒成立）
//   SH600001 —— 一路下跌（CLOSE>MA5 恒不成立）
//   SH600002 —— meta 里登记，但**文件缺失** → missing
//   SH600003 —— 最后 3 根突然拉升（latestOnly 用）
const up = Array.from({ length: 60 }, (_, i) => 10 + i * 0.2)
const down = Array.from({ length: 60 }, (_, i) => 30 - i * 0.2)
const jump = [...Array.from({ length: 57 }, (_, i) => 20), 23, 25, 27]
writeBars('SH600000', makeRows(up))
writeBars('SH600001', makeRows(down))
writeBars('SH600003', makeRows(jump))
writeMeta([
  { symbol: 'SH600000', rows: up.length },
  { symbol: 'SH600001', rows: down.length },
  { symbol: 'SH600002', rows: 100 },
  { symbol: 'SH600003', rows: jump.length },
])

const fakeMarket = {
  normalizeSymbol: (s) => {
    const v = String(s || '').toUpperCase().replace(/\s+/g, '')
    if (/^(SH|SZ)\d{6}$/.test(v)) return v
    if (/^\d{6}$/.test(v)) return (v.startsWith('6') ? 'SH' : 'SZ') + v
    return null
  },
  // 选股引擎只经 MarketService 读本地库（架构铁律）；测试里用真 local 实现转接
  listLocalMeta: () => local.listLocalMeta(),
  getLocalKline: (symbol, opts) => local.getLocalKline(symbol, opts),
  localDataVersion: (symbols, tf, adj) => local.localDataVersion(symbols, tf, adj),
  async getStockUniverse() {
    return {
      total: 5, fetched: 5, pages: 1, partial: false, failedPages: 0,
      symbols: [
        { symbol: 'SH600000', code: '600000', name: '浦发银行', market: 'SH' },
        { symbol: 'SH600001', code: '600001', name: '示例一', market: 'SH' },
        { symbol: 'SH600003', code: '600003', name: '示例三', market: 'SH' },
        { symbol: 'SH600002', code: '600002', name: '示例二', market: 'SH' },
        { symbol: 'SH999999', code: '999999', name: '无数据', market: 'SH' },
      ],
      source: 'fake', fetchedAt: new Date().toISOString(),
    }
  },
}

const screen = new ScreenService({ formulas: null, market: fakeMarket, batchSize: 2 })

// ── 1) 本地池 ─────────────────────────────────────────────
console.log('本地库标的池')
await t('命中/未命中/缺数据分别计数', async () => {
  const started = await screen.start({ text: 'XG:CLOSE>MA(CLOSE,5);', universe: 'local' })
  const done = await screen.waitFor(started.id, 20000)
  assert.equal(done.state, 'done')
  assert.equal(done.universe.source, 'local')
  assert.equal(done.progress.total, 4)     // meta 里 4 个
  assert.equal(done.progress.done, 4)
  assert.equal(done.progress.missing, 1)   // SH600002 文件缺失
  // universe 口径必须反映"实际可算"，不能按 meta 登记数（SH600002 登记了但文件没了）
  assert.equal(done.universe.evaluated, 3, '实际可算应为 3（4 个登记 − 1 个文件缺失）')
  assert.equal(done.universe.missingData, 1, '缺数据应为 1')
  assert.match(done.universe.note, /缺数据 1 只未参与计算/)
  const syms = done.results.map((r) => r.symbol).sort()
  assert.deepEqual(syms, ['SH600000', 'SH600003'], '上涨的应命中：' + JSON.stringify(done.results))
  const upHit = done.results.find((r) => r.symbol === 'SH600000')
  assert.ok(upHit.hitCount > 0)
  assert.ok(typeof upHit.close === 'number' && typeof upHit.changePct === 'number')
})

await t('latestOnly：只要最新一根满足', async () => {
  const started = await screen.start({ text: 'XG:CLOSE>MA(CLOSE,5);', universe: 'local', latestOnly: true })
  const done = await screen.waitFor(started.id, 20000)
  assert.equal(done.state, 'done')
  // SH600001 一路下跌：最新一根一定不满足
  assert.ok(!done.results.some((r) => r.symbol === 'SH600001'))
  assert.ok(done.results.every((r) => r.lastHitIndex !== null))
})

// ── 2) 非条件公式 / 未来函数 ───────────────────────────────
console.log('\n拒绝：写错类型的公式')
await t('指标公式（最后一行不是 0/1）→ 明确失败', async () => {
  const started = await screen.start({ text: 'MA5:MA(CLOSE,5);', universe: 'local' })
  const done = await screen.waitFor(started.id, 20000)
  assert.equal(done.state, 'failed')
  assert.match(done.error, /不是 0\/1 条件/)
})

await t('未来函数 → 默认拒绝', async () => {
  const started = await screen.start({ text: 'XG:ZIG(3,5)>REF(ZIG(3,5),1);', universe: 'local' })
  const done = await screen.waitFor(started.id, 20000)
  assert.equal(done.state, 'failed')
  assert.match(done.error, /未来函数/)
})

// ── 3) 缓存 ───────────────────────────────────────────────
console.log('\n缓存')
await t('同公式同数据版本 → 第二次 cached=true', async () => {
  const a = await screen.start({ text: 'XG:CLOSE>MA(CLOSE,10);', universe: 'local' })
  const doneA = await screen.waitFor(a.id, 20000)
  const b = await screen.start({ text: 'XG:CLOSE>MA(CLOSE,10);', universe: 'local' })
  const doneB = await screen.waitFor(b.id, 20000)
  assert.equal(doneA.cached, false)
  assert.equal(doneB.cached, true)
  assert.deepEqual(doneB.results.map((r) => r.symbol), doneA.results.map((r) => r.symbol))
})

// ── 4) 取消 ───────────────────────────────────────────────
console.log('\n取消')
await t('长任务能在批次之间停下', async () => {
  // 200 个标的 × batchSize=2 → 100 批；立刻取消应停在第一/二批
  const many = Array.from({ length: 200 }, (_, i) => `SH9${String(i).padStart(5, '0')}`)
  const started = await screen.start({ text: 'XG:CLOSE>MA(CLOSE,5);', universe: 'watchlist', symbols: many })
  const r = screen.cancel(started.id)
  assert.equal(r.ok, true)
  const done = await screen.waitFor(started.id, 20000)
  assert.ok(['cancelled', 'done'].includes(done.state))
  if (done.state === 'cancelled') {
    assert.ok(done.progress.done < 200)
    // 取消 ≠ 缺数据：没跑到的标的不能算成"缺数据"（否则界面会显示"缺数据 196 只"）
    assert.match(done.universe.note, /未评估/, '取消任务的 note 应说明"未评估"')
    assert.ok(!/缺数据 \d+ 只未参与/.test(done.universe.note), '取消任务不应报"缺数据 N 只"：' + done.universe.note)
    assert.equal(done.universe.evaluated, done.progress.done - done.progress.missing)
  }
})

// ── 5) 全市场池 / 自选池 ───────────────────────────────────
console.log('\n标的池')
await t('全市场池只评估本地有数据的，缺数据单独计数', async () => {
  const started = await screen.start({ text: 'XG:CLOSE>MA(CLOSE,5);', universe: 'market' })
  const done = await screen.waitFor(started.id, 20000)
  assert.equal(done.state, 'done')
  assert.equal(done.universe.total, 5)
  assert.equal(done.universe.evaluated, 3)   // 5 − SH999999(无登记) − SH600002(登记但文件缺失)
  assert.equal(done.universe.missingData, 2)
  assert.match(done.universe.note, /缺数据/)
})

await t('自选池按传入 symbols（支持各种写法）', async () => {
  const started = await screen.start({ text: 'XG:CLOSE>MA(CLOSE,5);', universe: 'watchlist', symbols: ['600000', 'sh600001'] })
  const done = await screen.waitFor(started.id, 20000)
  assert.equal(done.state, 'done')
  assert.equal(done.progress.total, 2)
  assert.deepEqual(done.results.map((r) => r.symbol), ['SH600000'])
})

await t('空标的池 → done 且给出说明', async () => {
  const started = await screen.start({ text: 'XG:CLOSE>MA(CLOSE,5);', universe: 'watchlist', symbols: [] })
  const done = await screen.waitFor(started.id, 20000)
  assert.equal(done.state, 'done')
  assert.equal(done.progress.total, 0)
})

// ── 6) 进度字段 ───────────────────────────────────────────
console.log('\n任务状态')
await t('status 返回进度/耗时/参数', async () => {
  const started = await screen.start({ text: 'XG:CLOSE>MA(CLOSE,5);', universe: 'local' })
  assert.ok(started.id)
  assert.equal(started.params.count, 500)
  assert.equal(started.params.timeframe, '1d')
  const done = await screen.waitFor(started.id, 20000)
  assert.ok(done.elapsedMs >= 0)
  assert.ok(done.finishedAt)
  assert.equal(done.progress.hit, done.results.length)
})

// ── 7) 缓存随数据版本失效（关键回归） ─────────────────────
console.log('\n缓存失效')
await t('改数据文件后 cached=false，且结果反映新数据', async () => {
  // 独立标的：前 59 根上涨、最后一根下跌 → 命中到倒数第二天
  const up = Array.from({ length: 59 }, (_, i) => 10 + i * 0.2)
  writeBars('SH600005', makeRows([...up, up.at(-1) - 8]))
  writeMeta([{ symbol: 'SH600005', rows: 60 }])

  const q = { text: 'XG:CLOSE>MA(CLOSE,5);', universe: 'local' }
  const first = await screen.waitFor((await screen.start({ ...q, useCache: false })).id, 20000)
  const hit1 = first.results.find((r) => r.symbol === 'SH600005')
  assert.ok(hit1, '第一次应命中 SH600005')
  assert.equal(first.cached, false)

  const second = await screen.waitFor((await screen.start(q)).id, 20000)
  assert.equal(second.cached, true, '第二次应命中缓存')

  // 把最后一根改成大涨 → 最近命中日应变成最后一天，且缓存必须失效
  writeBars('SH600005', makeRows([...up, up.at(-1) + 8]))
  const third = await screen.waitFor((await screen.start(q)).id, 20000)
  const hit3 = third.results.find((r) => r.symbol === 'SH600005')
  assert.equal(third.cached, false, '数据变化后必须重新计算（cached=false）')
  assert.ok(hit3, '改数据后仍应命中')
  assert.notEqual(hit3.lastHitDate, hit1.lastHitDate, '最近命中日应随数据变化')
  assert.equal(hit3.lastHitDate, '2026-03-05', '应命中到最后一天，实际 ' + hit3.lastHitDate)
})

cleanupTempDir(ROOT)
console.log(`\n${passed} passed`)
