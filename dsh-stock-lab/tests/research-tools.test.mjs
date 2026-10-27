/**
 * research-tools.test.mjs — 研究类 AI Tools 测试（临时库）
 * 运行：node tests/research-tools.test.mjs
 */
import { strict as assert } from 'node:assert'
import { cleanupTempDir } from './cleanup.mjs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TEST_HOME = join(tmpdir(), 'stock-lab-rt-' + randomUUID())
process.env.DSH_STOCK_LAB_HOME = TEST_HOME

const { ResearchStore } = await import('../src/services/research-service/research-store.js')
const { registerResearchTools } = await import('../src/tools/research-tools.js')

let passed = 0
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

const store = new ResearchStore()
const tools = []
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  tools: { register: (d) => tools.push(d) },
}
// 假 market：用于验证笔记自动记录数据版本（可复现原则）
const fakeMarket = {
  // 与真实 normalize 一致：300750 → SZ300750（本地库按内部 symbol 存）
  normalizeSymbol: (s) => {
    const raw = String(s)
    return { symbol: /^\d{6}$/.test(raw) ? (raw.startsWith('3') || raw.startsWith('0') ? 'SZ' : 'SH') + raw : raw.toUpperCase() }
  },
  getLocalDataStatus: () => ({ dataDir: '/tmp', symbols: [{ symbol: 'SZ300750' }], available: true }),
  getDataVersion: () => 'cafebabecafebabe',
}
const n = registerResearchTools(ctx, store, fakeMarket)

console.log('注册')
await t('注册 4 个研究工具', () => assert.equal(n, 4))
await t('工具名单正确', () => {
  assert.deepEqual(tools.map((x) => x.name).sort(), [
    'list_research_notes', 'research_notebook_stats', 'review_research_note', 'save_research_note',
  ])
})
await t('每个工具有 schema', () => {
  for (const x of tools) {
    assert.equal(x.parameters.type, 'object')
    assert.ok(x.description.length > 20)
  }
})

const byName = (nm) => tools.find((x) => x.name === nm)

console.log('\nsave_research_note')
let saved
await t('保存返回 id', async () => {
  saved = await byName('save_research_note').execute({
    symbol: '300750', name: '宁德时代',
    observation: '20日跑输沪深300 13.96pp',
    hypothesis: '海外业务风险被重新定价',
    evidence: ['60日超额 -25.05pp', '波动率 59.98%'],
    counterEvidence: ['PE 12.54 历史低位'],
    prediction: '未来10日继续弱于沪深300',
    confidence: 0.55,
    reviewDate: '2026-11-06',
    tags: ['test'],
  })
  assert.equal(saved.saved, true)
  assert.ok(saved.id)
  assert.equal(saved.symbol, 'SZ300750')
})
await t('缺少 hypothesis 时报错', async () => {
  await assert.rejects(
    byName('save_research_note').execute({ symbol: '600519', observation: 'x' }),
    /缺少必填字段/,
  )
})
await t('自动记录数据版本（本地库有该标的 → 指纹）', async () => {
  const r = await byName('save_research_note').execute({
    symbol: '300750', observation: 'o', hypothesis: 'h',
  })
  assert.match(r.dataVersion, /cafebabecafebabe/, '应自动填入本地库指纹: ' + r.dataVersion)
  assert.match(r.dataVersion, /本地库/)
})
await t('本地库没有该标的时如实标注"未落库"', async () => {
  const r = await byName('save_research_note').execute({
    symbol: '600000', observation: 'o', hypothesis: 'h',
  })
  assert.match(r.dataVersion, /未落库/, '不应假装可复现: ' + r.dataVersion)
})
await t('显式传入的 dataVersion 优先于自动生成', async () => {
  const r = await byName('save_research_note').execute({
    symbol: '600519', observation: 'o', hypothesis: 'h', dataVersion: 'my-version-1',
  })
  assert.equal(r.dataVersion, 'my-version-1')
})

console.log('\nlist_research_notes')
await t('能列出刚保存的', async () => {
  const r = await byName('list_research_notes').execute({ symbol: '300750' })
  assert.ok(r.count >= 1, '应至少列出 1 条')
  const hit = r.notes.find((x) => x.id === saved.id)
  assert.ok(hit, '刚保存的笔记应在列表里')
  assert.equal(hit.status, 'open')
})
await t('dueOnly 过滤有效', async () => {
  const before = await byName('list_research_notes').execute({ dueOnly: true })
  const all = await byName('list_research_notes').execute({})
  assert.ok(before.count <= all.count)
  assert.ok(before.notes.every((x) => x.status === 'open' && x.reviewDate))
})

console.log('\nreview_research_note')
await t('复盘成功并变更状态', async () => {
  const r = await byName('review_research_note').execute({
    id: saved.id, verdict: 'partially',
    reviewNotes: '方向正确，幅度低估', actualOutcome: '实际跑输 20pp',
  })
  assert.equal(r.reviewed, true)
  assert.equal(r.verdict, 'partially')
})
await t('非法 verdict 报错', async () => {
  await assert.rejects(
    byName('review_research_note').execute({ id: saved.id, verdict: 'guess' }),
    /verdict/,
  )
})
await t('不存在 id 报错', async () => {
  await assert.rejects(
    byName('review_research_note').execute({ id: 'nope', verdict: 'correct' }),
    /note 不存在/,
  )
})

console.log('\nresearch_notebook_stats')
await t('统计含免责提示', async () => {
  const s = await byName('research_notebook_stats').execute()
  assert.ok(s.total >= 1)
  assert.equal(s.reviewed, 1)
  assert.ok(s.note.includes('不具统计意义'), '必须提醒样本小不可当胜率')
})

// 先关掉 SQLite 连接，否则 Windows 上文件被占用、临时目录删不掉
// （这个失败原先被空 catch 吞掉，导致一直静默往系统临时目录漏垃圾）
try { store?.close?.() } catch { /* ignore */ }
cleanupTempDir(TEST_HOME)
console.log(`\n${passed} passed`)
