/**
 * chat-service/index.js — Stock Lab Chat 服务
 *
 * 把三样东西接起来：
 *   chat-store（对话过程）· ctx.llm（模型）· 本插件自有的工具白名单（工具执行）
 *
 * 三条刻意的设计约束：
 *
 * 1. **工具白名单，不是"所有可见工具"**。
 *    `ctx.tools.schemas()` 会带上 agent 自有的 read/write/bash 等工具——那些绝不该
 *    出现在一个聊天面板里。因此这里只暴露本插件注册的 27 个研究工具（由 apply 收集传入）。
 *
 * 2. **数字只能来自工具**。系统提示词明确禁止模型心算或凭记忆报数；
 *    工具返回里已有的统计量不得改写。这是项目原则 3 在"自建 Chat"里的落地
 *    （此前插件代码零 LLM 调用，自建 Chat 是第一次引入，必须把约束写进提示词）。
 *
 * 3. **不自动落笔结论**。对话只保存过程；形成 Research Note 必须由用户确认
 *    （避免模型替用户下判断）。
 *
 * 运行状态（进行中的 run）只存在内存里，不落库——重启后未完成的对话如实消失，
 * 不假装它还在。
 */

import { ChatStore, GLOBAL_THREAD, normSymbol } from './chat-store.js'
import { runToolLoop, DEFAULT_MAX_ROUNDS } from './llm-loop.js'

export { GLOBAL_THREAD, DEFAULT_MAX_ROUNDS }

/** 每个 run 保留的事件上限（防止一次超长对话把内存吃满） */
const MAX_EVENTS_PER_RUN = 2000
/** 已完成的 run 在内存里的保留数量 */
const MAX_FINISHED_RUNS = 20

export class ChatService {
  /**
   * @param deps.store    ChatStore
   * @param deps.llm      ctx.get('llm')
   * @param deps.selection () => {provider, model}  （ctx.get('agentDefaultModel').currentSelection）
   * @param deps.tools    Map<name, {description, parameters, execute}>
   * @param deps.systemBase  系统提示词基线（skill.md 全文）
   * @param deps.logger
   * @param deps.market   可选，用于把当前标的的名字补进提示词
   */
  constructor(deps = {}) {
    this.store = deps.store || new ChatStore()
    this.llm = deps.llm
    this.selection = deps.selection || (() => null)
    this.tools = deps.tools instanceof Map ? deps.tools : new Map()
    this.systemBase = String(deps.systemBase || '')
    this.logger = deps.logger || { info() {}, warn() {} }
    this.market = deps.market || null
    this.runs = new Map()      // runId → run 状态
    this.finishedOrder = []

    // 清理历史遗留的空线程。
    // 早期实现把读路径也做成了"确保存在"，于是每浏览一个标的就留下一个空线程；
    // 这里启动时清一次，并如实报告清理了多少条。
    try {
      const pruned = this.store.pruneEmptyThreads()
      if (pruned > 0) this.logger?.info?.('stock-lab: 清理了 %d 条无消息的空对话线程', pruned)
    } catch (e) {
      this.logger?.warn?.('stock-lab: 清理空线程失败 %s', e?.message || e)
    }
  }

  // ── 只读查询 ─────────────────────────────────────────
  //
  // ⚠️ 读路径一律用 findThread（**不创建**）。
  // 懒创建原则：只有真的在右栏输入内容（start）才建线程。
  // 否则前端每次切标的都会调 listMessages，就会为每只浏览过的股票留下空线程。

  listThreads(opts) { return this.store.listActiveThreads(opts) }
  listAllThreads(opts) { return this.store.listThreads(opts) }

  /** 读消息。线程不存在时返回 null 线程 + 空消息，而不是顺手建一个 */
  listMessages(symbol, opts) {
    const th = this.store.findThread(symbol)
    if (!th) return { thread: null, symbol: normSymbol(symbol), messages: [] }
    return { thread: th, messages: this.store.listMessages(th.id, opts) }
  }

  /** 某标的是否已有对话（供 UI 决定显示"还没有对话"还是历史） */
  hasThread(symbol) { return this.store.findThread(symbol) !== null }

  stats() { return this.store.stats() }

  /** 删除线程。不存在时返回 false，而不是先建一个再删 */
  deleteThread(symbol) {
    const th = this.store.findThread(symbol)
    if (!th) return false
    return this.store.deleteThread(th.id)
  }

  /** 可调用的工具名（与 toolSchemas 用**同一**过滤条件，避免"报 4 个其实只有 3 个能用"） */
  toolNames() {
    return [...this.tools.entries()]
      .filter(([, def]) => def && typeof def.execute === 'function')
      .map(([name]) => name)
  }

  /** 供模型使用的工具 schema（**只含白名单**）。非函数型的定义会被过滤掉。 */
  toolSchemas() {
    const out = []
    for (const [name, def] of this.tools) {
      if (!def || typeof def.execute !== 'function') continue
      out.push({ name, description: def.description || name, parameters: def.parameters || { type: 'object' } })
    }
    return out
  }

  // ── 系统提示词 ───────────────────────────────────────

  /**
   * 组装系统提示词：skill.md 基线 + 当前标的 + 本 Chat 特有的硬约束。
   * 把"必须调工具"写在这里，而不是指望模型自觉。
   */
  buildSystem(symbol) {
    const parts = []
    if (this.systemBase) parts.push(this.systemBase)
    parts.push([
      '## 本对话面板的运行约束（硬性）',
      '',
      '1. **所有数字必须来自工具返回**。不得凭记忆报价格、财务、涨跌幅；不得心算收益率、波动率、',
      '   超额收益、t 统计量等——这些工具都已经算好了。工具没返回的数字，就说"没有这个数据"。',
      '2. **不得改写工具返回的统计量**。工具给的是 2.93σ，就不要说成"约 3 倍标准差"。',
      '3. **区分事实与推断**：事实来自工具；"可能的原因"必须明确标为推测，并说明依据与反证。',
      '4. **不要替用户下结论**。不要给买卖建议、不要预测涨跌、不要下"好/差"的判断。',
      '   要形成研究结论时，提示用户可以保存为研究笔记（由用户确认）。',
      '5. **本对话不构成投资建议**，涉及个股的回答末尾附一行免责声明。',
      '6. 工具调用失败时如实说明失败原因，不要用记忆里的数字补齐。',
      '',
      '## 建议的工作方式',
      '',
      '- 问"这只股票最近怎么了/为什么"：先调 `stock_research_snapshot`（一次拿到行情+行业+',
      '  相对强弱+资金流+财务+新闻+代码判定的异常），再按需补 `stock_news`。',
      '- 不要逐个调用底层工具去拼装快照，快照工具就是为此存在的。',
      '- 引用异常时用 `anomalies` 里的原始数值，那是代码判定的结果，不是你猜的。',
    ].join('\n'))

    if (symbol && symbol !== GLOBAL_THREAD) {
      // 读路径：用 findThread（不创建）。没有线程时标题就用代码本身，
      // 绝不因为"要拿个标题"而顺手建一个空线程。
      let title = symbol
      try {
        const t = this.store.findThread(symbol)
        if (t && t.title) title = t.title
      } catch { /* ignore */ }
      parts.push([
        '## 当前标的',
        '',
        `用户正在研究：**${title}**（${symbol}）。`,
        '用户说"这只/它/最近怎么回事"时指的就是它，直接分析，不要让用户重复代码。',
      ].join('\n'))
    } else {
      parts.push([
        '## 当前上下文',
        '',
        '这是**研究主线**对话（不属于某一只股票），适合跨标的的问题：',
        '例如"今天哪个行业最强""比较两只股票""最近市场状态如何"。',
      ].join('\n'))
    }
    return parts.join('\n\n')
  }

  // ── 发送与流式 ───────────────────────────────────────

  /**
   * 发起一次对话。**立即返回 runId**，实际工作在后台跑，事件通过 SSE 推出。
   * 这样前端可以先打开流、再看到逐字输出。
   */
  start({ symbol = GLOBAL_THREAD, text }) {
    const content = String(text || '').trim()
    if (content === '') throw new Error('消息内容不能为空')
    if (!this.llm) throw new Error('llm 服务不可用（宿主未挂载 llm）')

    const thread = this.store.ensureThread(symbol)
    const runId = 'run_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
    const run = {
      id: runId,
      threadId: thread.id,
      symbol: thread.symbol,
      events: [],
      subscribers: new Set(),
      done: false,
      aborted: false,
      controller: new AbortController(),
      result: null,
      startedAt: new Date().toISOString(),
    }
    this.runs.set(runId, run)
    this._trimFinished()

    // 落库：用户这条消息立刻存，哪怕后面模型失败也不会丢
    this.store.appendMessage(thread.id, { role: 'user', content })

    // 后台执行
    this._execute(run, content).catch((e) => {
      this._emit(run, { type: 'error', message: String(e?.message || e) })
      this._finish(run, { ok: false, error: String(e?.message || e) })
    })

    return { runId, thread }
  }

  async _execute(run, userText) {
    // 历史：取该线程当前的消息（**已包含刚存的这条 user 消息**，故最后一条要排除）
    const all = this.store.listMessages(run.threadId, { limit: 200 })
    const history = all
      .slice(0, -1)   // 去掉刚追加的本轮提问
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, content: m.content }))

    const result = await runToolLoop({
      stream: (options) => this.llm.stream(options),
      selection: () => this.selection(),
      system: this.buildSystem(run.symbol || GLOBAL_THREAD),
      history,
      userText,
      tools: this.toolSchemas(),
      signal: run.controller.signal,
      // 工具结果**在发生的当下就落库**，而不是等整轮结束后补写。
      // 原因：工具调用发生在答案之前，若最后统一追加，回看时顺序会变成
      // 「答案 → 它用过的工具」，读起来是错的；而且长对话中途刷新也能看到进度。
      onEvent: (evt) => {
        if (evt && evt.type === 'tool-end') {
          try {
            this.store.appendMessage(run.threadId, {
              role: 'tool',
              // 存档用完整文本（回灌给模型的可能是截断版）
              content: evt.fullText ?? evt.text,
              toolCalls: [{
                name: evt.name, args: evt.args, argsRaw: evt.argsRaw,
                isError: evt.isError, truncatedForModel: evt.truncated === true,
              }],
              meta: { source: 'chat' },
            })
          } catch (e) {
            this.logger?.warn?.('stock-lab: 工具结果落库失败 %s', e?.message || e)
          }
        }
        this._emit(run, evt)
      },
      executeTool: async (name, args) => {
        const def = this.tools.get(name)
        if (!def || typeof def.execute !== 'function') {
          return { text: `没有名为 ${name} 的工具。可用工具：${this.toolNames().join('、')}`, isError: true }
        }
        const out = await def.execute(args, { callId: run.id })
        // 工具返回统一转成文本（对象则 JSON 化），避免把非字符串塞进对话
        const text = typeof out === 'string' ? out : JSON.stringify(out)
        return { text, isError: false }
      },
    })

    // 助手回答最后落库（时间上它确实产生在工具之后）
    if (result.text) {
      this.store.appendMessage(run.threadId, {
        role: 'assistant',
        content: result.text,
        meta: { rounds: result.rounds, usage: result.usage || null, finishKind: result.finishKind || null },
      })
    }
    // 失败时也存一条，免得"界面显示了错误、历史里却没有"
    if (!result.ok && !result.text && result.error) {
      this.store.appendMessage(run.threadId, {
        role: 'assistant',
        content: '（本轮未成功：' + result.error + '）',
        meta: { error: true },
      })
    }

    this._finish(run, result)
  }

  /** 取消一次进行中的 run */
  cancel(runId) {
    const run = this.runs.get(String(runId))
    if (!run) return { cancelled: false, reason: 'run 不存在或已结束' }
    if (run.done) return { cancelled: false, reason: 'run 已结束' }
    run.aborted = true
    try { run.controller.abort() } catch { /* ignore */ }
    return { cancelled: true }
  }

  _emit(run, evt) {
    const item = { ...evt, at: new Date().toISOString() }
    if (run.events.length < MAX_EVENTS_PER_RUN) run.events.push(item)
    for (const fn of [...run.subscribers]) {
      try { fn(item) } catch { /* 单个订阅者出错不影响其它订阅者 */ }
    }
  }

  _finish(run, result) {
    run.done = true
    run.result = result
    this._emit(run, {
      type: 'done',
      ok: result.ok === true,
      rounds: result.rounds,
      toolCallCount: (result.toolCalls || []).length,
      error: result.error || null,
      usage: result.usage || null,
    })
    for (const fn of [...run.subscribers]) {
      try { fn(null) } catch { /* ignore */ }   // null 表示流结束
    }
    run.subscribers.clear()
    this.finishedOrder.push(run.id)
  }

  _trimFinished() {
    while (this.finishedOrder.length > MAX_FINISHED_RUNS) {
      const id = this.finishedOrder.shift()
      const r = this.runs.get(id)
      if (r && r.done && r.subscribers.size === 0) this.runs.delete(id)
      else this.finishedOrder.push(id)  // 还有订阅者，保留
      if (this.finishedOrder.length > MAX_FINISHED_RUNS * 2) break
    }
  }

  /** 订阅一个 run 的事件（会先补发已发生的事件，再接收后续） */
  subscribe(runId, fn) {
    const run = this.runs.get(String(runId))
    if (!run) return null
    for (const e of run.events) { try { fn(e) } catch { /* ignore */ } }
    if (run.done) { try { fn(null) } catch { /* ignore */ } ; return () => {} }
    run.subscribers.add(fn)
    return () => run.subscribers.delete(fn)
  }

  getRun(runId) {
    const run = this.runs.get(String(runId))
    if (!run) return null
    return {
      id: run.id, threadId: run.threadId, symbol: run.symbol,
      done: run.done, aborted: run.aborted, startedAt: run.startedAt,
      eventCount: run.events.length, result: run.result,
    }
  }

  close() { try { this.store.close() } catch { /* ignore */ } }
}