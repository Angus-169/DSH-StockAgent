/**
 * stock-context.js — Context-aware AI
 *
 * 把 UI 当前状态注入 Agent 上下文，使 LLM 知道"用户正在看哪只股票"，
 * 从而可以直接问"最近怎么回事？"而无需重复股票名。
 *
 * 状态来源：Client 通过 POST /stock-lab/context 上报。
 * 注意：不使用 ctx.set()（那需要插件声明 provide），而是返回一个本地句柄由调用方持有。
 */

export function createStockContext(ctx) {
  let state = {
    currentStock: null,
    currentName: null,
    timeframe: '1d',
    adjust: 'qfq',            // 复权模式：画线的锚点价格依赖它，必须让 AI 知道
    chartRange: '6M',
    benchmark: 'IDX000300',
    sector: null,
    selectedNewsId: null,
    activeNoteId: null,
    updatedAt: null,
  }

  const api = {
    get: () => ({ ...state }),
    update: (patch) => {
      const next = {}
      for (const [k, v] of Object.entries(patch || {})) {
        if (v !== undefined) next[k] = v
      }
      state = { ...state, ...next, updatedAt: new Date().toISOString() }
      return api.get()
    },
    /** 渲染给 LLM 的一段文字（无当前股票时返回 null） */
    render: () => {
      if (!state.currentStock) return null
      return '【当前 UI 状态】用户正在查看：'
        + `${state.currentName || ''}(${state.currentStock})，`
        + `周期 ${state.timeframe}，复权 ${state.adjust === 'qfq' ? '前复权' : state.adjust === 'hfq' ? '后复权' : '不复权'}，`
        + `区间 ${state.chartRange}，基准 ${state.benchmark}`
        + (state.sector ? `，行业 ${state.sector}` : '')
        + '。用户说"这只/它/最近怎么回事"时，指的就是这只股票，直接用它，不要让用户重复代码。'
        + '（若要在图上画线，锚点价格必须按上面这个复权模式取，并如实记录该模式。）'
    },
  }

  // 尽力注册 Agent 上下文提供者（宿主版本不支持则跳过，不影响其它功能）
  try {
    if (typeof ctx?.agent?.addContextProvider === 'function') {
      ctx.agent.addContextProvider({
        name: 'stock-lab-ui-state',
        priority: 60,
        render: () => api.render(),
      })
    }
  } catch (e) {
    ctx?.logger?.warn?.('stock-lab: context provider 注册失败 %s', e?.message || e)
  }

  return api
}
