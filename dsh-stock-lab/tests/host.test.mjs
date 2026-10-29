/**
 * host.test.mjs — Host 入口契约测试（假 ctx，不联网不需宿主）
 * 运行：node tests/host.test.mjs
 */
import { strict as assert } from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// 必须在 import src/index.js 之前设置：研究库用它决定落盘根目录，
// 否则测试会写进真实的 ~/.dsh/stock-lab（脏数据 + 权限问题）。
const TEST_HOME = join(tmpdir(), 'stock-lab-host-' + randomUUID())
process.env.DSH_STOCK_LAB_HOME = TEST_HOME

let passed = 0
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}
async function ta(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

const mod = await import('../src/index.js')

console.log('Host 导出契约')
t('导出 name = stock-lab', () => assert.equal(mod.name, 'stock-lab'))
t('inject 含 webServer / tools / skills', () => {
  for (const s of ['webServer', 'tools', 'skills']) assert.ok(mod.inject.includes(s), '缺少 inject: ' + s)
})
t('导出 apply 函数', () => assert.equal(typeof mod.apply, 'function'))
t('导出 MarketService 类', () => assert.equal(typeof mod.MarketService, 'function'))

console.log('\napply() 装配')
const routes = []; const tools = []; const skills = []
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  effect: (fn) => fn(),
  webServer: { register: (r) => { routes.push(r); return { dispose() {} } } },
  tools: { register: (d) => tools.push(d) },
  skills: { register: (s) => skills.push(s) },
}
t('apply 不抛错', () => mod.apply(ctx))
t('注册了 31 个 tool（9 行情 + 4 研究 + 3 量化 + 5 盯盘 + 7 公式 + 3 画线）', () => assert.equal(tools.length, 31))
t('含画线工具（让 AI 能在图上画线/标注）', () => {
  const names = tools.map((x) => x.name)
  for (const n of ['save_drawing', 'list_drawings', 'delete_drawing']) {
    assert.ok(names.includes(n), '缺少 ' + n)
  }
})
t('含研究类工具', () => {
  const names = tools.map((x) => x.name)
  for (const n of ['save_research_note', 'list_research_notes', 'review_research_note', 'research_notebook_stats']) {
    assert.ok(names.includes(n), '缺少 ' + n)
  }
})
t('含行业板块工具', () => {
  assert.ok(tools.map((x) => x.name).includes('sector_overview'), '缺少 sector_overview')
})
t('含量化工具', () => {
  const names = tools.map((x) => x.name)
  for (const n of ['run_event_study', 'collect_history', 'local_data_status']) {
    assert.ok(names.includes(n), '缺少 ' + n)
  }
})
t('含盯盘工具（含 digest）', () => {
  const names = tools.map((x) => x.name)
  for (const n of ['create_watch_rule', 'list_watch_rules', 'evaluate_watch_rules', 'list_watch_triggers', 'watch_digest']) {
    assert.ok(names.includes(n), '缺少 ' + n)
  }
})
t('含通达信公式工具（含选股 screen_formula）', () => {
  const names = tools.map((x) => x.name)
  for (const n of ['import_formula', 'run_formula', 'list_formulas', 'delete_formula', 'import_formula_dir', 'tdx_capabilities', 'screen_formula']) {
    assert.ok(names.includes(n), '缺少 ' + n)
  }
})
t('注册了 stock-lab skill', () => {
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, 'stock-lab')
  assert.ok(skills[0].content.includes('合规红线'))
  assert.equal(skills[0].source, 'bundled')
})
t('注册了 61 条路由', () => assert.equal(routes.length, 61))
t('路由路径均以 /stock-lab 开头', () => {
  for (const r of routes) assert.ok(r.path.startsWith('/stock-lab'), r.path)
  assert.equal(routes[0].kind, 'exact')
})
t('包含关键路由', () => {
  const paths = routes.map((r) => r.path)
  for (const p of [
    '/stock-lab/health', '/stock-lab/overview', '/stock-lab/kline', '/stock-lab/search',
    '/stock-lab/sectors', '/stock-lab/research/list', '/stock-lab/quant/event-study',
    '/stock-lab/watch/rules', '/stock-lab/watch/evaluate', '/stock-lab/watch/triggers',
    '/stock-lab/watch/pending', '/stock-lab/local/status', '/stock-lab/local/version',
    '/stock-lab/formula/list', '/stock-lab/formula/analyze', '/stock-lab/formula/import', '/stock-lab/formula/run',
    '/stock-lab/formula/screen/start', '/stock-lab/formula/screen/status', '/stock-lab/formula/screen/cancel',
    '/stock-lab/formula/screen/universes', '/stock-lab/formula/screen/jobs',
    '/stock-lab/chat/info', '/stock-lab/chat/send', '/stock-lab/chat/stream', '/stock-lab/chat/messages',
    // 删除接口保留：界面上没有入口（删对话在工作区里做），但脚本/测试仍需要
    '/stock-lab/chat/delete-thread',
    '/stock-lab/drawings', '/stock-lab/drawings/add', '/stock-lab/drawings/remove', '/stock-lab/drawings/stats',
  ]) {
    assert.ok(paths.includes(p), '缺少 ' + p)
  }
})

console.log('\n缺服务时的降级')
await ta('tools 服务缺失时不抛错且告警', async () => {
  const warns = []
  const ctxNoTools = {
    logger: { info() {}, warn: (m) => warns.push(m), error() {} },
    effect: (fn) => fn(),
    get: () => undefined,
    webServer: { register: () => ({ dispose() {} }) },
    skills: { register() {} },
  }
  assert.doesNotThrow(() => mod.apply(ctxNoTools))
  assert.ok(warns.some((w) => String(w).includes('tools')), '应告警 tools 不可用，实际: ' + JSON.stringify(warns))
})
await ta('tools 缺失时工具仍被收集（右栏对话可用其 execute）', async () => {
  // 降级语义：无法注册为 agent 工具，但本进程仍能直接执行自己的工具
  const collected = []
  const ctxNoTools = {
    logger: { info() {}, warn() {}, error() {} },
    effect: (fn) => fn(),
    get: () => undefined,
    webServer: { register: () => ({ dispose() {} }) },
    skills: { register() {} },
  }
  assert.doesNotThrow(() => mod.apply(ctxNoTools))
  const chatInfo = routes.find((r) => r.path === '/stock-lab/chat/info')
  assert.ok(chatInfo, '应有 chat/info 路由')
  let out = ''
  const res = { statusCode: 0, setHeader() {}, end: (b) => { out = b } }
  await chatInfo.handler({ url: '/stock-lab/chat/info', method: 'GET' }, res)
  const json = JSON.parse(out)
  assert.ok(json.data.toolCount > 0, 'tools 服务缺失时工具白名单不该为空，实际 ' + json.data.toolCount)
})
await ta('timer 服务缺失时盯盘降级为手动触发', async () => {
  const infos = []
  const ctxNoTimer = {
    logger: { info: (m) => infos.push(m), warn() {}, error() {} },
    effect: (fn) => fn(),
    get: (k) => (k === 'timer' ? undefined : undefined),
    webServer: { register: () => ({ dispose() {} }) },
    tools: { register() {} },
    skills: { register() {} },
  }
  assert.doesNotThrow(() => mod.apply(ctxNoTimer))
  assert.ok(infos.some((m) => String(m).includes('timer')), '应说明 timer 不可用，实际: ' + JSON.stringify(infos))
})

console.log('\n路由行为（health 不依赖外部服务）')
await ta('health 路由返回插件信息', async () => {
  const health = routes.find((r) => r.path === '/stock-lab/health')
  let out = ''
  const res = { statusCode: 0, setHeader() {}, end: (b) => { out = b } }
  await health.handler({ url: '/stock-lab/health', method: 'GET' }, res)
  const json = JSON.parse(out)
  assert.equal(json.ok, true)
  assert.equal(json.data.plugin, 'stock-lab')
})

console.log('\n路由行为（选股路由要真的能调，不能只注册）')
// 真实踩过的坑：5 条 screen 路由写成无条件 noScreen()，只要被调用就报"引擎不可用"。
// 而测试只数了路由条数、冒烟直连 service，整组测试全绿也没发现。这条真的调一次 handler。
await ta('formula/screen/jobs 返回 jobs 数组而不是"引擎不可用"', async () => {
  const jobsRoute = routes.find((r) => r.path === '/stock-lab/formula/screen/jobs')
  assert.ok(jobsRoute, '缺少 /formula/screen/jobs 路由')
  let out = ''
  const res = { statusCode: 0, setHeader() {}, end: (b) => { out = b } }
  await jobsRoute.handler({ url: '/stock-lab/formula/screen/jobs', method: 'GET' }, res)
  const json = JSON.parse(out)
  assert.equal(json.ok, true, '选股路由不应报错：' + out)
  assert.ok(Array.isArray(json.data.jobs), '应返回 jobs 数组')
})

await ta('formula/screen/start → status 真的跑通引擎（含请求体解析）', async () => {
  const startRoute = routes.find((r) => r.path === '/stock-lab/formula/screen/start')
  const statusRoute = routes.find((r) => r.path === '/stock-lab/formula/screen/status')
  assert.ok(startRoute && statusRoute, '缺少 screen start/status 路由')
  const body = JSON.stringify({ text: 'XG:CLOSE>MA(CLOSE,20);', universe: 'local', latestOnly: true })
  const req = {
    method: 'POST',
    url: '/stock-lab/formula/screen/start',
    async *[Symbol.asyncIterator]() { yield Buffer.from(body) },
  }
  let out = ''
  const res = { statusCode: 0, setHeader() {}, end: (b) => { out = b } }
  await startRoute.handler(req, res)
  const started = JSON.parse(out)
  assert.equal(started.ok, true, 'start 应成功：' + out)
  assert.ok(started.data.id, '应返回任务 id')

  const deadline = Date.now() + 20000
  let job = started.data
  while (job.state === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    let sout = ''
    await statusRoute.handler(
      { method: 'GET', url: '/stock-lab/formula/screen/status?id=' + encodeURIComponent(job.id) },
      { statusCode: 0, setHeader() {}, end: (b) => { sout = b } },
    )
    const sj = JSON.parse(sout)
    assert.equal(sj.ok, true, 'status 应成功：' + sout)
    job = sj.data
  }
  assert.notEqual(job.state, 'running', '任务应在 20s 内结束')
  assert.ok(['done', 'cancelled', 'failed'].includes(job.state), '任务状态异常：' + job.state)
  assert.equal(typeof job.progress.done, 'number')
})

console.log('\n架构铁律检查')
// 只检查真实 import 语句，忽略注释中出现的路径字样
const importTargets = (src) => {
  const out = []
  const re = /(?:import\s[^'"]*from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(src)) !== null) out.push(m[1])
  return out
}
await ta('index.js 不直接 import datasource', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8')
  const bad = importTargets(src).filter((t) => t.includes('datasource/'))
  assert.deepEqual(bad, [], 'index.js 不得 import datasource: ' + bad.join(','))
})
await ta('tools/index.js 不直接 import datasource', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/tools/index.js', import.meta.url), 'utf8')
  const bad = importTargets(src).filter((t) => t.includes('datasource/'))
  assert.deepEqual(bad, [], 'tools 不得 import datasource: ' + bad.join(','))
})
await ta('只有 market-service 引用 datasource', async () => {
  const { readFileSync, readdirSync, statSync } = await import('node:fs')
  const walk = (dir) => {
    const out = []
    for (const f of readdirSync(dir)) {
      const p = dir + '/' + f
      if (statSync(p).isDirectory()) out.push(...walk(p))
      else if (p.endsWith('.js')) out.push(p)
    }
    return out
  }
  const srcDir = decodeURIComponent(new URL('../src', import.meta.url).pathname.replace(/^\//, ''))
  const files = walk(srcDir)
  const offenders = []
  for (const f of files) {
    if (f.includes('market-service') || f.includes('datasource')) continue
    const bad = importTargets(readFileSync(f, 'utf8')).filter((t) => t.includes('datasource/'))
    if (bad.length) offenders.push(f.split('src').pop() + ' → ' + bad.join(','))
  }
  assert.deepEqual(offenders, [], '违规: ' + offenders.join(' | '))
})

console.log(`\n${passed} passed`)
