/**
 * llm-loop.test.mjs — 多轮工具调用循环测试（假 LLM，纯离线）
 * 运行：node tests/llm-loop.test.mjs
 *
 * 覆盖真实会踩的坑：分片参数拼接、非法 JSON、工具抛错、轮次上限、
 * 取消、模型错误结束、token 截断、消息形状。
 */
import { strict as assert } from 'node:assert'

const {
  runToolLoop, consumeStream, parseToolArgs, truncateToolResult,
  defaultAssistantToolCallMessage, defaultToolResultMessage,
  DEFAULT_MAX_ROUNDS, DEFAULT_MAX_TOOL_RESULT_CHARS,
} = await import('../src/services/chat-service/llm-loop.js')

let passed = 0
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

const SELECTION = () => ({ provider: 'fake-provider', model: 'fake-model' })
const TOOLS = [{ name: 'stock_quote', description: '报价', parameters: { type: 'object' } }]

/** 造一个"按脚本回答"的假 stream：script 是每一轮要吐出的 chunk 列表 */
function scriptedStream(scripts) {
  let i = 0
  const calls = []
  const stream = (options) => {
    calls.push(options)
    const chunks = scripts[i] || [{ type: 'finish', reason: { kind: 'stop' } }]
    i++
    return (async function* () {
      for (const c of chunks) yield c
    })()
  }
  stream.calls = calls
  return stream
}
/** 分片形式的一条工具调用 */
function toolCallChunks(index, id, name, argsStr, pieces = 1) {
  const out = []
  const step = Math.ceil(argsStr.length / pieces)
  for (let p = 0; p < pieces; p++) {
    out.push({
      type: 'tool-call-delta', index,
      id: p === 0 ? id : undefined,
      name: p === 0 ? name : undefined,
      argumentsDelta: argsStr.slice(p * step, (p + 1) * step),
    })
  }
  return out
}

console.log('consumeStream：分片拼接')
await t('文本分片累加，并逐段回调', async () => {
  const seen = []
  const stream = () => (async function* () {
    yield { type: 'text-delta', text: '你好' }
    yield { type: 'text-delta', text: '，世界' }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }
    yield { type: 'reasoning-delta', text: '想一想' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
  const r = await consumeStream(stream, {}, (t) => seen.push(t))
  assert.equal(r.text, '你好，世界')
  assert.deepEqual(seen, ['你好', '，世界'])
  assert.equal(r.usage.totalTokens, 15)
  assert.equal(r.finish.kind, 'stop')
  assert.equal(r.reasoningChars, 3)
})
await t('同一 index 的工具调用分片被拼成完整一条', async () => {
  const stream = () => (async function* () {
    yield* toolCallChunks(0, 'call_1', 'stock_quote', '{"symbols":["600519"]}', 3)
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  })()
  const r = await consumeStream(stream, {}, null)
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].id, 'call_1')
  assert.equal(r.calls[0].name, 'stock_quote')
  assert.equal(r.calls[0].args, '{"symbols":["600519"]}')
})
await t('多个 index 分成多条调用', async () => {
  const stream = () => (async function* () {
    yield* toolCallChunks(0, 'c0', 'a', '{"x":1}')
    yield* toolCallChunks(1, 'c1', 'b', '{"y":2}')
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  })()
  const r = await consumeStream(stream, {}, null)
  assert.equal(r.calls.length, 2)
  assert.deepEqual(r.calls.map((c) => c.name), ['a', 'b'])
})
await t('缺 id 或 name 的半成品分片被丢弃（不能拿去调用）', async () => {
  const stream = () => (async function* () {
    yield { type: 'tool-call-delta', index: 0, argumentsDelta: '{"partial":' }
    yield { type: 'tool-call-delta', index: 1, id: 'ok', name: 'good', argumentsDelta: '{}' }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  })()
  const r = await consumeStream(stream, {}, null)
  assert.equal(r.calls.length, 1)
  assert.equal(r.calls[0].name, 'good')
})
await t('忽略畸形 chunk（不崩）', async () => {
  const stream = () => (async function* () {
    yield null
    yield undefined
    yield 'not-an-object'
    yield { type: 'unknown-type', foo: 1 }
    yield { type: 'text-delta', text: 'ok' }
  })()
  const r = await consumeStream(stream, {}, null)
  assert.equal(r.text, 'ok')
})

console.log('\nparseToolArgs：参数解析')
await t('合法 JSON 解析成功', () => {
  const r = parseToolArgs('{"a":1}')
  assert.equal(r.ok, true)
  assert.equal(r.args.a, 1)
})
await t('空字符串视为无参数', () => {
  assert.deepEqual(parseToolArgs(''), { ok: true, args: {} })
  assert.deepEqual(parseToolArgs('   '), { ok: true, args: {} })
  assert.deepEqual(parseToolArgs(undefined), { ok: true, args: {} })
})
await t('非法 JSON 如实报错并附原文片段（不猜）', () => {
  const r = parseToolArgs('{"a":1,}')
  assert.equal(r.ok, false)
  assert.match(r.error, /不是合法 JSON/)
  assert.match(r.error, /\{"a":1,\}/)
})
await t('JSON 是数组或标量时拒绝（工具参数必须是对象）', () => {
  assert.match(parseToolArgs('[1,2]').error, /应为 JSON 对象/)
  assert.match(parseToolArgs('123').error, /应为 JSON 对象/)
})

console.log('\ntruncateToolResult：截断')
await t('短文本原样返回', () => {
  assert.equal(truncateToolResult('abc', 10), 'abc')
})
await t('超长文本截断并标注原长（不静默丢）', () => {
  const out = truncateToolResult('x'.repeat(100), 10)
  assert.ok(out.startsWith('x'.repeat(10)))
  assert.match(out, /已截断/)
  assert.match(out, /原长 100 字符/)
})

console.log('\nrunToolLoop：正常路径')
await t('无工具调用 → 一轮给出答案', async () => {
  const stream = scriptedStream([[
    { type: 'text-delta', text: '直接回答' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]])
  const r = await runToolLoop({
    stream, selection: SELECTION, tools: TOOLS, history: [], userText: '你好',
    executeTool: async () => ({ text: 'unused' }),
  })
  assert.equal(r.ok, true)
  assert.equal(r.text, '直接回答')
  assert.equal(r.rounds, 1)
  assert.equal(r.toolCalls.length, 0)
})
await t('一次工具调用后给出答案（两轮）', async () => {
  const stream = scriptedStream([
    [...toolCallChunks(0, 'c1', 'stock_quote', '{"symbols":["600519"]}'), { type: 'finish', reason: { kind: 'tool-calls' } }],
    [{ type: 'text-delta', text: '茅台现价 1335' }, { type: 'finish', reason: { kind: 'stop' } }],
  ])
  const executed = []
  const r = await runToolLoop({
    stream, selection: SELECTION, tools: TOOLS, history: [], userText: '茅台多少钱',
    executeTool: async (name, args) => { executed.push([name, args]); return { text: '{"price":1335}' } },
  })
  assert.equal(r.ok, true)
  assert.equal(r.rounds, 2)
  assert.deepEqual(executed, [['stock_quote', { symbols: ['600519'] }]])
  assert.equal(r.toolCalls.length, 1)
  assert.equal(r.toolCalls[0].isError, false)
  assert.equal(r.text, '茅台现价 1335')
})
await t('多轮多次工具调用（3 轮）', async () => {
  const stream = scriptedStream([
    [...toolCallChunks(0, 'c1', 'a', '{}'), { type: 'finish', reason: { kind: 'tool-calls' } }],
    [...toolCallChunks(0, 'c2', 'b', '{}'), { type: 'finish', reason: { kind: 'tool-calls' } }],
    [{ type: 'text-delta', text: '完成' }, { type: 'finish', reason: { kind: 'stop' } }],
  ])
  const r = await runToolLoop({
    stream, selection: SELECTION, tools: TOOLS, history: [], userText: 'x',
    executeTool: async () => ({ text: 'ok' }),
  })
  assert.equal(r.ok, true)
  assert.equal(r.rounds, 3)
  assert.deepEqual(r.toolCalls.map((c) => c.name), ['a', 'b'])
})
await t('历史消息被带上（多轮上下文）', async () => {
  const stream = scriptedStream([[{ type: 'finish', reason: { kind: 'stop' } }]])
  await runToolLoop({
    stream, selection: SELECTION, tools: TOOLS,
    history: [{ role: 'user', content: '之前问过 A' }, { role: 'assistant', content: '之前答过 B' }],
    userText: '继续',
    executeTool: async () => ({ text: '' }),
  })
  const sent = stream.calls[0].messages
  assert.equal(sent.length, 3, '两条历史 + 本轮')
  assert.equal(sent[0].content[0].text, '之前问过 A')
  assert.equal(sent[1].role, 'assistant')
  assert.equal(sent[1].source.kind, 'model')
  assert.equal(sent[2].content[0].text, '继续')
})

console.log('\nrunToolLoop：消息形状（决定 provider 能否接受）')
await t('assistant 消息把工具调用作为 tool-call 内容块，arguments 保持原始字符串', async () => {
  const stream = scriptedStream([
    [...toolCallChunks(0, 'c1', 'stock_quote', '{"symbols":["600519"]}'), { type: 'finish', reason: { kind: 'tool-calls' } }],
    [{ type: 'text-delta', text: '好' }, { type: 'finish', reason: { kind: 'stop' } }],
  ])
  await runToolLoop({
    stream, selection: SELECTION, tools: TOOLS, history: [], userText: 'x',
    executeTool: async () => ({ text: 'ok' }),
  })
  const second = stream.calls[1].messages
  const assistant = second.find((m) => m.role === 'assistant' && m.content.some((c) => c.type === 'tool-call'))
  assert.ok(assistant, '应写入一条带 tool-call 的 assistant 消息')
  const block = assistant.content.find((c) => c.type === 'tool-call')
  assert.equal(block.id, 'c1')
  assert.equal(block.name, 'stock_quote')
  assert.equal(typeof block.arguments, 'string', 'arguments 必须是字符串（类型声明如此）')
  assert.equal(block.arguments, '{"symbols":["600519"]}')
  assert.equal(assistant.source.kind, 'model')
  assert.equal(assistant.source.provider, 'fake-provider')
})
await t('默认工具结果消息用 role:tool + 顶层 toolCallId（按类型声明）', () => {
  const m = defaultToolResultMessage({ call: { id: 'c1' }, text: '结果', isError: false })
  assert.equal(m.role, 'tool')
  assert.equal(m.toolCallId, 'c1')
  assert.equal(m.content[0].type, 'text')
  assert.equal(m.source.kind, 'tool')
  assert.equal(m.source.callId, 'c1')
  assert.equal(m.isError, false)
})
await t('消息形状可替换（两条路都能走）', async () => {
  // dsh-astock 用的是 role:'user' + 内容块 tool-result，这里验证替换器生效
  const alt = ({ call, text, isError }) => ({
    id: 'alt', role: 'user',
    content: [{ type: 'tool-result', toolCallId: call.id, content: [{ type: 'text', text }], isError }],
    source: { kind: 'tool', callId: call.id },
  })
  const stream = scriptedStream([
    [...toolCallChunks(0, 'c1', 'a', '{}'), { type: 'finish', reason: { kind: 'tool-calls' } }],
    [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }],
  ])
  await runToolLoop({
    stream, selection: SELECTION, tools: TOOLS, history: [], userText: 'x',
    executeTool: async () => ({ text: 'r' }),
    buildToolResultMessage: alt,
  })
  const second = stream.calls[1].messages
  const tr = second.find((m) => m.content?.[0]?.type === 'tool-result')
  assert.ok(tr, '替换后的形状应被使用')
  assert.equal(tr.role, 'user')
})
await t('运行结果里同时报告工具输出文本（便于持久化与回看）', async () => {
  const stream = scriptedStream([
    [...toolCallChunks(0, 'c1', 'a', '{}'), { type: 'finish', reason: { kind: 'tool-calls' } }],
    [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }],
  ])
  const r = await runToolLoop({
    stream, selection: SELECTION, tools: TOOLS, history: [], userText: 'x',
    executeTool: async () => ({ text: '工具返回的正文' }),
  })
  assert.equal(r.toolCalls[0].text, '工具返回的正文')
})

console.log('\nrunToolLoop：失败与边界')
await t('工具抛错 → 变成错误结果回灌，不中断循环', async () => {
  const stream = scriptedStream([
    [...toolCallChunks(0, 'c1', 'boom', '{}'), { type: 'finish', reason: { kind: 'tool-calls' } }],
    [{ type: 'text-delta', text: '工具失败了，我换个说法' }, { type: 'finish', reason: { kind: 'stop' } }],
  ])
  const r = await runToolLoop({
    stream, selection: SELECTION, tools: TOOLS, history: [], userText: 'x',
    executeTool: async () => { throw new Error('上游超时') },
  })
  assert.equal(r.ok, true, '工具失败不该让整轮失败')
  assert.equal(r.toolCalls[0].isError, true)
  assert.match(r.toolCalls[0].text, /上游超时/)
  const second = stream.calls[1].messages
  const tr = second.find((m) => m.role === 'tool')
  assert.equal(tr.isError, true, '回灌时要标记为错误')
})
await t('参数非法 → 如实回灌让模型自己修', async () => {
  const stream = scriptedStream([
    [...toolCallChunks(0, 'c1', 'a', '{"broken":'), { type: 'finish', reason: { kind: 'tool-calls' } }],
    [{ type: 'text-delta', text: '我修正参数' }, { type: 'finish', reason: { kind: 'stop' } }],
  ])
  let called = false
  const r = await runToolLoop({
    stream, selection: SELECTION, tools: TOOLS, history: [], userText: 'x',
    executeTool: async () => { called = true; return { text: '' } },
  })
  assert.equal(called, false, '参数非法时不应执行工具')
  assert.equal(r.toolCalls[0].isError, true)
  assert.match(r.toolCalls[0].text, /不是合法 JSON/)
  assert.equal(r.toolCalls[0].args, null, '解析失败的参数记为 null，不假装有值')
})
await t('模型以 error 结束 → 整轮失败并带原因', async () => {
  const stream = scriptedStream([[
    { type: 'text-delta', text: '半截' },
    { type: 'finish', reason: { kind: 'error', failure: { message: '额度不足', code: 'insufficient' } } },
  ]])
  const r = await runToolLoop({
    stream, selection: SELECTION, tools: TOOLS, history: [], userText: 'x',
    executeTool: async () => ({ text: '' }),
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /额度不足/)
  assert.equal(r.text, '半截', '已产出的内容仍应保留')
})
await t('模型以 aborted 结束 → 报告被中断', async () => {
  const stream = scriptedStream([[{ type: 'finish', reason: { kind: 'aborted' } }]])
  const r = await runToolLoop({
    stream, selection: SELECTION, tools: TOOLS, history: [], userText: 'x',
    executeTool: async () => ({ text: '' }),
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /中断/)
})
await t('stream 抛错 → 报告模型调用失败（不吞）', async () => {
  const stream = () => (async function* () { throw new Error('连接被重置') })()
  const r = await runToolLoop({
    stream, selection: SELECTION, tools: TOOLS, history: [], userText: 'x',
    executeTool: async () => ({ text: '' }),
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /连接被重置/)
})
await t('达到轮次上限 → 明确告知并给可执行建议', async () => {
  const stream = scriptedStream(new Array(10).fill(
    [...toolCallChunks(0, 'c', 'a', '{}'), { type: 'finish', reason: { kind: 'tool-calls' } }],
  ))
  const r = await runToolLoop({
    stream, selection: SELECTION, tools: TOOLS, history: [], userText: 'x',
    executeTool: async () => ({ text: 'ok' }),
    maxRounds: 3,
  })
  assert.equal(r.ok, false)
  assert.equal(r.rounds, 3)
  assert.match(r.error, /轮次上限/)
  assert.match(r.error, /缩小问题范围/, '应给出可执行的下一步建议')
  assert.equal(stream.calls.length, 3, '不应超出上限')
})
await t('未选择模型 → 给出可操作的提示', async () => {
  const r = await runToolLoop({
    stream: scriptedStream([]), selection: () => null, tools: TOOLS, history: [], userText: 'x',
    executeTool: async () => ({ text: '' }),
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /设置 → 模型/)
})
await t('取消：预置 abort 时立即返回', async () => {
  const ac = new AbortController()
  ac.abort()
  const r = await runToolLoop({
    stream: scriptedStream([]), selection: SELECTION, tools: TOOLS, history: [], userText: 'x',
    executeTool: async () => ({ text: '' }), signal: ac.signal,
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /取消/)
})
await t('超长工具结果被截断后才回灌（保护上下文）', async () => {
  const stream = scriptedStream([
    [...toolCallChunks(0, 'c1', 'a', '{}'), { type: 'finish', reason: { kind: 'tool-calls' } }],
    [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }],
  ])
  const r = await runToolLoop({
    stream, selection: SELECTION, tools: TOOLS, history: [], userText: 'x',
    executeTool: async () => ({ text: 'z'.repeat(5000) }),
    maxToolResultChars: 100,
  })
  assert.ok(r.toolCalls[0].text.length < 300, '给模型的应是截断版')
  assert.equal(r.toolCalls[0].truncated, true, '应标注被截断过')
  assert.ok(r.toolCalls[0].fullText.length >= 5000, 'fullText 应保留完整内容供存档')
  const second = stream.calls[1].messages
  const tr = second.find((m) => m.role === 'tool')
  assert.ok(tr.content[0].text.length < 300)
  assert.match(tr.content[0].text, /已截断/)
})
await t('结果不长时 text 与 fullText 相同，且不标截断', async () => {
  const stream = scriptedStream([
    [...toolCallChunks(0, 'c1', 'a', '{}'), { type: 'finish', reason: { kind: 'tool-calls' } }],
    [{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }],
  ])
  const r = await runToolLoop({
    stream, selection: SELECTION, tools: TOOLS, history: [], userText: 'x',
    executeTool: async () => ({ text: '短结果' }),
  })
  assert.equal(r.toolCalls[0].text, '短结果')
  assert.equal(r.toolCalls[0].fullText, '短结果')
  assert.equal(r.toolCalls[0].truncated, false)
})

console.log('\nrunToolLoop：事件流（供前端实时显示）')
await t('事件顺序：round → text-delta → round-done → tool-start → tool-end', async () => {
  const events = []
  const stream = scriptedStream([
    [...toolCallChunks(0, 'c1', 'a', '{}'), { type: 'finish', reason: { kind: 'tool-calls' } }],
    [{ type: 'text-delta', text: '答案' }, { type: 'finish', reason: { kind: 'stop' } }],
  ])
  await runToolLoop({
    stream, selection: SELECTION, tools: TOOLS, history: [], userText: 'x',
    executeTool: async () => ({ text: 'r' }),
    onEvent: (e) => events.push(e.type),
  })
  assert.deepEqual(events, [
    'round', 'round-done', 'tool-start', 'tool-end',
    'round', 'text-delta', 'round-done',
  ])
})
await t('事件回调抛错不影响主流程', async () => {
  const stream = scriptedStream([[{ type: 'text-delta', text: 'ok' }, { type: 'finish', reason: { kind: 'stop' } }]])
  const r = await runToolLoop({
    stream, selection: SELECTION, tools: TOOLS, history: [], userText: 'x',
    executeTool: async () => ({ text: '' }),
    onEvent: () => { throw new Error('前端断了') },
  })
  assert.equal(r.ok, true)
})

console.log(`\n${passed} passed  (默认上限：${DEFAULT_MAX_ROUNDS} 轮 / ${DEFAULT_MAX_TOOL_RESULT_CHARS} 字符)`)