/**
 * smoke-chat-ui.mjs — 右栏对话 UI 的真实调用路径冒烟
 *
 * UI 实际做的四件事，逐一在真实宿主上验证：
 *   1. 切标的 → GET /chat/messages（**只读，不创建**；未聊过要给出空状态数据）
 *   2. 发送   → POST /chat/send → GET /chat/stream?runId=（SSE 逐字 + 工具事件配对）
 *   3. 停止   → POST /chat/cancel（**这条从没在真实环境验证过**）
 *   4. 清空   → POST /chat/delete-thread
 *
 * 运行：node tests/smoke-chat-ui.mjs [baseUrl]
 */

const BASE = process.argv[2] || process.env.DSH_STOCK_LAB_URL || 'http://127.0.0.1:59218'
const SYMBOL = process.env.CHAT_UI_SYMBOL || '600036'   // 用一个此前没聊过的标的

let passed = 0
function ok(n) { passed++; console.log('  ✓ ' + n) }
function bad(n, d) { console.error('  ✗ ' + n + (d ? '\n    ' + d : '')); process.exitCode = 1 }

async function get(path, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : ''
  const j = await (await fetch(BASE + '/stock-lab' + path + qs)).json()
  if (!j.ok) throw new Error(j.error || 'failed')
  return j.data
}
async function post(path, body) {
  const j = await (await fetch(BASE + '/stock-lab' + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  })).json()
  if (!j.ok) throw new Error(j.error || 'failed')
  return j.data
}

/** 开始一次对话并返回流读取器 */
async function begin(text) {
  const { runId } = await post('/chat/send', { symbol: SYMBOL, text })
  const res = await fetch(`${BASE}/stock-lab/chat/stream?runId=${encodeURIComponent(runId)}`, {
    headers: { accept: 'text/event-stream' },
  })
  if (!res.ok || !res.body) throw new Error('SSE HTTP ' + res.status)
  const events = []
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let done = false
  const feed = () => {
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        try { events.push(JSON.parse(line.slice(5).trim())) } catch { /* ignore */ }
      }
    }
  }
  return {
    runId, events,
    async pump() {
      for (;;) {
        const { value, done: d } = await reader.read()
        if (d) { done = true; break }
        buf += dec.decode(value, { stream: true })
        feed()
        if (events.some((e) => e.type === 'done')) { done = true; break }
      }
      return events
    },
    get finished() { return done },
  }
}

console.log(`目标 ${BASE}，标的 ${SYMBOL}`)

// 先清掉这个标的可能存在的历史，保证从干净状态开始
try {
  await post('/chat/delete-thread', { symbol: SYMBOL })
} catch { /* 没有也无妨 */ }

// 1. 空状态数据
try {
  const d = await get('/chat/messages', { symbol: SYMBOL })
  if (d.thread === null && d.messages.length === 0) ok('未聊过的标的：thread=null、0 条消息（UI 据此显示空状态）')
  else bad('空状态数据不对', JSON.stringify({ thread: d.thread, n: d.messages.length }))
} catch (e) { bad('读取空状态', e.message) }

// 2. 换标的只读不建 → 再确认一次仍是空的
try {
  await get('/chat/messages', { symbol: '000651' })
  await get('/chat/messages', { symbol: '002594' })
  const d = await get('/chat/messages', { symbol: SYMBOL })
  if (d.thread === null) ok('浏览其它标的后再回来，仍未创建（懒创建生效）')
  else bad('读操作创建了线程', 'thread=' + JSON.stringify(d.thread))
} catch (e) { bad('懒创建检查', e.message) }

// 3. 发送 + SSE：事件配对与逐字文本
console.log('\n[发送 + SSE]')
let first
try {
  first = await begin('用一句话说明这只股票今天涨跌以及最近的资金流向。')
  await first.pump()
  const types = first.events.map((e) => e.type)
  const text = first.events.filter((e) => e.type === 'text-delta').map((e) => e.text).join('')
  console.log(`  事件：${[...new Set(types)].join(', ')}`)
  console.log(`  回答：${text.replace(/\n/g, ' ').slice(0, 140)}`)
  if (text.trim()) ok('收到逐字文本'); else bad('没有文本')
  const starts = first.events.filter((e) => e.type === 'tool-start')
  const ends = first.events.filter((e) => e.type === 'tool-end')
  if (starts.length === ends.length && starts.length > 0) ok(`tool-start 与 tool-end 配对（各 ${starts.length} 条）`)
  else bad('工具事件不配对', `start=${starts.length} end=${ends.length}`)
  // UI 依靠 name 把 tool-end 配回那条待完成的调用
  const matchable = starts.every((s) => ends.some((x) => x.name === s.name))
  matchable ? ok('tool-end 携带 name，UI 能配对回未完成的调用') : bad('tool-end 缺 name')
  const doneEvt = first.events.find((e) => e.type === 'done')
  if (doneEvt && doneEvt.ok) ok(`正常结束（${doneEvt.rounds} 轮，${doneEvt.toolCallCount} 次工具）`)
  else bad('未正常结束', JSON.stringify(doneEvt))
} catch (e) { bad('发送+SSE', e.message) }

// 4. 落库与权威重载
console.log('\n[落库]')
try {
  const d = await get('/chat/messages', { symbol: SYMBOL })
  const roles = d.messages.map((m) => m.role)
  console.log(`  ${d.messages.length} 条：${roles.join(' → ')}`)
  if (d.thread) ok('线程已建立（首次发言才建）'); else bad('线程未建立')
  if (roles[0] === 'user') ok('第一条是用户消息'); else bad('顺序异常', roles.join(','))
  if (roles.includes('tool')) ok('工具结果落库（可回看当时调了什么）'); else bad('缺工具消息')
  const toolMsg = d.messages.find((m) => m.role === 'tool')
  if (toolMsg && Array.isArray(toolMsg.toolCalls) && toolMsg.toolCalls[0].name) ok('工具消息带结构化 name/args')
  else bad('工具消息缺结构化载荷')
} catch (e) { bad('读取落库消息', e.message) }

// 5. 停止（取消）—— UI 的「停止」按钮走这条路
console.log('\n[停止] 这条从没验证过')
try {
  const run = await begin('详细分析这只股票的估值、行业地位、资金流和近期新闻，尽量长一些。')
  await new Promise((r) => setTimeout(r, 900))          // 等它真的开始跑
  const c = await post('/chat/cancel', { runId: run.runId })
  console.log(`  cancel 返回：${JSON.stringify(c)}`)
  if (c.cancelled) ok('取消请求被接受')
  else if (/已结束/.test(c.reason || '')) ok('该轮已自行结束（取消无需生效）')
  else bad('取消未被接受', JSON.stringify(c))

  // 等它真的收尾（最多 90 秒）
  const deadline = Date.now() + 90000
  while (!run.finished && Date.now() < deadline) await run.pump()
  const doneEvt = run.events.find((e) => e.type === 'done')
  if (run.finished) ok('流已关闭（不会一直挂着）')
  else bad('流在 90 秒内没有关闭')
  if (doneEvt) {
    console.log(`  done：ok=${doneEvt.ok} error=${doneEvt.error || '(无)'}`)
    ok('收到了 done 事件（前端能正确收尾）')
  } else bad('没有收到 done 事件')

  // 取消后历史上应有记录（哪怕是"未成功"），否则界面显示了、历史却没有
  const d = await get('/chat/messages', { symbol: SYMBOL })
  console.log(`  取消后消息数：${d.messages.length}`)
  if (d.messages.length > 0) ok('取消后历史仍完整（不丢已产生的过程）')
  else bad('取消后历史为空')
} catch (e) { bad('停止路径', e.message) }

// 6. 清空记录
console.log('\n[清空]')
try {
  const r = await post('/chat/delete-thread', { symbol: SYMBOL })
  const d = await get('/chat/messages', { symbol: SYMBOL })
  if (r.deleted && d.thread === null && d.messages.length === 0) ok('清空后回到空状态（且不因读取而重建）')
  else bad('清空不彻底', JSON.stringify({ deleted: r.deleted, thread: d.thread, n: d.messages.length }))
} catch (e) { bad('清空路径', e.message) }

console.log(`\n${passed} passed${process.exitCode ? '（有失败）' : ''}`)