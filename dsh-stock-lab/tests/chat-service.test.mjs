/**
 * chat-service.test.mjs — ChatService 测试（假 LLM + 临时库，纯离线）
 * 运行：node tests/chat-service.test.mjs
 *
 * 重点验证三件在"自建 Chat"里最容易做错的事：
 *   1. 只暴露本插件自己的工具（绝不能把 read/write/bash 之类带出去）
 *   2. 系统提示词里必须有"数字只能来自工具"等硬约束
 *   3. 对话过程完整落库（用户消息、助手回答、每次工具调用），失败也不丢
 */
import { strict as assert } from 'node:assert'
import { cleanupTempDir } from './cleanup.mjs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const TEST_HOME = join(process.cwd(), '.test-data', 'chatsvc-' + randomUUID().slice(0, 8))
process.env.DSH_STOCK_LAB_HOME = TEST_HOME

const { ChatService, GLOBAL_THREAD } = await import('../src/services/chat-service/index.js')
const { ChatStore } = await import('../src/services/chat-service/chat-store.js')

let passed = 0
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

/**
 * 每个测试用例用**独立的数据库文件**。
 *
 * 为什么必须这样：ChatStore 的默认路径是固定的（生产上本来就该共用一个库），
 * 测试若共用同一个库，前一个用例的消息会串到后一个用例里——表现为
 * "找到的 tool 消息属于上一个用例"，排查起来很费时间。
 */
let svcSeq = 0
function newStore() {
  svcSeq++
  return new ChatStore(join(TEST_HOME, `chat-${svcSeq}-${randomUUID().slice(0, 6)}.db`))
}

/** 假 LLM：按脚本吐 chunk */
function fakeLlm(scripts) {
  let i = 0
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      const chunks = scripts[Math.min(i, scripts.length - 1)] || [{ type: 'finish', reason: { kind: 'stop' } }]
      i++
      return (async function* () { for (const c of chunks) yield c })()
    },
  }
}
const toolCall = (id, name, args) => [
  { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: args },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]
const answer = (text) => [{ type: 'text-delta', text }, { type: 'finish', reason: { kind: 'stop' } }]

/** 假的插件工具白名单 */
function makeTools(executed) {
  return new Map([
    ['stock_research_snapshot', {
      name: 'stock_research_snapshot',
      description: '研究快照',
      parameters: { type: 'object', properties: { symbol: { type: 'string' } } },
      execute: async (args) => { executed.push(['snapshot', args]); return { price: 1335 } },
    }],
    ['stock_news', {
      name: 'stock_news',
      description: '新闻',
      parameters: { type: 'object', properties: {} },
      execute: async (args) => { executed.push(['news', args]); return { news: ['a'] } },
    }],
    ['broken', {
      name: 'broken',
      description: '会抛错的工具',
      parameters: { type: 'object' },
      execute: async () => { throw new Error('上游挂了') },
    }],
    // 没有 execute 的条目应被过滤掉（不是可调用工具）
    ['not_really_a_tool', { name: 'not_really_a_tool', description: 'x', parameters: {} }],
  ])
}

const SKILL = '# A股智能研究工作台\n\n## 合规红线\n\n只陈述事实与统计结果，不给投资建议。'

console.log('\n懒创建：只有真的开口才建对话')
// 用户明确要求的行为：不该为每个标的预建对话等着输入，而是真的在右栏发言才建。
// 早期实现把读路径也做成了"确保存在"，于是每浏览一个标的就留下一个空线程。
await t('listMessages 对未聊过的标的不创建线程', () => {
  const st = newStore()
  const svc = new ChatService({ store: st, tools: makeTools([]), systemBase: SKILL })
  const r = svc.listMessages('601398')
  assert.equal(r.thread, null)
  assert.deepEqual(r.messages, [])
  assert.equal(st.listThreads({}).length, 0, '读操作不该留下任何线程')
  svc.close()
})
await t('浏览多个标的（只读）零副作用', () => {
  const st = newStore()
  const svc = new ChatService({ store: st, tools: makeTools([]), systemBase: SKILL })
  for (const s of ['600519', '300750', '601398', '000001', '002594']) svc.listMessages(s)
  assert.equal(st.listThreads({}).length, 0, '浏览 5 只标的仍应是 0 条线程')
  svc.close()
})
await t('buildSystem 不建线程（它只是生成提示词）', () => {
  const st = newStore()
  const svc = new ChatService({ store: st, tools: makeTools([]), systemBase: SKILL })
  const sys = svc.buildSystem('601398')
  assert.ok(sys.includes('601398'), '没有线程时用代码作标题')
  assert.equal(st.listThreads({}).length, 0)
  svc.close()
})
await t('hasThread 如实反映"有没有聊过"', async () => {
  const st = newStore()
  const svc = new ChatService({ store: st,
    llm: fakeLlm([answer('答')]), selection: () => ({ provider: 'p', model: 'm' }),
    tools: makeTools([]), systemBase: SKILL,
  })
  assert.equal(svc.hasThread('600519'), false)
  const { runId } = svc.start({ symbol: '600519', text: '开口了' })
  for (let i = 0; i < 100 && !svc.getRun(runId)?.done; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(svc.hasThread('600519'), true)
  svc.close()
})
await t('start（首次发言）才创建线程', async () => {
  const st = newStore()
  const svc = new ChatService({ store: st,
    llm: fakeLlm([answer('答')]), selection: () => ({ provider: 'p', model: 'm' }),
    tools: makeTools([]), systemBase: SKILL,
  })
  assert.equal(st.listThreads({}).length, 0)
  const { runId } = svc.start({ symbol: '600519', text: '第一句' })
  for (let i = 0; i < 100 && !svc.getRun(runId)?.done; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(st.listThreads({}).length, 1, '只有发言过的标的才有线程')
  svc.close()
})
await t('删除未聊过的标的返回 false，且不建线程', () => {
  const st = newStore()
  const svc = new ChatService({ store: st, tools: makeTools([]), systemBase: SKILL })
  assert.equal(svc.deleteThread('601398'), false)
  assert.equal(st.listThreads({}).length, 0)
  svc.close()
})
await t('启动时清理历史遗留的空线程（并报告数量）', () => {
  const st = newStore()
  st.ensureThread('601398')
  st.ensureThread('601939')
  st.ensureThread('600000')
  assert.equal(st.listThreads({}).length, 3)
  let logged = 0
  const svc = new ChatService({ store: st, tools: makeTools([]), systemBase: SKILL,
    logger: { info: () => { logged++ }, warn() {} } })
  assert.equal(st.listThreads({}).length, 0, '构造时应收敛为空')
  assert.equal(logged, 1, '应报告清理过一次')
  svc.close()
})

console.log('服务装配与白名单')
await t('只暴露带 execute 的白名单工具', () => {
  const executed = []
  const svc = new ChatService({ store: newStore(),
    llm: fakeLlm([answer('ok')]),
    selection: () => ({ provider: 'p', model: 'm' }),
    tools: makeTools(executed),
    systemBase: SKILL,
  })
  const names = svc.toolNames()
  assert.deepEqual(names.sort(), ['broken', 'stock_news', 'stock_research_snapshot'])
  assert.ok(!names.includes('not_really_a_tool'), '无 execute 的条目不应该是工具')
  svc.close()
})
await t('toolSchemas 只含白名单，且形状符合 ToolSchema', () => {
  const svc = new ChatService({ store: newStore(), tools: makeTools([]), systemBase: SKILL })
  const schemas = svc.toolSchemas()
  assert.equal(schemas.length, 3)
  for (const s of schemas) {
    assert.ok(s.name && typeof s.description === 'string' && s.parameters)
  }
  svc.close()
})
await t('绝不暴露 agent 自有工具（read/write/bash 之类）', () => {
  const svc = new ChatService({ store: newStore(), tools: makeTools([]), systemBase: SKILL })
  const names = svc.toolNames()
  for (const forbidden of ['read', 'write', 'edit', 'bash', 'pwsh', 'glob', 'grep', 'subagent']) {
    assert.ok(!names.includes(forbidden), '不该出现 agent 工具：' + forbidden)
  }
  svc.close()
})

console.log('\n系统提示词（把约束写死，而不是指望模型自觉）')
await t('包含 skill.md 基线', () => {
  const svc = new ChatService({ store: newStore(), tools: makeTools([]), systemBase: SKILL })
  const sys = svc.buildSystem('SH600519')
  assert.ok(sys.includes('合规红线'), '应包含 skill 内容')
  svc.close()
})
await t('包含"数字必须来自工具"等硬约束', () => {
  const svc = new ChatService({ store: newStore(), tools: makeTools([]), systemBase: SKILL })
  const sys = svc.buildSystem('SH600519')
  for (const kw of ['所有数字必须来自工具返回', '不得改写工具返回的统计量',
    '区分事实与推断', '不要替用户下结论', '不构成投资建议']) {
    assert.ok(sys.includes(kw), '缺少约束：' + kw)
  }
  assert.ok(sys.includes('stock_research_snapshot'), '应建议优先用快照工具')
  svc.close()
})
await t('带当前标的时写明标的，避免用户重复代码', () => {
  const svc = new ChatService({ store: newStore(), tools: makeTools([]), systemBase: SKILL })
  const sys = svc.buildSystem('SH600519')
  assert.ok(sys.includes('SH600519'))
  assert.match(sys, /不要让用户重复代码/)
  svc.close()
})
await t('全局线程给出跨标的的说明', () => {
  const svc = new ChatService({ store: newStore(), tools: makeTools([]), systemBase: SKILL })
  const sys = svc.buildSystem(GLOBAL_THREAD)
  assert.match(sys, /研究主线/)
  assert.ok(!sys.includes('当前标的'), '全局线程不该有"当前标的"段')
  svc.close()
})
await t('skill.md 缺失时仍能对话（只是少方法论约束）', () => {
  const svc = new ChatService({ store: newStore(), tools: makeTools([]), systemBase: '' })
  const sys = svc.buildSystem('SH600519')
  assert.ok(sys.includes('本对话面板的运行约束'), '硬约束仍在')
  svc.close()
})

console.log('\n发送与执行')
await t('一次成功对话：落库用户消息 + 助手回答', async () => {
  const executed = []
  const llm = fakeLlm([toolCall('c1', 'stock_research_snapshot', '{"symbol":"600519"}'), answer('茅台现价 1335')])
  const svc = new ChatService({ store: newStore(),
    llm, selection: () => ({ provider: 'p', model: 'm' }),
    tools: makeTools(executed), systemBase: SKILL,
  })
  const { runId } = svc.start({ symbol: '600519', text: '最近怎么回事' })
  // 等结束
  for (let i = 0; i < 100 && !svc.getRun(runId)?.done; i++) await new Promise((r) => setTimeout(r, 10))
  const run = svc.getRun(runId)
  assert.equal(run.done, true)
  assert.equal(run.result.ok, true)
  assert.equal(run.result.text, '茅台现价 1335')
  assert.deepEqual(executed, [['snapshot', { symbol: '600519' }]])

  const { messages } = svc.listMessages('600519')
  assert.deepEqual(messages.map((m) => m.role), ['user', 'tool', 'assistant'])
  assert.equal(messages[0].content, '最近怎么回事')
  assert.equal(messages[1].content, '{"price":1335}', '工具返回应原样落到历史')
  assert.equal(messages[2].content, '茅台现价 1335')
  assert.equal(messages[2].meta.rounds, 2)
  svc.close()
})
await t('工具调用被记为结构化载荷（回看"当时调了什么"）', async () => {
  const svc = new ChatService({ store: newStore(),
    llm: fakeLlm([toolCall('c1', 'stock_news', '{}'), answer('看新闻')]),
    selection: () => ({ provider: 'p', model: 'm' }),
    tools: makeTools([]), systemBase: SKILL,
  })
  const { runId } = svc.start({ symbol: '600519', text: 'x' })
  for (let i = 0; i < 100 && !svc.getRun(runId)?.done; i++) await new Promise((r) => setTimeout(r, 10))
  const toolMsg = svc.listMessages('600519').messages.find((m) => m.role === 'tool')
  assert.equal(toolMsg.toolCalls[0].name, 'stock_news')
  assert.equal(toolMsg.toolCalls[0].isError, false)
  svc.close()
})
await t('落库顺序符合时间：工具在助手回答之前（回看顺序才对）', async () => {
  // 曾经的 bug：等整轮结束后先写 assistant 再写 tool，于是回看时
  // 变成「答案 → 它用过的工具」，读起来是错的。
  const svc = new ChatService({ store: newStore(),
    llm: fakeLlm([
      [
        // 同一条消息里两个工具调用：必须给**不同的 index**，否则会被按 index 归并成一条
        { type: 'tool-call-delta', index: 0, id: 'c1', name: 'stock_news', argumentsDelta: '{}' },
        { type: 'tool-call-delta', index: 1, id: 'c2', name: 'stock_research_snapshot', argumentsDelta: '{}' },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ],
      answer('综合结论'),
    ]),
    selection: () => ({ provider: 'p', model: 'm' }),
    tools: makeTools([]), systemBase: SKILL,
  })
  const { runId } = svc.start({ symbol: '600519', text: '问' })
  for (let i = 0; i < 100 && !svc.getRun(runId)?.done; i++) await new Promise((r) => setTimeout(r, 10))
  const msgs = svc.listMessages('600519').messages
  const roles = msgs.map((m) => m.role)
  assert.deepEqual(roles, ['user', 'tool', 'tool', 'assistant'], '实际：' + roles.join(','))
  assert.deepEqual(msgs.filter((m) => m.role === 'tool').map((m) => m.toolCalls[0].name),
    ['stock_news', 'stock_research_snapshot'], '两条工具调用都该落库')
  svc.close()
})
await t('存档保留完整工具结果，而给模型的是截断版', async () => {
  // 回灌要短（保护上下文），存档要全（用户回看时不该只看到半截）
  const big = { payload: 'y'.repeat(8000) }
  const tools = new Map([['big_tool', {
    name: 'big_tool', description: 'x', parameters: { type: 'object' },
    execute: async () => big,
  }]])
  const llm = fakeLlm([toolCall('c1', 'big_tool', '{}'), answer('好')])
  const svc = new ChatService({ store: newStore(),
    llm, selection: () => ({ provider: 'p', model: 'm' }),
    tools, systemBase: SKILL,
  })
  const { runId } = svc.start({ symbol: '600519', text: 'x' })
  for (let i = 0; i < 100 && !svc.getRun(runId)?.done; i++) await new Promise((r) => setTimeout(r, 10))
  // 给模型的第二轮请求里应是截断版
  const second = llm.calls[1].messages
  const tr = second.find((m) => m.role === 'tool')
  assert.ok(tr.content[0].text.length < 7000, '给模型的应被截断，实际 ' + tr.content[0].text.length)
  assert.match(tr.content[0].text, /已截断/)
  // 存档应是完整的（约 8000+ 字符）
  const archived = svc.listMessages('600519').messages.find((m) => m.role === 'tool')
  assert.ok(archived.content.length > 7000, '存档应保留完整内容，实际 ' + archived.content.length)
  assert.equal(archived.toolCalls[0].truncatedForModel, true, '应标注"给模型时被截断过"')
  svc.close()
})
await t('工具抛错不中断对话，且错误落库', async () => {
  const svc = new ChatService({ store: newStore(),
    llm: fakeLlm([toolCall('c1', 'broken', '{}'), answer('工具失败了，我换个说法')]),
    selection: () => ({ provider: 'p', model: 'm' }),
    tools: makeTools([]), systemBase: SKILL,
  })
  const { runId } = svc.start({ symbol: '600519', text: 'x' })
  for (let i = 0; i < 100 && !svc.getRun(runId)?.done; i++) await new Promise((r) => setTimeout(r, 10))
  const run = svc.getRun(runId)
  assert.equal(run.result.ok, true)
  const toolMsg = svc.listMessages('600519').messages.find((m) => m.role === 'tool')
  assert.equal(toolMsg.toolCalls[0].isError, true)
  assert.match(toolMsg.content, /上游挂了/)
  svc.close()
})
await t('模型请求不存在的工具 → 如实告知可用工具列表', async () => {
  const svc = new ChatService({ store: newStore(),
    llm: fakeLlm([toolCall('c1', '不存在的工具', '{}'), answer('好的')]),
    selection: () => ({ provider: 'p', model: 'm' }),
    tools: makeTools([]), systemBase: SKILL,
  })
  const { runId } = svc.start({ symbol: '600519', text: 'x' })
  for (let i = 0; i < 100 && !svc.getRun(runId)?.done; i++) await new Promise((r) => setTimeout(r, 10))
  const toolMsg = svc.listMessages('600519').messages.find((m) => m.role === 'tool')
  assert.equal(toolMsg.toolCalls[0].isError, true)
  assert.match(toolMsg.content, /没有名为/)
  assert.match(toolMsg.content, /stock_research_snapshot/, '应列出可用工具')
  svc.close()
})
await t('历史被带上（第二轮的请求里含第一轮内容）', async () => {
  const llm = fakeLlm([answer('第一轮答案'), answer('第二轮答案')])
  const svc = new ChatService({ store: newStore(),
    llm, selection: () => ({ provider: 'p', model: 'm' }),
    tools: makeTools([]), systemBase: SKILL,
  })
  const r1 = svc.start({ symbol: '600519', text: '第一问' })
  for (let i = 0; i < 100 && !svc.getRun(r1.runId)?.done; i++) await new Promise((r) => setTimeout(r, 10))
  const r2 = svc.start({ symbol: '600519', text: '第二问' })
  for (let i = 0; i < 100 && !svc.getRun(r2.runId)?.done; i++) await new Promise((r) => setTimeout(r, 10))
  const second = llm.calls[1].messages
  const texts = second.map((m) => m.content?.[0]?.text)
  assert.ok(texts.includes('第一问'), '应带上第一轮提问')
  assert.ok(texts.includes('第一轮答案'), '应带上第一轮回答')
  assert.equal(texts.at(-1), '第二问')
  svc.close()
})
await t('不同标的的历史互不串台', async () => {
  const llm = fakeLlm([answer('A 的答案'), answer('B 的答案')])
  const svc = new ChatService({ store: newStore(),
    llm, selection: () => ({ provider: 'p', model: 'm' }), tools: makeTools([]), systemBase: SKILL,
  })
  const a = svc.start({ symbol: '600519', text: '茅台问题' })
  for (let i = 0; i < 100 && !svc.getRun(a.runId)?.done; i++) await new Promise((r) => setTimeout(r, 10))
  const b = svc.start({ symbol: '300750', text: '宁德问题' })
  for (let i = 0; i < 100 && !svc.getRun(b.runId)?.done; i++) await new Promise((r) => setTimeout(r, 10))
  const texts = llm.calls[1].messages.map((m) => m.content?.[0]?.text)
  assert.ok(!texts.includes('茅台问题'), '另一个标的的线程不该带到本线程')
  svc.close()
})

console.log('\n失败路径与事件流')
await t('空消息被拒', () => {
  const svc = new ChatService({ store: newStore(), llm: fakeLlm([]), selection: () => ({ provider: 'p', model: 'm' }), tools: makeTools([]) })
  assert.throws(() => svc.start({ symbol: '600519', text: '   ' }), /不能为空/)
  svc.close()
})
await t('未挂载 llm → 明确报错而不是崩溃', () => {
  const svc = new ChatService({ store: newStore(), llm: undefined, selection: () => null, tools: makeTools([]) })
  assert.throws(() => svc.start({ symbol: '600519', text: 'x' }), /llm 服务不可用/)
  svc.close()
})
await t('未选择模型 → 失败信息可操作，且失败也落库', async () => {
  const svc = new ChatService({ store: newStore(),
    llm: fakeLlm([answer('不该被调用')]), selection: () => null,
    tools: makeTools([]), systemBase: SKILL,
  })
  const { runId } = svc.start({ symbol: '600519', text: 'x' })
  for (let i = 0; i < 100 && !svc.getRun(runId)?.done; i++) await new Promise((r) => setTimeout(r, 10))
  const run = svc.getRun(runId)
  assert.equal(run.result.ok, false)
  assert.match(run.result.error, /设置 → 模型/)
  const msgs = svc.listMessages('600519').messages
  assert.equal(msgs[0].content, 'x', '用户消息必须已落库')
  assert.match(msgs[1].content, /本轮未成功/, '失败也要在历史里可见，不能界面报了错、历史却没有')
  svc.close()
})
await t('SSE 事件流可订阅，且能看到 text-delta 与 done', async () => {
  const svc = new ChatService({ store: newStore(),
    llm: fakeLlm([answer('逐字输出')]),
    selection: () => ({ provider: 'p', model: 'm' }), tools: makeTools([]), systemBase: SKILL,
  })
  const { runId } = svc.start({ symbol: '600519', text: 'x' })
  const seen = []
  svc.subscribe(runId, (evt) => seen.push(evt))
  for (let i = 0; i < 100 && !svc.getRun(runId)?.done; i++) await new Promise((r) => setTimeout(r, 10))
  // 订阅可能晚于事件发生，subscribe 会补发已发生的事件
  const types = seen.filter(Boolean).map((e) => e.type)
  assert.ok(types.includes('text-delta'), '应有 text-delta：' + types.join(','))
  assert.ok(types.includes('done'), '应有 done')
  assert.equal(seen.at(-1), null, '流结束以 null 表示')
  svc.close()
})
await t('取消进行中的 run', async () => {
  // 造一个永不结束的流
  const neverEnd = {
    stream: () => (async function* () { yield { type: 'text-delta', text: '开始' }; await new Promise(() => {}) })() ,
  }
  const svc = new ChatService({ store: newStore(),
    llm: neverEnd, selection: () => ({ provider: 'p', model: 'm' }), tools: makeTools([]), systemBase: SKILL,
  })
  const { runId } = svc.start({ symbol: '600519', text: 'x' })
  await new Promise((r) => setTimeout(r, 30))
  const c = svc.cancel(runId)
  assert.equal(c.cancelled, true)
  assert.throws(() => svc.start({ symbol: '600519', text: '' }), /不能为空/)
  const again = svc.cancel('nope')
  assert.equal(again.cancelled, false)
  svc.close()
})

console.log('\n线程管理')
await t('listThreads 只列有对话的线程', async () => {
  const svc = new ChatService({ store: newStore(),
    llm: fakeLlm([answer('ok')]), selection: () => ({ provider: 'p', model: 'm' }),
    tools: makeTools([]), systemBase: SKILL,
  })
  svc.listMessages('601318')   // 只是创建线程，没有说话
  const { runId } = svc.start({ symbol: '600519', text: '说话' })
  for (let i = 0; i < 100 && !svc.getRun(runId)?.done; i++) await new Promise((r) => setTimeout(r, 10))
  const threads = svc.listThreads()
  assert.ok(threads.some((x) => x.symbol === 'SH600519'))
  assert.ok(!threads.some((x) => x.symbol === 'SH601318'), '空线程不该出现在列表')
  svc.close()
})
await t('删除线程连同消息', async () => {
  const svc = new ChatService({ store: newStore(),
    llm: fakeLlm([answer('ok')]), selection: () => ({ provider: 'p', model: 'm' }),
    tools: makeTools([]), systemBase: SKILL,
  })
  const { runId } = svc.start({ symbol: '300750', text: 'x' })
  for (let i = 0; i < 100 && !svc.getRun(runId)?.done; i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(svc.deleteThread('300750'), true)
  assert.equal(svc.listMessages('300750').messages.length, 0)
  svc.close()
})

cleanupTempDir(TEST_HOME)
console.log(`\n${passed} passed`)
