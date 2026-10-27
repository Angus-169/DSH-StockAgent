/**
 * local-storage.test.mjs — 本地库「Python 写 / Node 读」契约测试
 *
 * 本地库由 Python 写入、由 Node 读取，格式是跨语言契约。
 * 本测试确保：
 *   1. Node 能解析 Python 写出的 csv.gz（列名取值，不依赖列顺序）
 *   2. 读写两方解析出的数据根目录一致
 *   3. 数据版本指纹对内容变化敏感
 *   4. 真正让 Python 写一次、Node 读一次，数值完全对上（Python 不可用时跳过）
 *
 * 运行：node tests/local-storage.test.mjs
 */
import { strict as assert } from 'node:assert'
import { cleanupTempDir } from './cleanup.mjs'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'

const ROOT = join(process.cwd(), '.test-data', 'local-contract')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(join(ROOT, 'bars'), { recursive: true })
process.env.DSH_STOCK_LAB_DATA = ROOT
delete process.env.DSH_STOCK_LAB_HOME
delete process.env.DSH_HOME

const local = await import('../src/datasource/local.js')
const { resolveDataRoot, pkgRoot, backendDir } = await import('../src/data-root.js')

let passed = 0
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

/** 模拟 Python storage.py 的写盘方式（gzip + 同样表头） */
function writeCsvGz(symbol, rows, header = ['time', 'open', 'close', 'high', 'low', 'volume', 'amount', 'adjust', 'source']) {
  const dir = join(ROOT, 'bars', symbol)
  mkdirSync(dir, { recursive: true })
  const lines = [header.join(',')]
  for (const r of rows) lines.push(header.map((h) => (r[h] === undefined || r[h] === null ? '' : r[h])).join(','))
  writeFileSync(join(dir, '1d_qfq.csv.gz'), zlib.gzipSync(lines.join('\n') + '\n'))
}

console.log('数据根目录解析')
await t('显式 DSH_STOCK_LAB_DATA 优先', () => {
  assert.equal(resolveDataRoot(), ROOT)
})
await t('pkgRoot / backendDir 正确', () => {
  assert.ok(existsSync(join(pkgRoot, 'package.json')), 'package.json 不在包根：' + pkgRoot)
  assert.equal(backendDir, join(pkgRoot, 'backend'))
})
await t('DSH_STOCK_LAB_HOME 也被显式尊重（即使目录里还没有数据）', () => {
  // 回归：曾经 DSH_STOCK_LAB_HOME 只算候选、且要等目录里出现 meta.db/bars 才被选中。
  // 于是"刚建好、还没采集"的目录会被跳过，静默回退到**包内 data**——
  // 测试因此把画线写进了插件的真实数据目录。
  // 对一个专门防"写 A 读 B"的模块来说，这条回退本身就是同一类缺陷。
  const savedData = process.env.DSH_STOCK_LAB_DATA
  const savedHome = process.env.DSH_STOCK_LAB_HOME
  try {
    delete process.env.DSH_STOCK_LAB_DATA
    process.env.DSH_STOCK_LAB_HOME = join(ROOT, 'empty-home')
    // 该目录故意不存在，确保"有没有数据"不影响结论
    assert.equal(resolveDataRoot(), join(ROOT, 'empty-home', 'data'))
  } finally {
    if (savedData !== undefined) process.env.DSH_STOCK_LAB_DATA = savedData
    else delete process.env.DSH_STOCK_LAB_DATA
    if (savedHome !== undefined) process.env.DSH_STOCK_LAB_HOME = savedHome
    else delete process.env.DSH_STOCK_LAB_HOME
  }
})

console.log('\n读取 Python 格式的 csv.gz')
const rows = [
  { time: '2026-01-05', open: 100.5, close: 101.25, high: 102, low: 99.5, volume: 1234500, amount: '', adjust: 'qfq', source: 'tencent' },
  { time: '2026-01-06', open: 101.25, close: 103.75, high: 104, low: 101, volume: 2345600, amount: '', adjust: 'qfq', source: 'tencent' },
  { time: '2026-01-07', open: 103.75, close: 102.5, high: 105, low: 102, volume: 1000000, amount: '', adjust: 'qfq', source: 'tencent' },
]
writeCsvGz('SH600000', rows)

await t('hasLocalBars 检出存在', () => {
  assert.equal(local.hasLocalBars('SH600000'), true)
  assert.equal(local.hasLocalBars('SZ999999'), false)
})
await t('读到全部行且数值正确', () => {
  const bars = local.getLocalKline('SH600000')
  assert.equal(bars.length, 3)
  assert.equal(bars[0].time, '2026-01-05')
  assert.equal(bars[0].close, 101.25)
  assert.equal(bars[2].high, 105)
  assert.equal(bars[1].volume, 2345600)
})
await t('空值解析为 null（不是 0、不是 NaN）', () => {
  const bars = local.getLocalKline('SH600000')
  assert.equal(bars[0].amount, null)
})
await t('标记 source=local 且保留上游来源', () => {
  const bars = local.getLocalKline('SH600000')
  assert.equal(bars[0].source, 'local')
  assert.equal(bars[0].localSource, 'tencent')
})
await t('count 取最近 N 根', () => {
  const bars = local.getLocalKline('SH600000', { count: 2 })
  assert.equal(bars.length, 2)
  assert.equal(bars[0].time, '2026-01-06')
})
await t('日期区间过滤', () => {
  const bars = local.getLocalKline('SH600000', { start: '2026-01-06', end: '2026-01-06' })
  assert.equal(bars.length, 1)
  assert.equal(bars[0].time, '2026-01-06')
})
await t('不存在的标的返回 null（而非抛错）', () => {
  assert.equal(local.getLocalKline('SZ999999'), null)
})
await t('损坏文件返回 null 而不是崩溃', () => {
  const dir = join(ROOT, 'bars', 'SH600001')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '1d_qfq.csv.gz'), Buffer.from([1, 2, 3, 4]))
  assert.equal(local.getLocalKline('SH600001'), null)
})

console.log('\n列顺序无关（按列名取值）')
await t('打乱列顺序仍能正确读取', () => {
  const shuffled = ['source', 'low', 'time', 'volume', 'high', 'close', 'open', 'adjust', 'amount']
  writeCsvGz('SH600002', [
    { time: '2026-02-01', open: 10, close: 11, high: 12, low: 9, volume: 500, amount: '1234', adjust: 'qfq', source: 'sina' },
  ], shuffled)
  const bars = local.getLocalKline('SH600002')
  assert.equal(bars.length, 1)
  assert.equal(bars[0].close, 11)
  assert.equal(bars[0].amount, 1234)
  assert.equal(bars[0].localSource, 'sina')
})
await t('缺少必需列时报错被吞成 null（不污染上层）', () => {
  writeCsvGz('SH600003', [{ close: 1 }], ['close'])
  assert.equal(local.getLocalKline('SH600003'), null)
})

console.log('\n数据版本指纹')
await t('同一状态指纹稳定', () => {
  const v1 = local.localDataVersion(['SH600000'])
  const v2 = local.localDataVersion(['SH600000'])
  assert.equal(v1, v2)
  assert.equal(v1.length, 16)
})
await t('内容变化后指纹改变', () => {
  const before = local.localDataVersion(['SH600000'])
  writeCsvGz('SH600000', [...rows, { time: '2026-01-08', open: 1, close: 2, high: 3, low: 1, volume: 10, adjust: 'qfq', source: 'tencent' }])
  const after = local.localDataVersion(['SH600000'])
  assert.notEqual(before, after)
})
await t('未落库标的记为 missing', () => {
  const v = local.localDataVersion(['SZ999999'])
  assert.equal(typeof v, 'string')
  assert.equal(v.length, 16)
})

console.log('\n元信息与诊断')
await t('无 meta.db 时 getLocalMeta 返回 null', () => {
  assert.equal(local.getLocalMeta('SH600000'), null)
})
await t('listLocalMeta 无库时返回空列表', () => {
  const r = local.listLocalMeta()
  assert.deepEqual(r.symbols, [])
})
await t('diagnostics 报告目录与环境', () => {
  const d = local.localDiagnostics()
  assert.equal(d.dataRoot, ROOT)
  assert.equal(d.barsDirExists, true)
  assert.equal(d.metaDbExists, false)
  assert.ok('DSH_STOCK_LAB_DATA' in d.env)
})

console.log('\n真实跨语言往返（Python 写 → Node 读）')
let pyPath = process.env.DSH_STOCK_LAB_PYTHON
if (!pyPath) {
  const cand = join(process.env.DSH_HOME || join(process.env.USERPROFILE || '', '.dsh'),
    'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe')
  if (existsSync(cand)) pyPath = cand
}
let pythonOk = false
if (pyPath && existsSync(pyPath)) {
  try { execFileSync(pyPath, ['-c', 'print(1)'], { stdio: 'ignore', timeout: 20000 }); pythonOk = true } catch { }
}

if (pythonOk) {
  await t('Python 写入的 bars 能被 Node 精确读出', () => {
    // 由 Python 侧 storage.save_bars 写盘（走真实写入路径，不是本测试手写的 gzip）
    const script = `
import os, sys
sys.path.insert(0, r"${join(backendDir, 'storage')}")
import pandas as pd
from storage import save_bars
df = pd.DataFrame({
    "time": ["2026-03-02", "2026-03-03", "2026-03-04"],
    "open": [10.0, 11.0, 12.0],
    "high": [11.5, 12.5, 13.5],
    "low": [9.5, 10.5, 11.5],
    "close": [11.0, 12.0, 13.0],
    "volume": [1000, 2000, 3000],
})
save_bars("SH600009", df, source="contract-test")
print("done")
`
    const out = execFileSync(pyPath, ['-c', script], {
      env: { ...process.env, DSH_STOCK_LAB_DATA: ROOT, PYTHONIOENCODING: 'utf-8' },
      timeout: 60000, encoding: 'utf8',
    })
    assert.match(out, /done/, 'Python 未成功写入: ' + out)

    const bars = local.getLocalKline('SH600009')
    assert.ok(bars, 'Node 读不到 Python 写的数据（跨语言契约破坏）')
    assert.equal(bars.length, 3)
    assert.deepEqual(bars.map((b) => b.time), ['2026-03-02', '2026-03-03', '2026-03-04'])
    assert.deepEqual(bars.map((b) => b.close), [11, 12, 13])
    assert.deepEqual(bars.map((b) => b.volume), [1000, 2000, 3000])

    const meta = local.getLocalMeta('SH600009')
    assert.ok(meta, 'Node 读不到 Python 写的 meta.db')
    assert.equal(meta.rows, 3)
    assert.equal(meta.source, 'contract-test')
    assert.equal(meta.first_bar, '2026-03-02')
    assert.equal(meta.last_bar, '2026-03-04')
  })
  await t('Node 与 Python 解析出的数据根目录一致', () => {
    // 通过 Python 打印它认为的 data_dir，与 Node 的比对
    const script = `
import sys
sys.path.insert(0, r"${join(backendDir, 'storage')}")
import storage
print(storage.DATA_DIR)
`
    const out = execFileSync(pyPath, ['-c', script], {
      env: { ...process.env, DSH_STOCK_LAB_DATA: ROOT, PYTHONIOENCODING: 'utf-8' },
      timeout: 30000, encoding: 'utf8',
    }).trim()
    assert.equal(out, ROOT, 'Python 与 Node 的数据目录不一致：' + out + ' vs ' + ROOT)
  })
} else {
  console.log('  - 跳过真实往返（未找到可用的 Python 解释器）')
}

cleanupTempDir(ROOT)
console.log(`\n${passed} passed`)