/**
 * formula-service/index.js — 通达信公式服务门面
 *
 * 对外只暴露两个动作：
 *   analyze(source)              → 解析 + 诊断（不取数；用于"能不能用/哪里不支持"）
 *   run(source, bars, options)   → 解析 + 求值（返回各输出线序列）
 *
 * 设计要点（ARCHITECTURE §13）：
 *   - 纯 Node、纯函数：不取数、不起子进程，因此完全可离线测试与复现
 *   - 不支持的语法**明确报错**（带行号），不静默近似
 *   - **未来函数检测**：检测到就在结果里标注，并可选择拒绝执行
 */

import { parse, formatDiagnostics, looksBinary } from './tdx-parser.js'
import { evaluate } from './tdx-evaluate.js'
import {
  supportedFunctionNames, FUTURE_FUNCTIONS, DRAW_FUNCTIONS,
  DATA_DEPENDENT_FUNCTIONS, DATA_DEPENDENT_VARS, NOT_IMPLEMENTED_FUNCTIONS,
} from './tdx-functions.js'

export {
  looksBinary, supportedFunctionNames, FUTURE_FUNCTIONS, DRAW_FUNCTIONS,
  DATA_DEPENDENT_FUNCTIONS, DATA_DEPENDENT_VARS, NOT_IMPLEMENTED_FUNCTIONS,
}

/** 公式大小上限（防粘贴巨大文本把解析器拖死） */
const MAX_SOURCE_LENGTH = 100000

/** 解析并给出诊断（不计算） */
export function analyze(source) {
  const text = String(source ?? '')
  if (text.trim() === '') {
    return { ok: false, errors: ['公式内容为空'], warnings: [], statements: [], outputs: [] }
  }
  if (text.length > MAX_SOURCE_LENGTH) {
    return {
      ok: false,
      errors: [`公式过长（${text.length} 字符，上限 ${MAX_SOURCE_LENGTH}）`],
      warnings: [], statements: [], outputs: [],
    }
  }
  if (looksBinary(text)) {
    return {
      ok: false,
      errors: [
        '这段内容看起来是加密或二进制格式，无法解析。',
        '通达信的加密公式文件（如 .tne）无法还原为源码——这是格式限制，不是权限问题。',
        '请在通达信"公式管理器"里打开该公式，复制源码文本，或导出为 .txt 后再导入。',
      ],
      warnings: [], statements: [], outputs: [],
    }
  }

  const ast = parse(text)
  const errors = formatDiagnostics(ast.diagnostics)
  const warnings = []

  const futureFunctions = new Map()   // name → 首次出现的行号
  const drawCalls = new Map()
  const dataDependent = new Map()
  const notImplemented = new Map()
  const unknown = []
  const usedFunctions = new Set()
  const supported = new Set(supportedFunctionNames())
  const note = (map, name, line) => { if (!map.has(name)) map.set(name, line) }

  // 遍历 AST 收集函数使用情况（解析阶段不校验函数名，交给这里统一报告）
  const visit = (node) => {
    if (!node || typeof node !== 'object') return
    if (node.kind === 'call') {
      const upper = String(node.name).toUpperCase()
      const line = node.line ?? 1
      usedFunctions.add(upper)
      if (FUTURE_FUNCTIONS.has(upper)) note(futureFunctions, upper, line)
      else if (DRAW_FUNCTIONS.has(upper)) note(drawCalls, upper, line)
      else if (DATA_DEPENDENT_FUNCTIONS.has(upper)) note(dataDependent, upper, line)
      else if (NOT_IMPLEMENTED_FUNCTIONS.has(upper)) note(notImplemented, upper, line)
      // 函数注册表大小写不敏感，因此按大写比对即可
      else if (!supported.has(upper)) unknown.push({ name: node.name, line })
      for (const a of node.args || []) visit(a)
    } else if (node.kind === 'var') {
      // CAPITAL 之类是「变量」而非函数，同样属于缺数据，必须识别出来
      const upper = String(node.name).toUpperCase()
      if (DATA_DEPENDENT_VARS.has(upper)) note(dataDependent, upper, node.line ?? 1)
    } else if (node.kind === 'binary') { visit(node.left); visit(node.right) }
    else if (node.kind === 'unary') visit(node.operand)
  }
  for (const st of ast.statements) visit(st.expr)

  if (futureFunctions.size > 0) {
    const first = [...futureFunctions.entries()][0]
    warnings.push(
      `第 ${first[1]} 行附近：检测到未来函数 ${[...futureFunctions.keys()].join('、')}。`
      + '这类函数会随新数据重画历史（俗称"事后诸葛亮"），'
      + '用它判断买卖信号会得到虚假的高胜率，请勿据此做研究结论。',
    )
  }
  if (drawCalls.size > 0) {
    warnings.push(
      `以下绘图指令暂不支持，会被忽略：${[...drawCalls.keys()].join('、')}。`
      + '输出线的数值仍会计算，但文字标注 / 图标 / 画线不会显示。',
    )
  }
  // 需要非 K 线数据的函数：这是「缺数据」，不是「未来函数」，报错必须指向真正原因
  if (dataDependent.size > 0) {
    const first = [...dataDependent.entries()][0]
    errors.push(
      `第 ${first[1]} 行：用到了需要财务 / 实时快照数据的函数 ${[...dataDependent.keys()].join('、')}。`
      + '本引擎只提供 K 线序列（开高低收 / 成交量 / 成交额），拿不到财务与实时盘口，因此**无法计算**——'
      + '这是数据缺失，不是公式本身有问题。'
      + '如需基本面选股（如 PE / ROE / 流通股本），可先用 stock_financials、stock_quote 取到数值再另行筛选。',
    )
  }
  if (notImplemented.size > 0) {
    const first = [...notImplemented.entries()][0]
    errors.push(
      `第 ${first[1]} 行：暂未实现的函数 ${[...notImplemented.keys()].join('、')}`
      + '（这类只靠 K 线理论上可算，属于本引擎的实现缺口，不是数据问题）。',
    )
  }
  const uniqUnknown = [...new Map(unknown.map((u) => [u.name.toUpperCase(), u])).values()]
  for (const u of uniqUnknown) {
    errors.push(`第 ${u.line} 行：不支持的函数 ${u.name}`)
  }

  const outputs = ast.statements
    .filter((s) => s.kind === 'output')
    .map((s) => ({ name: s.name, attrs: s.attrs || [], line: s.line }))

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    // 提示调用方：语法虽可用，但需要用户显式确认才应计算
    requiresFutureOptIn: futureFunctions.size > 0,
    statements: ast.statements.map((s) => ({ kind: s.kind, name: s.name, line: s.line })),
    outputs,
    futureFunctions: [...futureFunctions.keys()],
    dataDependentFunctions: [...dataDependent.keys()],
    notImplementedFunctions: [...notImplemented.keys()],
    ignoredDrawCalls: [...drawCalls.keys()],
    usedFunctions: [...usedFunctions].sort(),
    unsupportedFunctions: uniqUnknown.map((u) => u.name),
    supportedFunctions: supportedFunctionNames(),
  }
}

/**
 * 解析并求值。
 * @param source 公式文本
 * @param bars K 线（时间升序）
 * @param options.allowFutureFunctions 默认 false —— 检测到未来函数就拒绝执行
 * @returns {ok, outputs:[{name, attrs, values}], diagnostics, warnings, futureFunctions, ...}
 */
export function run(source, bars, options = {}) {
  const info = analyze(source)

  // 注意：下面所有返回都显式设置 ok，且放在 ...info 之后 ——
  // info.ok 是"语法/函数层面可用"，与"能否真正算出结果"不是一回事，
  // 若被展开覆盖会出现"拒绝执行却报成功"的假象（曾经的真实 bug）。
  if (!info.ok) return { ...info, ok: false, outputs: [] }

  if (info.futureFunctions.length > 0 && options.allowFutureFunctions !== true) {
    return {
      ...info,
      ok: false,
      outputs: [],
      errors: [
        ...info.errors,
        `公式使用了未来函数（${info.futureFunctions.join('、')}），已拒绝计算。`,
        '如果你只是想看图、不打算据此判断信号，可以显式允许（allowFutureFunctions）。',
      ],
    }
  }

  if (!Array.isArray(bars) || bars.length === 0) {
    return { ...info, ok: false, outputs: [], errors: [...info.errors, '没有 K 线数据，无法计算'] }
  }

  const ast = parse(String(source))
  const result = evaluate(ast, bars)
  const evalErrors = formatDiagnostics(result.diagnostics)

  return {
    ...info,
    ok: evalErrors.length === 0,
    errors: evalErrors,
    outputs: result.outputs.map((o) => ({
      name: o.name,
      attrs: o.attrs,
      line: o.line,
      values: o.values,
      validCount: o.values.filter((v) => v !== null).length,
    })),
    variables: Object.keys(result.variables),
    usedFunctions: result.usedFunctions,
    futureFunctions: [...new Set([...info.futureFunctions, ...result.futureFunctions])],
    ignoredDrawCalls: [...new Set([...info.ignoredDrawCalls, ...result.ignoredDrawCalls])],
    barCount: result.barCount,
    sourceText: String(source),
  }
}

/**
 * 从求值结果里提取「信号」bar 下标，供选股使用。
 *
 * 通达信选股公式的约定是：**最后一条输出线**为选股条件，取值为 1 表示命中。
 * 因此这里做了严格校验——只有当最后一条输出线**全部取值都是 0/1/null** 时，
 * 才把它当作信号；否则说明用户写的是指标公式（如均线），此时**不能**把
 * "非零"当成命中（那会把每条均线值都算成信号）。
 *
 * @returns {{ok: boolean, indices: number[], reason?: string}}
 */
export function signalsFrom(result) {
  if (!result?.ok) return { ok: false, indices: [], reason: '公式未成功计算' }
  const outputs = result.outputs || []
  if (outputs.length === 0) return { ok: false, indices: [], reason: '公式没有输出线，无法作为选股条件' }
  const last = outputs[outputs.length - 1]
  const isBooleanLike = last.values.every((v) => v === null || v === 0 || v === 1)
  if (!isBooleanLike) {
    return {
      ok: false,
      indices: [],
      reason: `最后一条输出线「${last.name}」不是 0/1 条件（含有其它数值），`
        + '因此不能作为选股条件。通达信选股公式的最后一行应当是一个条件表达式，例如 `XG:CLOSE>MA(CLOSE,20);`',
    }
  }
  const indices = []
  for (let i = 0; i < last.values.length; i++) if (last.values[i] === 1) indices.push(i)
  return { ok: true, indices, conditionName: last.name }
}