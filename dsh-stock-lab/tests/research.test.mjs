/**
 * research.test.mjs — Research Notebook 生命周期测试（临时目录，不污染真实数据）
 * 运行：node tests/research.test.mjs
 */
import { strict as assert } from 'node:assert'
import { cleanupTempDir } from './cleanup.mjs'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

// 必须在 import 之前设置，存储层读 env 决定根目录
const TEST_ROOT = join(tmpdir(), 'stock-lab-test-' + randomUUID())
process.env.DSH_STOCK_LAB_HOME = TEST_ROOT

const { ResearchStore, paths } = await import('../src/services/research-service/research-store.js')

let passed = 0
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

console.log('路径解析')
await t('根目录来自 DSH_STOCK_LAB_HOME', () => {
  assert.ok(paths.HOME.includes(TEST_ROOT), 'HOME=' + paths.HOME)
})
await t('notes 与 index.db 在 research/ 下', () => {
  assert.ok(paths.NOTES_DIR.endsWith('notes'))
  assert.ok(paths.DB_PATH.endsWith('index.db'))
})

const store = new ResearchStore()

console.log('\n创建 note')
let note
await t('必填字段缺失时报错', () => {
  assert.throws(() => store.create({ symbol: 'SH600519' }), /缺少必填字段/)
  assert.throws(() => store.create({ symbol: 'X', observation: 'a', hypothesis: '' }), /缺少必填字段/)
})
await t('创建成功并返回完整记录', () => {
  note = store.create({
    symbol: '300750', name: '宁德时代',
    asOf: '2026-10-23',
    observation: '连续 20 日跑输电池行业指数与沪深300',
    hypothesis: '市场可能正在重新定价海外业务风险',
    evidence: ['60日超额 -25.05pp', '20日波动率 59.98% 高于指数 16%', '主力资金近5日净流出'],
    counterEvidence: ['PE 12.54 处于历史低位区间'],
    prediction: '未来 10 个交易日继续弱于沪深300',
    confidence: 0.55,
    reviewDate: '2026-11-06',
    benchmark: 'IDX000300',
    tags: ['relative-strength', 'overseas-risk'],
    dataVersion: '2026-10-23T10:00:00Z',
    sources: ['tencent', 'eastmoney'],
  })
  assert.equal(note.symbol, 'SZ300750', 'symbol 应规范化为 SZ300750，实际 ' + note.symbol)
  assert.equal(note.status, 'open')
  assert.equal(note.confidence, 0.55)
  assert.deepEqual(note.evidence.length, 3)
  assert.deepEqual(note.sources, ['tencent', 'eastmoney'], 'sources 应保持数组')
  assert.ok(note.id)
})
await t('置信度越界被拒', () => {
  assert.throws(() => store.create({ symbol: '600519', observation: 'a', hypothesis: 'b', confidence: 1.5 }), /confidence/)
})
await t('markdown 文件已落盘且含关键内容', () => {
  const p = join(paths.NOTES_DIR, note.id + '.md')
  assert.ok(existsSync(p), 'markdown 未生成')
  const md = readFileSync(p, 'utf8')
  assert.ok(md.includes('宁德时代'))
  assert.ok(md.includes('海外业务风险'))
  assert.ok(md.includes('60日超额 -25.05pp'))
  assert.ok(md.includes('不构成投资建议'), '应含免责声明')
  assert.ok(md.includes('2026-11-06'), '应含复盘日')
})

console.log('\n查询')
await t('按 id 取回', () => {
  const got = store.get(note.id)
  assert.ok(got)
  assert.equal(got.hypothesis, note.hypothesis)
  assert.deepEqual(got.tags, ['relative-strength', 'overseas-risk'])
})
await t('按 symbol 过滤（大小写不敏感）', () => {
  const list = store.list({ symbol: '300750' })
  assert.equal(list.length, 1)
  assert.equal(store.list({ symbol: 'sz300750' }).length, 1)
})
await t('不存在的 id 返回 null', () => assert.equal(store.get('nope'), null))
await t('list 支持 limit', () => {
  for (let i = 0; i < 5; i++) {
    store.create({ symbol: '600519', observation: 'o' + i, hypothesis: 'h' + i })
  }
  assert.equal(store.list({ limit: 3 }).length, 3)
})

console.log('\n到期复盘')
await t('到期列表只含 open 且 reviewDate 已到', () => {
  const due = store.due('2026-11-10')
  assert.ok(due.some((d) => d.id === note.id), '应含宁德时代那条')
  assert.ok(due.every((d) => d.status === 'open' && d.reviewDate !== null))
})
await t('未到期的不出现在 due 里', () => {
  const due = store.due('2026-10-24')
  assert.ok(!due.some((d) => d.id === note.id))
})
await t('复盘写入结论并关闭', () => {
  const r = store.review(note.id, { verdict: 'partially', reviewNotes: '方向对但幅度超预期' })
  assert.equal(r.status, 'reviewed')
  assert.equal(r.verdict, 'partially')
  assert.ok(r.reviewedAt)
  assert.ok(r.reviewNotes.includes('方向对'))
})
await t('非法 verdict 被拒', () => {
  const n = store.create({ symbol: '600519', observation: 'a', hypothesis: 'b' })
  assert.throws(() => store.review(n.id, { verdict: 'maybe' }), /verdict/)
})
await t('复盘后 markdown 含复盘章节', () => {
  const md = readFileSync(join(paths.NOTES_DIR, note.id + '.md'), 'utf8')
  assert.ok(md.includes('## 复盘'))
  assert.ok(md.includes('partially'))
})

console.log('\n统计与删除')
await t('stats 数字正确', () => {
  const s = store.stats()
  assert.ok(s.total >= 7, 'total=' + s.total)
  assert.ok(s.open >= 5)
  assert.equal(s.reviewed, 1)
  assert.ok(Array.isArray(s.byVerdict))
})
await t('删除生效', () => {
  const n = store.create({ symbol: '600519', observation: 'x', hypothesis: 'y' })
  assert.equal(store.delete(n.id), true)
  assert.equal(store.get(n.id), null)
})

console.log('\n持久化')
await t('重开 store 后数据仍在（SQLite 落盘）', async () => {
  store.close()
  const store2 = new ResearchStore()
  const got = store2.get(note.id)
  assert.ok(got, '重开后取不到数据')
  assert.equal(got.verdict, 'partially')
  store2.close()
})

// 清理（失败要出声，不再用空 catch 静默吞掉）
cleanupTempDir(TEST_ROOT)
console.log(`\n${passed} passed`)
