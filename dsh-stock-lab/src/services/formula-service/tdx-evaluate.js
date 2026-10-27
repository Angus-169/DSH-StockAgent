/**
 * tdx-evaluate.js — 通达信公式 AST 求值
 *
 * 输入：AST（来自 tdx-parser）+ bars（{time,open,high,low,close,volume,amount}[]）
 * 输出：每条输出线的序列 + 中间变量 + 诊断
 *
 * 无未来函数保证：所有函数只使用当前及历史 bar（REF/HHV/LLV/SUM/... 都向左看）。
 * 唯一的例外是未来函数本身，它们已被 parser 单独标记（见 FUTURE_FUNCTIONS）。
 */

import {
  FUNCTIONS, FUTURE_FUNCTIONS, DRAW_FUNCTIONS,
  DATA_DEPENDENT_FUNCTIONS, DATA_DEPENDENT_VARS, NOT_IMPLEMENTED_FUNCTIONS,
  constant, map2, map1,
} from './tdx-functions.js'

/** 内置行情序列变量 → bars 字段 */
const SERIES_VARS = new Map([
  ['OPEN', 'open'], ['O', 'open'],
  ['HIGH', 'high'], ['H', 'high'],
  ['LOW', 'low'], ['L', 'low'],
  ['CLOSE', 'close'], ['C', 'close'],
  ['VOL', 'volume'], ['V', 'volume'], ['VOLUME', 'volume'],
  ['AMOUNT', 'amount'], ['AMO', 'amount'],
])

/** 通达信里这些常量很常用 */
const CONST_VARS = new Map([
  ['TRUE', 1], ['FALSE', 0],
])

function compare(op, x, y) {
  switch (op) {
    case '>': return x > y
    case '<': return x < y
    case '>=': return x >= y
    case '<=': return x <= y
    case '=': case '==': return x === y
    case '<>': case '!=': return x !== y
    default: return false
  }
}

function applyBinary(op, a, b) {
  switch (op) {
    case '+': return map2(a, b, (x, y) => x + y)
    case '-': return map2(a, b, (x, y) => x - y)
    case '*': return map2(a, b, (x, y) => x * y)
    case '/': return map2(a, b, (x, y) => (y === 0 ? null : x / y))
    case '&&': return map2(a, b, (x, y) => ((x !== 0 && x !== null) && (y !== 0 && y !== null)) ? 1 : 0)
    case '||': return map2(a, b, (x, y) => ((x !== 0 && x !== null) || (y !== 0 && y !== null)) ? 1 : 0)
    default:
      if (['>', '<', '>=', '<=', '=', '==', '<>', '!='].includes(op)) {
        // 比较：任一侧 null → null（逻辑上下文会当 false）
        return map2(a, b, (x, y) => (compare(op, x, y) ? 1 : 0))
      }
      throw new Error('未知运算符 ' + op)
  }
}

/**
 * 求值。
 * @param {object} ast parse() 的结果
 * @param {Array} bars K 线（时间升序）
 * @returns {{outputs: Array<{name, attrs, values, line}>, variables: object, diagnostics: Array, usedFunctions: string[], futureFunctions: string[], ignoredDrawCalls: string[]}}
 */
export function evaluate(ast, bars) {
  const n = Array.isArray(bars) ? bars.length : 0
  const diagnostics = []
  const usedFunctions = new Set()
  const futureFunctions = new Set()
  const ignoredDrawCalls = new Set()
  const env = new Map()

  // 行情序列
  const seriesOf = (field) => bars.map((b) => {
    const v = b?.[field]
    return typeof v === 'number' && Number.isFinite(v) ? v : null
  })
  const cacheBars = new Map()
  const barsSeries = (field) => {
    if (!cacheBars.has(field)) cacheBars.set(field, seriesOf(field))
    return cacheBars.get(field)
  }

  const constSeries = (value) => constant(value, n)

  /** 把求值结果统一成序列 */
  const asSeries = (v) => {
    if (Array.isArray(v)) return v
    if (typeof v === 'number') return constSeries(v)
    return constSeries(null)
  }

  function evalNode(node) {
    switch (node.kind) {
      case 'num':
        return constSeries(node.value)

      // 字符串常量：只出现在绘图类函数参数里，而绘图已被忽略，
      // 因此这里给无效值，不当成数字参与运算
      case 'str':
        return constSeries(null)

      case 'var': {
        const upper = String(node.name).toUpperCase()
        if (SERIES_VARS.has(upper)) return barsSeries(SERIES_VARS.get(upper))
        if (CONST_VARS.has(upper)) return constSeries(CONST_VARS.get(upper))
        if (env.has(node.name)) return env.get(node.name)
        // 大小写不敏感地再找一次（通达信不区分大小写）
        for (const [k, v] of env) if (k.toUpperCase() === upper) return v
        // 需要非 K 线数据的变量：说清是缺数据，而不是"未定义"
        if (DATA_DEPENDENT_VARS.has(upper)) {
          diagnostics.push({
            line: node.line,
            message: `第 ${node.line} 行：${node.name} 需要股本/财务等非 K 线数据，本引擎无法提供（这是数据缺失，不是公式本身有问题）`,
          })
          return constSeries(null)
        }
        diagnostics.push({ line: node.line, message: `引用了未定义的变量 "${node.name}"` })
        return constSeries(null)
      }

      case 'unary': {
        const operand = asSeries(evalNode(node.operand))
        if (node.op === '-') return map1(operand, (x) => -x)
        if (node.op === '+') return operand
        if (node.op === '!') return map1(operand, (x) => ((x === 0 || x === null) ? 1 : 0))
        throw new Error('未知一元运算符 ' + node.op)
      }

      case 'binary': {
        const a = asSeries(evalNode(node.left))
        const b = asSeries(evalNode(node.right))
        return applyBinary(node.op, a, b)
      }

      case 'call': {
        const name = node.name
        const upper = name.toUpperCase()
        usedFunctions.add(upper)

        if (FUTURE_FUNCTIONS.has(upper)) futureFunctions.add(upper)
        if (DRAW_FUNCTIONS.has(upper)) ignoredDrawCalls.add(upper)

        const fn = FUNCTIONS.get(name) || FUNCTIONS.get(upper) || FUNCTIONS.get(name.toLowerCase())
        if (!fn) {
          // 各类"不能用"的原因必须分开报——把「缺数据」说成「未来函数」会误导用户
          if (DRAW_FUNCTIONS.has(upper)) {
            diagnostics.push({
              line: node.line,
              message: `第 ${node.line} 行：绘图指令 ${name} 暂不支持，已忽略（输出线仍会计算，但不会画文字/图标）`,
            })
            return constSeries(null)
          }
          if (FUTURE_FUNCTIONS.has(upper)) {
            diagnostics.push({
              line: node.line,
              message: `第 ${node.line} 行：${name} 是未来函数（会重画历史）。若用于判断信号，结果不可信，建议不要使用`,
            })
            return constSeries(null)
          }
          if (DATA_DEPENDENT_FUNCTIONS.has(upper)) {
            diagnostics.push({
              line: node.line,
              message: `第 ${node.line} 行：${name} 需要财务/实时快照数据，本引擎只提供 K 线序列，无法计算`
                + '（这是数据缺失，不是公式本身有问题）',
            })
            return constSeries(null)
          }
          if (NOT_IMPLEMENTED_FUNCTIONS.has(upper)) {
            diagnostics.push({
              line: node.line,
              message: `第 ${node.line} 行：${name} 尚未实现（只靠 K 线可算，属实现缺口）`,
            })
            return constSeries(null)
          }
          diagnostics.push({
            line: node.line,
            message: `第 ${node.line} 行：不支持的函数 ${name}。可用的函数请见"支持列表"`,
          })
          return constSeries(null)
        }

        const args = node.args.map((a) => asSeries(evalNode(a)))
        const argc = args.length
        if (argc < fn.minArgs || argc > fn.maxArgs) {
          const expect = fn.minArgs === fn.maxArgs ? `${fn.minArgs}` : `${fn.minArgs}~${fn.maxArgs}`
          diagnostics.push({
            line: node.line,
            message: `第 ${node.line} 行：${name} 需要 ${expect} 个参数，实际给了 ${argc} 个`,
          })
          return constSeries(null)
        }
        try {
          return asSeries(fn.impl(...args))
        } catch (e) {
          diagnostics.push({
            line: node.line,
            message: `第 ${node.line} 行：${name} 求值失败（${e?.message || e}）`,
          })
          return constSeries(null)
        }
      }

      default:
        throw new Error('未知 AST 节点 ' + node.kind)
    }
  }

  const outputs = []
  for (const st of ast.statements) {
    let values
    try {
      values = asSeries(evalNode(st.expr))
    } catch (e) {
      diagnostics.push({ line: st.line, message: `第 ${st.line} 行：${st.name} 计算失败（${e?.message || e}）` })
      values = constSeries(null)
    }
    // 长度对齐到 bar 数
    if (values.length !== n) {
      const fixed = new Array(n).fill(null)
      for (let i = 0; i < Math.min(n, values.length); i++) fixed[i] = values[i]
      values = fixed
    }
    env.set(st.name, values)
    if (st.kind === 'output') {
      outputs.push({ name: st.name, attrs: st.attrs || [], values, line: st.line })
    }
  }

  return {
    outputs,
    variables: Object.fromEntries([...env.entries()].map(([k, v]) => [k, v])),
    diagnostics,
    usedFunctions: [...usedFunctions].sort(),
    futureFunctions: [...futureFunctions].sort(),
    ignoredDrawCalls: [...ignoredDrawCalls].sort(),
    barCount: n,
  }
}

export { SERIES_VARS, CONST_VARS }