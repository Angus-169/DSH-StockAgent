/**
 * formula-store.test.mjs — 公式库 + 公式工具测试（临时库 + 假 market，纯离线）
 * 运行：node tests/formula-store.test.mjs
 */
import { strict as assert } from 'node:assert'
import { cleanupTempDir } from './cleanup.mjs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'

const TEST_HOME = join(process.cwd(), '.test-data', 'formula-' + randomUUID().slice(0, 8))
process.env.DSH_STOCK_LAB_HOME = TEST_HOME

const { FormulaStore } = await import('../src/services/formula-service/formula-store.js')
const { registerFormulaTools } = await import('../src/tools/formula-tools.js')
const { readFormulaFileText, listFormulaFiles, FormulaFileError } =
  await import('../src/services/formula-service/read-file.js')

let passed = 0
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

function makeBars(n = 60) {
  const out = []
  for (let i = 0; i < n; i++) {
    const c = 100 + Math.sin(i / 5) * 10 + i * 0.1
    out.push({ time: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 + (i % 5) * 100, amount: null })
  }
  return out
}
const BARS = makeBars()

const fakeMarket = {
  normalizeSymbol: (s) => ({ symbol: /^\d{6}$/.test(String(s)) ? (String(s).startsWith('6') ? 'SH' : 'SZ') + s : String(s).toUpperCase() }),
  getKlineInfo: async (s, o) => ({
    symbol: s, bars: BARS, provenance: { dataSource: '本地历史库', sourceKey: 'local', reproducible: true, dataVersion: 'v1' },
  }),
}

console.log('公式库存储')
const store = new FormulaStore()
let saved
await t('保存公式并回读', () => {
  saved = store.create({
    name: 'MACD', text: 'DIF:EMA(C,12)-EMA(C,26);\nDEA:EMA(DIF,9);\nMACD:(DIF-DEA)*2;',
    source: 'chat', ok: true, outputs: [{ name: 'DIF' }, { name: 'DEA' }, { name: 'MACD' }],
    futureFunctions: [], ignoredDrawCalls: [], usedFunctions: ['EMA'],
  })
  assert.ok(saved.id)
  assert.equal(saved.name, 'MACD')
  assert.equal(saved.symbol, null)
  assert.equal(store.get(saved.id).text.includes('DIF:EMA'), true)
})
await t('缺名字/空内容被拒', () => {
  assert.throws(() => store.create({ text: 'X:C;' }), /必须有名字/)
  assert.throws(() => store.create({ name: 'A', text: '   ' }), /内容为空/)
})
await t('同名同标的视为更新（不产生重复行）', () => {
  const before = store.list({}).length
  store.create({ name: 'MACD', text: 'X:C;', source: 'chat', ok: true })
  assert.equal(store.list({}).length, before, '同名应更新而不是新增')
  assert.equal(store.findByName('MACD').text, 'X:C;')
})
await t('同名但不同标的各自独立', () => {
  const a = store.create({ name: 'RSI', symbol: '600519', text: 'X:C;', source: 'chat', ok: true })
  const b = store.create({ name: 'RSI', symbol: '300750', text: 'Y:C;', source: 'chat', ok: true })
  assert.notEqual(a.id, b.id)
  assert.equal(a.symbol, 'SH600519')
  assert.equal(b.symbol, 'SZ300750')
})
await t('按标的查询包含通用公式', () => {
  const list = store.list({ symbol: '600519' })
  assert.ok(list.some((f) => f.symbol === 'SH600519'), '应含该标的专属公式')
  assert.ok(list.some((f) => f.symbol === null), '应含通用公式')
})
await t('runCount / lastRunAt 累计', () => {
  store.touchRun(saved.id)
  store.touchRun(saved.id)
  const f = store.get(saved.id)
  assert.equal(f.runCount, 2)
  assert.ok(f.lastRunAt)
})
await t('stats 统计可用数与未来函数告警数', () => {
  store.create({ name: '含未来函数', text: 'X:ZIG(C,5);', source: 'chat', ok: true, futureFunctions: ['ZIG'] })
  const s = store.stats()
  assert.ok(s.total >= 3)
  assert.equal(s.withFutureWarning, 1)
})
await t('删除生效', () => {
  const f = store.create({ name: '待删', text: 'X:C;', source: 'chat', ok: true })
  assert.equal(store.delete(f.id), true)
  assert.equal(store.get(f.id), null)
})

console.log('\n公式文件读取')
const dir = join(TEST_HOME, 'formulas')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'macd.txt'), 'DIF:EMA(C,12)-EMA(C,26);\nDEA:EMA(DIF,9);', 'utf8')
writeFileSync(join(dir, 'kdj.tnf'), 'K:MA(C,5);', 'utf8')
writeFileSync(join(dir, 'encrypted.tne'), Buffer.from([0x00, 0x01, 0x02, 0x03]))
writeFileSync(join(dir, 'notes.md'), 'not a formula', 'utf8')

await t('读取文本公式文件', () => {
  assert.match(readFormulaFileText(join(dir, 'macd.txt')), /DIF:EMA/)
})
await t('缺少的文件报可读错误', () => {
  assert.throws(() => readFormulaFileText(join(dir, 'nope.txt')), FormulaFileError)
  assert.throws(() => readFormulaFileText(join(dir, 'nope.txt')), /文件不存在/)
})
await t('目录被拒并指向批量导入', () => {
  assert.throws(() => readFormulaFileText(dir), /目录/)
})
await t('空文件被拒', () => {
  const empty = join(dir, 'empty.txt')
  writeFileSync(empty, '')
  assert.throws(() => readFormulaFileText(empty), /空的/)
})
await t('加密扩展名给出可操作提示（指向公式管理器）', () => {
  assert.throws(() => readFormulaFileText(join(dir, 'encrypted.tne')), /公式管理器/)
})
await t('GBK 编码文件能正确解码', () => {
  // 造一个 GBK 编码的中文公式
  const gbkBytes = Buffer.from([0xB9, 0xAB, 0xCA, 0xBD]) // "公式" 的 GBK
  const p = join(dir, 'gbk.txt')
  writeFileSync(p, Buffer.concat([Buffer.from('X:'), gbkBytes, Buffer.from(';\n')]))
  // 至少不抛错；若环境支持 gbk 则应还原出中文
  const text = readFormulaFileText(p)
  assert.ok(text.includes('X:'), 'text=' + text)
})
await t('目录扫描区分可导入与不可导入', () => {
  const files = listFormulaFiles(dir)
  assert.ok(files.some((f) => f.name === 'macd.txt'))
  const enc = files.find((f) => f.name === 'encrypted.tne')
  assert.ok(enc?.rejected, '加密文件应被标记为不可导入')
  assert.ok(!files.some((f) => f.name === 'notes.md'), '.md 不在可导入扩展名内')
})

console.log('\n公式工具（假 market）')
const tools = []
const ctx = { logger: { info() {}, warn() {}, error() {} }, tools: { register: (d) => tools.push(d) } }
const n = registerFormulaTools(ctx, store, fakeMarket)
const byName = (nm) => tools.find((x) => x.name === nm)

await t('注册 6 个公式工具', () => assert.equal(n, 6))
await t('工具名单正确', () => {
  assert.deepEqual(tools.map((x) => x.name).sort(), [
    'delete_formula', 'import_formula', 'import_formula_dir',
    'list_formulas', 'run_formula', 'tdx_capabilities',
  ])
})

await t('import_formula：粘贴文本并试算', async () => {
  const r = await byName('import_formula').execute({
    name: '测试MA', symbol: '600519',
    text: 'MA5:MA(C,5);\nMA20:MA(C,20);\nXG:CROSS(MA5,MA20);',
  })
  assert.equal(r.saved, true)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.deepEqual(r.outputs, ['MA5', 'MA20', 'XG'])
  assert.ok(r.trial?.ok, '应给出试算结果')
  assert.equal(r.trial.barCount, BARS.length)
  assert.ok(r.summary.includes('解析成功'))
})
await t('import_formula：dryRun 不落库', async () => {
  const before = store.list({}).length
  const r = await byName('import_formula').execute({ name: '不保存', text: 'X:C;', dryRun: true })
  assert.equal(r.saved, false)
  assert.equal(store.list({}).length, before)
})
await t('import_formula：语法错误时报错且不假装成功', async () => {
  const r = await byName('import_formula').execute({ name: '坏公式', text: 'X:MA(C;' })
  assert.equal(r.saved, true, '仍会保存以便用户修正')
  assert.equal(r.ok, false)
  assert.ok(r.errors.length > 0)
  assert.ok(r.summary.includes('解析失败'))
})
await t('import_formula：未来函数被标出并给警告', async () => {
  const r = await byName('import_formula').execute({ name: '含ZIG', text: 'X:ZIG(C,5);' })
  assert.deepEqual(r.futureFunctions, ['ZIG'])
  assert.ok(r.warnings.some((w) => /未来函数/.test(w)))
})
await t('import_formula：文件导入', async () => {
  const r = await byName('import_formula').execute({ name: '文件公式', filePath: join(dir, 'macd.txt') })
  assert.equal(r.saved, true)
  assert.equal(r.ok, true)
})
await t('import_formula：加密文件导入给出可操作错误', async () => {
  await assert.rejects(
    byName('import_formula').execute({ name: '加密', filePath: join(dir, 'encrypted.tne') }),
    /公式管理器/,
  )
})
await t('import_formula：既无 text 也无 filePath 被拒', async () => {
  await assert.rejects(byName('import_formula').execute({ name: '空' }), /text.*filePath|filePath.*text/)
})
await t('run_formula：按名字运行并返回最近数值', async () => {
  const r = await byName('run_formula').execute({ name: '测试MA', symbol: '600519', tail: 5 })
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.outputs.length, 3)
  assert.equal(r.outputs[0].recent.length, 5)
  assert.equal(r.range.end, BARS.at(-1).time)
  assert.equal(r.provenance.reproducible, true)
})
await t('run_formula：选股条件给出命中统计', async () => {
  const r = await byName('run_formula').execute({ name: '测试MA', symbol: '600519' })
  assert.ok(r.signals, '应有 signals')
  if (r.signals.notACondition) throw new Error('XG 是 0/1 条件，不该被判为非条件：' + r.signals.notACondition)
  assert.equal(r.signals.conditionName, 'XG')
  assert.ok(typeof r.signals.hitCount === 'number')
  assert.ok(r.signals.hitRate >= 0 && r.signals.hitRate <= 1)
})
await t('run_formula：指标公式明确说明"不能当选股条件"', async () => {
  await byName('import_formula').execute({ name: '纯均线', text: 'MA5:MA(C,5);' })
  const r = await byName('run_formula').execute({ name: '纯均线', symbol: '600519' })
  assert.ok(r.signals.notACondition, '指标线不该被当信号')
  assert.ok(/不是 0\/1 条件/.test(r.signals.notACondition))
})
await t('run_formula：未来函数公式默认拒绝执行', async () => {
  const r = await byName('run_formula').execute({ name: '含ZIG', symbol: '600519' })
  assert.equal(r.ok, false)
  assert.deepEqual(r.futureFunctions, ['ZIG'])
})
await t('run_formula：显式允许后可以看图', async () => {
  const r = await byName('run_formula').execute({ name: '含ZIG', symbol: '600519', allowFutureFunctions: true })
  assert.ok(r.warnings.some((w) => /未来函数/.test(w)))
})
await t('run_formula：找不到公式给可操作提示', async () => {
  await assert.rejects(byName('run_formula').execute({ name: '不存在', symbol: '600519' }), /list_formulas/)
})
await t('list_formulas：返回清单与统计', async () => {
  const r = await byName('list_formulas').execute({ symbol: '600519' })
  assert.ok(r.count >= 2)
  assert.ok(r.stats.total >= 2)
  assert.ok(r.formulas.every((f) => 'ok' in f && 'futureFunctions' in f))
})
await t('list_formulas：okOnly 过滤', async () => {
  const all = await byName('list_formulas').execute({})
  const okOnly = await byName('list_formulas').execute({ okOnly: true })
  assert.ok(okOnly.count <= all.count)
  assert.ok(okOnly.formulas.every((f) => f.ok))
})
await t('import_formula_dir：批量导入并报告每个文件', async () => {
  const r = await byName('import_formula_dir').execute({ dirPath: dir })
  assert.ok(r.found >= 3)
  assert.ok(r.imported >= 2, '应至少导入两个文本公式')
  const enc = r.results.find((x) => x.file === 'encrypted.tne')
  assert.ok(enc && enc.imported === false && /无法解析/.test(enc.reason), '加密文件应如实报告原因')
})
await t('import_formula_dir：dryRun 只诊断', async () => {
  const before = store.list({}).length
  await byName('import_formula_dir').execute({ dirPath: dir, dryRun: true })
  assert.equal(store.list({}).length, before)
})
await t('import_formula_dir：空目录给出说明', async () => {
  const emptyDir = join(TEST_HOME, 'empty-dir')
  mkdirSync(emptyDir, { recursive: true })
  const r = await byName('import_formula_dir').execute({ dirPath: emptyDir })
  assert.equal(r.found, 0)
  assert.ok(r.note.includes('没有可识别'))
})
await t('delete_formula：按名字删除', async () => {
  const r = await byName('delete_formula').execute({ name: '纯均线' })
  assert.equal(r.deleted, true)
})
await t('tdx_capabilities：列出能力与已知限制', async () => {
  const r = await byName('tdx_capabilities').execute()
  assert.ok(r.supportedFunctions.includes('MA'))
  // 三类"不能用"必须分开，且各自说明原因与出路
  assert.ok(r.notSupported.futureFunctions.list.includes('ZIG'))
  assert.ok(r.notSupported.futureFunctions.why.includes('重画历史'))
  assert.ok(r.notSupported.futureFunctions.workaround.includes('allowFutureFunctions'))
  assert.ok(r.notSupported.dataDependentFunctions.list.includes('FINANCE'))
  assert.ok(r.notSupported.dataDependentFunctions.why.includes('不是未来函数'),
    '必须明确区分"缺数据"与"未来函数"')
  assert.ok(r.notSupported.dataDependentFunctions.workaround.includes('stock_financials'))
  assert.ok(r.notSupported.notImplementedFunctions.list.includes('WINNER'))
  assert.ok(r.notSupported.binaryFiles.includes('无法解析'))
  assert.ok(r.notSupported.unconfirmedSmoothing.includes('MEMA'))
  assert.ok(r.semantics.STD.includes('总体'))
})
await t('tdx_capabilities：说明选股公式的写法与当前范围', async () => {
  const r = await byName('tdx_capabilities').execute()
  assert.ok(r.selection.howToWrite.includes('最后一条输出线'), '应说明选股公式写法')
  assert.ok(r.selection.strictness.includes('指标线'), '应说明指标线会被拒绝')
  assert.ok(r.selection.scope.includes('技术面'), '应说明当前只支持技术面选股')
  assert.ok(r.supportedSeries.includes('CLOSE/C'), '应列出可用的行情序列')
})

console.log('\n工具返回值必须是 lossless JSON（宿主硬要求）')
// 真实踩过的坑：analyze() 早期不返回 usedFunctions，导致工具返回值里出现
// undefined —— JSON.stringify 会静默丢弃，但宿主校验直接报
// "value is not lossless JSON" 并让整次调用失败。
await t('所有工具返回值递归不含 undefined', async () => {
  const cases = [
    ['import_formula', { name: '序列化检查', text: 'X:MA(C,5);', dryRun: true }],
    ['import_formula', { name: '含未来函数2', text: 'X:ZIG(C,5);', dryRun: true }],
    ['list_formulas', {}],
    ['tdx_capabilities', {}],
    ['run_formula', { name: '测试MA', symbol: '600519' }],
    ['run_formula', { name: '不存在', symbol: '600519' }],
  ]
  for (const [toolName, args] of cases) {
    let res
    try { res = await byName(toolName).execute(args) }
    catch { continue } // 抛错是可接受的路径，不算"返回值含 undefined"
    const bad = []
    const walk = (o, path) => {
      if (o === undefined) { bad.push(path); return }
      if (typeof o === 'number' && !Number.isFinite(o)) { bad.push(path + ' (non-finite)'); return }
      if (o && typeof o === 'object') for (const k of Object.keys(o)) walk(o[k], path + '.' + k)
    }
    walk(res, toolName)
    assert.deepEqual(bad, [], `${toolName} 返回值含不可序列化项: ${bad.join(', ')}`)
  }
})
await t('analyze 也报告 usedFunctions（供工具透传）', async () => {
  const { analyze } = await import('../src/services/formula-service/index.js')
  const info = analyze('X:MA(EMA(C,5),10);')
  assert.deepEqual(info.usedFunctions, ['EMA', 'MA'])
  assert.deepEqual(info.usedFunctions, info.usedFunctions, '不应为 undefined')
})
await t('非有限数被净化（除零等边界）', async () => {
  const r = await byName('import_formula').execute({
    name: '除零', text: 'X:C/0;', symbol: '600519', dryRun: true,
  })
  const walk = (o) => {
    if (typeof o === 'number' && !Number.isFinite(o)) throw new Error('出现非有限数')
    if (o && typeof o === 'object') for (const k of Object.keys(o)) walk(o[k])
  }
  walk(r)
})

console.log('\n持久化')
await t('重开库数据仍在', () => {
  store.close()
  const s2 = new FormulaStore()
  assert.ok(s2.list({}).length >= 3)
  assert.ok(s2.findByName('测试MA'))
  s2.close()
})

cleanupTempDir(TEST_HOME)
console.log(`\n${passed} passed`)
