/**
 * smoke-chat.mjs — 右栏 Chat 真实链路冒烟（打真实 LLM）
 *
 * 验证三件事：
 *   1. SSE 流式：能逐段收到 text-delta，并以 done 结束
 *   2. 多轮记忆：第二个问题能引用第一个问题的结论（说明历史确实被带上）
 *   3. 工具白名单：只调本插件的工具
 *
 * 运行：node tests/smoke-chat.mjs [baseUrl]
 */

const BASE = process.argv[2] || process.env.DSH_STOCK_LAB_URL || 'http://127.0.0.1:59218'
const SYMBOL = process.env.CHAT_SMOKE_SYMBOL || '600519'

let passed = 0
function ok(name) { passed++; console.log('  ✓ ' + name) }
function bad(name, detail) { console.error('  ✗ ' + name + (detail ? '\n    ' + detail : '')); process.exitCode = 1 }

async function api(path, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : ''
  const res = await fetch(BASE + '/stock-lab' + path + qs, { headers: { accept: 'application/json' } })
  const json = await res.json()
  if (!json.ok) throw new Error(json.error || '请求失败')
  return json.data
}

async function post(path, body) {
  const res = await fetch(BASE + '/stock-lab' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(json.error || '请求失败')
  return json.data
}

/** 发起一次对话并消费 SSE 流 */
async function ask(symbol, text, { timeoutMs = 180000 } = {}) {
  const { runId } = await post('/chat/send', { symbol, text })
  const res = await fetch(`${BASE}/stock-lab/chat/stream?runId=${encodeURIComponent(runId)}`, {
    headers: { accept: 'text/event-stream' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error('SSE HTTP ' + res.status)
  const events = []
  let buf = ''
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString('utf8')
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 2)
      if (!raw.startsWith('data:')) continue
      try { events.push(JSON.parse(raw.slice(5).trim())) } catch { /* 忽略无法解析的行 */ }
    }
    if (events.some((e) => e.type === 'done')) break
  }
  const text2 = events.filter((e) => e.type === 'text-delta').map((e) => e.text).join('')
  const done = events.find((e) => e.type === 'done')
  return { runId, events, text: text2, done }
}

console.log(`目标 ${BASE}，标的 ${SYMBOL}`)

// 0. 服务信息
let info
try {
  info = await api('/chat/info')
  console.log(`  模型：${info.model ? info.model.provider + '/' + info.model.model : '（无）'}`)
  console.log(`  工具白名单：${info.toolCount} 个`)
  if (!info.available) throw new Error('对话服务不可用')
  if (!info.llmMounted) throw new Error('llm 未挂载')
  ok('chat/info 正常（服务可用 + llm 已挂载）')
} catch (e) { bad('chat/info', e.message) }

// 1. 工具白名单不含 agent 工具
if (info) {
  const forbidden = ['read', 'write', 'edit', 'bash', 'pwsh', 'glob', 'grep', 'subagent']
  const leaked = forbidden.filter((f) => (info.tools || []).includes(f))
  leaked.length === 0 ? ok('白名单未泄漏 agent 工具') : bad('白名单泄漏了 agent 工具', leaked.join(','))
}

// 2. 第一轮：需要一个真实工具调用
console.log('\n[第一轮] 需要工具调用的问题')
let first
try {
  first = await ask(SYMBOL, '贵州茅台现在多少钱？只回答现价和涨跌幅，不要解释。')
  const types = [...new Set(first.events.map((e) => e.type))]
  console.log(`  事件类型：${types.join(', ')}`)
  console.log(`  回答：${(first.text || '').replace(/\n/g, ' ').slice(0, 160)}`)
  if (first.text && first.text.trim() !== '') ok('收到逐段文本（SSE 可用）'); else bad('未收到文本', JSON.stringify(types))
  if (first.events.some((e) => e.type === 'text-delta')) ok('有 text-delta 事件'); else bad('无 text-delta')
  if (first.done && first.done.ok) ok(`正常结束（工具调用 ${first.done.toolCallCount} 次，${first.done.rounds} 轮）`)
  else bad('未正常结束', JSON.stringify(first.done))
  if (first.events.some((e) => e.type === 'tool-end')) ok('有工具调用并回灌'); else bad('第一轮没有工具调用')
} catch (e) { bad('第一轮对话', e.message) }

// 3. 第二轮：依赖上一轮的记忆
console.log('\n[第二轮] 依赖上文的问题（验证多轮记忆）')
try {
  const second = await ask(SYMBOL, '刚才你查到的那只股票，它的代码是什么？一句话。')
  console.log(`  回答：${(second.text || '').replace(/\n/g, ' ').slice(0, 160)}`)
  const saysCode = /600519/.test(second.text || '')
  saysCode ? ok('能引用上文（历史确实被带到模型）') : bad('未能引用上文', '回答里没有 600519')
} catch (e) { bad('第二轮对话', e.message) }

// 4. 落库检查
console.log('\n[落库] 会话历史')
try {
  const r = await api('/chat/messages', { symbol: SYMBOL, limit: 50 })
  const roles = r.messages.map((m) => m.role)
  console.log(`  消息数 ${r.messages.length}：${roles.join(' → ')}`)
  if (r.messages.length >= 4) ok('消息已落库'); else bad('消息数不足', String(r.messages.length))
  if (roles.includes('tool')) ok('工具结果已落库（可回看当时调了什么）'); else bad('缺工具消息')
  const withArgs = r.messages.filter((m) => m.role === 'tool' && m.toolCalls && m.toolCalls[0] && m.toolCalls[0].args)
  withArgs.length ? ok('工具调用带有结构化参数') : bad('工具消息缺 args')
  // 顺序：工具应在助手回答之前
  const firstTool = roles.indexOf('tool')
  const firstAssistant = roles.indexOf('assistant')
  if (firstTool >= 0 && firstAssistant >= 0 && firstTool < firstAssistant) ok('落库顺序正确（工具在答案之前）')
  else bad('落库顺序异常', roles.join(','))
} catch (e) { bad('读取落库消息', e.message) }

console.log(`\n${passed} passed${process.exitCode ? '（有失败）' : ''}`)