/**
 * llm-loop.js — Stock Lab Chat 的多轮工具调用循环
 *
 * 职责：把「用户提问 + 历史」变成「模型流式回答 + 工具调用 + 结果回灌」的循环，
 * 直到模型给出最终答案、或达到轮次上限、或被取消/出错。
 *
 * 设计要点：
 *   1. **依赖全部注入**（stream / executeTool / selection / 消息构造器），
 *      因此可以完全离线测试——包括分片参数拼接、非法 JSON、轮次上限、取消、错误结束。
 *   2. **工具调用是流式分片给出的**：同一 index 的分片必须自己拼成一条完整调用，
 *      否则拿到的是半截 JSON（这一点与 dsh-astock 的实测一致）。
 *   3. **回灌消息的形状可替换**（buildToolResultMessage 等）：
 *      DSH 的类型声明是 `role:'tool'` + 顶层 `toolCallId`，而 dsh-astock 用的是
 *      `role:'user'` + 内容块 `type:'tool-result'`（后者不在 ContentBlockMap 里）。
 *      两条路都可能被适配器接受，因此做成可替换，并靠**真实 LLM 实测**决定用哪条。
 *   4. **任何失败都不吞掉**：模型错误、工具异常、JSON 解析失败都要变成
 *      可见的结果或事件，绝不静默当成功。
 */

/** 默认上限：轮次与单条工具结果字符数（防止把上下文撑爆/死循环） */
export const DEFAULT_MAX_ROUNDS = 6
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 6000

/** 生成一个消息 id（DSH 侧是 branded string，运行时用普通字符串即可） */
function messageId() {
  return 'm_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
}

/**
 * 把一次模型调用流式消费完，返回文本、工具调用与结束原因。
 * @param stream (options) => AsyncIterable<StreamChunk>
 * @param onTextDelta 可选，逐段回调（用于实时推给前端）
 */
export async function consumeStream(stream, options, onTextDelta) {
  let text = ''
  let reasoningChars = 0
  let usage = null
  let finish = null
  const calls = new Map()

  for await (const chunk of stream(options)) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta') {
      text += chunk.text || ''
      if (onTextDelta) onTextDelta(chunk.text || '')
    } else if (chunk.type === 'reasoning-delta') {
      reasoningChars += (chunk.text || '').length
    } else if (chunk.type === 'usage') {
      usage = chunk.usage || null
    } else if (chunk.type === 'finish') {
      finish = chunk.reason || null
    } else if (chunk.type === 'tool-call-delta') {
      // 同一 index 的分片要拼接：id/name 通常只在第一片给出
      const cur = calls.get(chunk.index) || { id: '', name: '', args: '' }
      if (chunk.id) cur.id = String(chunk.id)
      if (chunk.name) cur.name = chunk.name
      cur.args += chunk.argumentsDelta || ''
      calls.set(chunk.index, cur)
    }
  }

  return {
    text,
    reasoningChars,
    usage,
    finish,
    // 缺 id 或 name 的分片是半成品，不能拿去调用
    calls: [...calls.values()].filter((c) => c.id !== '' && c.name !== ''),
  }
}

/** 把模型给的参数片段解析成对象；失败时如实报错，不猜 */
export function parseToolArgs(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return { ok: true, args: {} }
  try {
    const v = JSON.parse(s)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      return { ok: false, error: '工具参数应为 JSON 对象，实际是 ' + (Array.isArray(v) ? '数组' : typeof v) }
    }
    return { ok: true, args: v }
  } catch (e) {
    return { ok: false, error: '工具参数不是合法 JSON：' + (e?.message || e) + '（原文前 200 字：' + s.slice(0, 200) + '）' }
  }
}

/** 截断过长的工具结果，并明确标注被截断（不静默丢内容） */
export function truncateToolResult(text, max = DEFAULT_MAX_TOOL_RESULT_CHARS) {
  const s = typeof text === 'string' ? text : String(text ?? '')
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…（结果过长，已截断：原长 ${s.length} 字符，仅保留前 ${max} 字符。如需完整数据请缩小查询范围）`
}

/**
 * 存档用的更长上限。
 *
 * 为什么要区分两个上限：
 *   - **回灌给模型**的必须短（保护上下文，默认 6000 字符）
 *   - **存进用户档案**的应当尽量完整（用户回看"当时工具到底返回了什么"时，
 *     看到半截内容会误导判断）
 * 因此循环同时给出 `text`（给模型）与 `fullText`（存档），由调用方各取所需。
 */
export const DEFAULT_MAX_ARCHIVE_CHARS = 200000

/** 默认的消息构造器：按 DSH 类型声明（role:'tool' + 顶层 toolCallId） */
export function defaultAssistantToolCallMessage({ calls, text, provider, model }) {
  const content = []
  if (text) content.push({ type: 'text', text })
  for (const c of calls) content.push({ type: 'tool-call', id: c.id, name: c.name, arguments: c.args })
  return { id: messageId(), role: 'assistant', content, source: { kind: 'model', provider, model } }
}

export function defaultToolResultMessage({ call, text, isError }) {
  return {
    id: messageId(),
    role: 'tool',
    toolCallId: call.id,
    content: [{ type: 'text', text }],
    source: { kind: 'tool', callId: call.id },
    isError: isError === true,
  }
}

/**
 * 运行一次多轮工具循环。
 *
 * @param deps.stream      (options) => AsyncIterable<StreamChunk>
 * @param deps.selection   () => { provider, model }
 * @param deps.executeTool async (name, args, call) => { text, isError? } —— 名字未知/抛错都应为 isError
 * @param deps.tools       [{ name, description, parameters }] 传给模型的白名单
 * @param deps.history     [{ role:'user'|'assistant', content: string }] 之前轮次
 * @param deps.userText    本轮用户输入
 * @param deps.system      系统提示词
 * @param deps.onEvent     (evt) => void，事件类型见下方注释
 * @returns { ok, text, rounds, toolCalls, usage, finishKind, error }
 */
export async function runToolLoop(deps) {
  const {
    stream,
    selection,
    executeTool,
    tools = [],
    history = [],
    userText = '',
    system,
    onEvent,
    signal,
    maxRounds = DEFAULT_MAX_ROUNDS,
    maxToolResultChars = DEFAULT_MAX_TOOL_RESULT_CHARS,
    buildAssistantToolCallMessage = defaultAssistantToolCallMessage,
    buildToolResultMessage = defaultToolResultMessage,
    maxTokens,
    temperature,
  } = deps

  const emit = (evt) => { try { onEvent?.(evt) } catch { /* 事件回调不该影响主流程 */ } }

  const sel = selection ? selection() : null
  if (!sel || !sel.provider || !sel.model) {
    return {
      ok: false, text: '', rounds: 0, toolCalls: [],
      error: '没有可用的默认模型。请先在 DSH 的「设置 → 模型」里选择一个模型。',
    }
  }
  const { provider, model } = sel

  // 组装初始消息
  const messages = []
  for (const h of history) {
    if (!h || !h.content) continue
    if (h.role === 'user') {
      messages.push({ id: messageId(), role: 'user', content: [{ type: 'text', text: h.content }], source: { kind: 'user' } })
    } else if (h.role === 'assistant') {
      messages.push({ id: messageId(), role: 'assistant', content: [{ type: 'text', text: h.content }], source: { kind: 'model', provider, model } })
    }
  }
  messages.push({ id: messageId(), role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' } })

  const toolCallsLog = []
  let totalText = ''
  let usage = null
  let rounds = 0

  for (let round = 1; round <= maxRounds; round++) {
    rounds = round
    if (signal?.aborted) {
      return { ok: false, text: totalText, rounds, toolCalls: toolCallsLog, error: '已取消' }
    }
    emit({ type: 'round', round, maxRounds })

    let step
    try {
      step = await consumeStream(stream, {
        provider, model, messages, system, tools,
        signal, maxTokens, temperature,
      }, (t) => emit({ type: 'text-delta', text: t, round }))
    } catch (e) {
      const msg = String(e?.message || e)
      emit({ type: 'error', message: msg })
      return { ok: false, text: totalText, rounds, toolCalls: toolCallsLog, error: '模型调用失败：' + msg }
    }

    if (step.usage) usage = step.usage
    if (step.text) totalText += step.text
    emit({ type: 'round-done', round, text: step.text, finish: step.finish ? step.finish.kind : null })

    const finishKind = step.finish ? step.finish.kind : null
    if (finishKind === 'error') {
      const failure = step.finish.failure || {}
      const msg = '模型调用失败：' + String(failure.message || '未知原因')
      emit({ type: 'error', message: msg })
      return { ok: false, text: totalText, rounds, toolCalls: toolCallsLog, usage, finishKind, error: msg }
    }
    if (finishKind === 'aborted') {
      emit({ type: 'error', message: '模型调用被中断' })
      return { ok: false, text: totalText, rounds, toolCalls: toolCallsLog, usage, finishKind, error: '模型调用被中断' }
    }

    // 没有工具调用 → 这一轮就是最终答案
    if (step.calls.length === 0) {
      return {
        ok: true, text: totalText, rounds, toolCalls: toolCallsLog, usage, finishKind,
      }
    }

    // 把「要调用的工具」写回对话，下一轮模型才看得到
    messages.push(buildAssistantToolCallMessage({ calls: step.calls, text: step.text, provider, model }))

    // 依次执行（串行：工具可能读写同一份状态，且便于顺序呈现）
    for (const call of step.calls) {
      if (signal?.aborted) {
        return { ok: false, text: totalText, rounds, toolCalls: toolCallsLog, error: '已取消' }
      }
      const parsed = parseToolArgs(call.args)
      emit({ type: 'tool-start', id: call.id, name: call.name, argsRaw: call.args })

      let resultText
      let isError = false
      if (!parsed.ok) {
        // 参数不合法是模型的问题，如实回灌让它自己修
        resultText = '工具调用失败：' + parsed.error
        isError = true
      } else {
        try {
          const r = await executeTool(call.name, parsed.args, call)
          resultText = typeof r === 'string' ? r : String(r?.text ?? JSON.stringify(r))
          isError = r?.isError === true
        } catch (e) {
          resultText = '工具执行出错：' + String(e?.message || e)
          isError = true
        }
      }

      const bounded = truncateToolResult(resultText, maxToolResultChars)
      const archived = truncateToolResult(resultText, DEFAULT_MAX_ARCHIVE_CHARS)
      const entry = {
        id: call.id, name: call.name,
        args: parsed.ok ? parsed.args : null, argsRaw: call.args,
        isError, text: bounded, fullText: archived,
        truncated: bounded.length < archived.length,
      }
      toolCallsLog.push(entry)
      emit({ type: 'tool-end', ...entry })

      messages.push(buildToolResultMessage({ call, text: bounded, isError }))
    }

    if (round === maxRounds) {
      const msg = `已达到工具调用轮次上限（${maxRounds} 轮）：模型连续 ${maxRounds} 轮都在调用工具、没有给出答案。`
        + '可能是问题过大或工具结果不理想——可以缩小问题范围（例如先只看一只股票），'
        + '或直接把已得到的工具结果讲给我听。'
      emit({ type: 'error', message: msg })
      return {
        ok: false, text: totalText, rounds, toolCalls: toolCallsLog, usage,
        error: msg,
      }
    }
  }

  // 理论上到不了这里（循环内已处理），保底返回
  return { ok: false, text: totalText, rounds, toolCalls: toolCallsLog, usage, error: '循环异常结束' }
}