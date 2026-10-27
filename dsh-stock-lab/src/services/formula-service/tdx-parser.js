/**
 * tdx-parser.js — 通达信公式 词法分析 + 语法分析
 *
 * 输出 AST 与诊断信息。本模块是**纯函数**：不取数、不算指标、不碰网络，
 * 因此可以完全离线测试（符合项目原则 4：可复现）。
 *
 * 支持的语法子集（ARCHITECTURE §13）：
 *   语句   A:=EXPR;   中间变量（不输出）
 *          A:EXPR;    输出线
 *          A:EXPR,COLORRED,LINETHICK2;   输出线 + 绘图属性
 *   表达式 数字 / 序列变量 / 已定义变量 / 一元 - + NOT /
 *          算术 + - * /  · 比较 > < >= <= = <> !=  · 逻辑 AND OR
 *          括号 · 函数调用（参数可为表达式）
 *
 * 明确不支持的（解析阶段就收集，交给上层报给用户，不静默近似）：
 *   加密二进制公式文件、跨公式引用（"MACD.MA1"）、未来函数、绘图指令
 *
 * 缺失分号容错：通达信实际粘贴的文本常有末行漏分号，甚至整篇按行写而没有分号。
 * 因此语句终止判定为「遇到 ; 」或「下一个 token 看起来是新语句的开头」。
 */

// ─────────────────────────── 词法 ───────────────────────────

const T = {
  NUMBER: 'number',
  STRING: 'string',
  IDENT: 'ident',
  OP: 'op',
  PUNCT: 'punct',
  ASSIGN: 'assign',   // :=
  COLON: 'colon',     // :
  SEMI: 'semi',       // ;
  COMMA: 'comma',     // ,
}

/** 运算符按长度倒序匹配（避免 >= 被切成 > 和 =） */
const OPERATORS = [
  '>=', '<=', '<>', '!=', '==',
  '>', '<', '=', '+', '-', '*', '/',
  '&&', '||', '!',
]

const PUNCTS = { '(': '(', ')': ')', ',': ',', ';': ';', ':': ':' }

/** 关键字 → 规范化的逻辑运算符 */
const KEYWORDS = new Map([
  ['AND', '&&'],
  ['OR', '||'],
  ['NOT', '!'],
])

/**
 * 词法分析。
 * @returns {{tokens: Array, errors: Array<{line,message}>}}
 */
export function tokenize(source) {
  const tokens = []
  const errors = []
  let i = 0
  let line = 1
  const n = source.length

  const isDigit = (c) => c >= '0' && c <= '9'
  // 通达信允许中文变量名（用户在公式里常用中文），所以标识符放行 CJK
  const isIdentStart = (c) => /[A-Za-z_\u4e00-\u9fa5]/.test(c)
  const isIdentPart = (c) => /[A-Za-z0-9_\u4e00-\u9fa5]/.test(c)

  while (i < n) {
    const c = source[i]

    // 换行（仅用于行号统计；不作为语句分隔符，见文件头说明）
    if (c === '\n') { line++; i++; continue }
    if (c === '\r' || c === ' ' || c === '\t') { i++; continue }

    // 注释：通达信支持 { } 注释，也常见 // 行注释
    if (c === '{') {
      const end = source.indexOf('}', i)
      if (end < 0) { errors.push({ line, message: '注释 { 没有闭合的 }' }); i = n; continue }
      line += (source.slice(i, end).match(/\n/g) || []).length
      i = end + 1
      continue
    }
    if (c === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i)
      i = end < 0 ? n : end
      continue
    }

    // 字符串字面量：TDX 的 DRAWTEXT/DRAWNUMBER 等常带 '文本' 参数。
    // 不支持字符串会让**整条公式**解析失败（哪怕绘图本来就会被忽略），所以必须认。
    if (c === "'" || c === '"') {
      const quote = c
      let j = i + 1
      let value = ''
      while (j < n && source[j] !== quote) {
        if (source[j] === '\\' && j + 1 < n) { value += source[j + 1]; j += 2; continue }
        value += source[j]; j++
      }
      if (j >= n) { errors.push({ line, message: `字符串 ${quote} 没有闭合` }); i = n; continue }
      tokens.push({ type: T.STRING, value, raw: source.slice(i, j + 1), line, pos: i })
      i = j + 1
      continue
    }

    // 数字：支持 1 / 1.5 / .5
    if (isDigit(c) || (c === '.' && isDigit(source[i + 1]))) {
      let j = i
      while (j < n && (isDigit(source[j]) || source[j] === '.')) j++
      const raw = source.slice(i, j)
      const value = Number(raw)
      if (!Number.isFinite(value)) {
        errors.push({ line, message: `非法数字字面量 "${raw}"` })
      } else {
        tokens.push({ type: T.NUMBER, value, raw, line, pos: i })
      }
      i = j
      continue
    }

    // 标识符 / 关键字 / 函数名
    if (isIdentStart(c)) {
      let j = i
      while (j < n && isIdentPart(source[j])) j++
      const raw = source.slice(i, j)
      const upper = raw.toUpperCase()
      if (KEYWORDS.has(upper)) {
        tokens.push({ type: T.OP, value: KEYWORDS.get(upper), raw, line, pos: i })
      } else {
        tokens.push({ type: T.IDENT, value: raw, raw, upper, line, pos: i })
      }
      i = j
      continue
    }

    // := 赋值
    if (c === ':' && source[i + 1] === '=') {
      tokens.push({ type: T.ASSIGN, value: ':=', raw: ':=', line, pos: i })
      i += 2
      continue
    }

    // 标点
    if (Object.prototype.hasOwnProperty.call(PUNCTS, c)) {
      const kind = c === ':' ? T.COLON : c === ';' ? T.SEMI : c === ',' ? T.COMMA : T.PUNCT
      tokens.push({ type: kind, value: c, raw: c, line, pos: i })
      i++
      continue
    }

    // 运算符（长的优先）
    const op = OPERATORS.find((o) => source.startsWith(o, i))
    if (op) {
      tokens.push({ type: T.OP, value: op, raw: op, line, pos: i })
      i += op.length
      continue
    }

    // 未知字符
    errors.push({ line, message: `无法识别的字符 "${c}"` })
    i++
  }

  tokens.push({ type: 'eof', value: null, raw: '', line, pos: n })
  return { tokens, errors }
}

// ─────────────────────────── 语法 ───────────────────────────

/** 语句：赋值（中间变量）或输出线 */
// { kind:'assign'|'output', name, expr, attrs[], line }
/** 表达式节点 */
// { kind:'num', value } | { kind:'var', name } | { kind:'call', name, args[] }
// | { kind:'unary', op, operand } | { kind:'binary', op, left, right }

const PRECEDENCE = [
  ['||'],
  ['&&'],
  ['>', '<', '>=', '<=', '=', '<>', '!=', '=='],
  ['+', '-'],
  ['*', '/'],
]

function precedenceOf(op) {
  for (let p = 0; p < PRECEDENCE.length; p++) {
    if (PRECEDENCE[p].includes(op)) return p
  }
  return -1
}

export function parse(source) {
  const { tokens, errors } = tokenize(source)
  const statements = []
  const diagnostics = [...errors]
  let p = 0

  const peek = (k = 0) => tokens[p + k]
  const next = () => tokens[p++]
  const atEnd = () => peek().type === 'eof'

  function fail(token, message) {
    diagnostics.push({ line: token?.line ?? 1, message })
  }

  /** 下一个 token 是否像新语句的开头（IDENT 后跟 : 或 :=） */
  function looksLikeStatementStart() {
    const a = peek()
    const b = peek(1)
    if (!a || a.type !== T.IDENT) return false
    return b && (b.type === T.COLON || b.type === T.ASSIGN)
  }

  function parsePrimary() {
    const tok = peek()
    if (!tok || tok.type === 'eof') { fail(tok, '表达式意外结束'); return null }

    if (tok.type === T.NUMBER) { next(); return { kind: 'num', value: tok.value } }

    // 字符串常量（只在绘图类函数里出现；求值时是无效值，因为绘图本身被忽略）
    if (tok.type === T.STRING) { next(); return { kind: 'str', value: tok.value, line: tok.line } }

    if (tok.type === T.PUNCT && tok.value === '(') {
      next()
      const inner = parseExpression(0)
      const close = peek()
      if (close && close.type === T.PUNCT && close.value === ')') next()
      else fail(close, '括号没有闭合')
      return inner
    }

    if (tok.type === T.IDENT) {
      next()
      // 函数调用
      const nxt = peek()
      if (nxt && nxt.type === T.PUNCT && nxt.value === '(') {
        next()
        const args = []
        const first = peek()
        if (first && first.type === T.PUNCT && first.value === ')') {
          next()
        } else {
          for (;;) {
            const arg = parseExpression(0)
            if (arg) args.push(arg)
            const sep = peek()
            if (sep && sep.type === T.COMMA) { next(); continue }
            if (sep && sep.type === T.PUNCT && sep.value === ')') { next(); break }
            fail(sep, `函数 ${tok.value} 的参数列表括号未闭合：缺少 )（遇到 "${sep?.raw || '文末'}"）`)
            break
          }
        }
        return { kind: 'call', name: tok.value, args, line: tok.line }
      }
      return { kind: 'var', name: tok.value, line: tok.line }
    }

    // 一元运算符
    if (tok.type === T.OP && (tok.value === '-' || tok.value === '+' || tok.value === '!')) {
      next()
      const operand = parseUnary()
      return { kind: 'unary', op: tok.value, operand, line: tok.line }
    }

    fail(tok, `表达式里出现意外的 "${tok.raw}"`)
    next()
    return null
  }

  function parseUnary() {
    return parsePrimary()
  }

  function parseExpression(minPrec) {
    let left = parseUnary()
    if (!left) return null
    for (;;) {
      const tok = peek()
      if (!tok || tok.type !== T.OP) break
      const prec = precedenceOf(tok.value)
      if (prec < 0 || prec < minPrec) break
      next()
      const right = parseExpression(prec + 1)
      if (!right) { fail(tok, `运算符 "${tok.raw}" 右侧缺少表达式`); break }
      left = { kind: 'binary', op: tok.value, left, right, line: tok.line }
    }
    return left
  }

  // 语句循环
  let guard = 0
  /**
   * 出错恢复：跳到下一条语句（下一个 ; ）再继续。
   *
   * 为什么必须这样：逐个 token 跳过会让一个笔误级联出十几条报错
   * （用户看到"共 11 处问题"，实际只有 1 处），反而看不出真正错在哪。
   * 跳到分号能保证「一处笔误 → 一条报错」。
   */
  function syncToStatementEnd() {
    while (!atEnd()) {
      const t = next()
      if (t.type === T.SEMI) return
    }
  }

  while (!atEnd()) {
    if (++guard > 2000) { fail(peek(), '语句过多，疑似解析死循环，已停止'); break }

    const nameTok = peek()
    if (nameTok.type !== T.IDENT) {
      fail(nameTok, `语句应以变量名开头，遇到 "${nameTok.raw || '文末'}"`)
      syncToStatementEnd()
      continue
    }
    next()

    const sep = peek()
    let kind
    if (sep && sep.type === T.ASSIGN) { kind = 'assign'; next() }
    else if (sep && sep.type === T.COLON) { kind = 'output'; next() }
    else {
      fail(sep, `变量 "${nameTok.value}" 后面应为 := 或 :，遇到 "${sep?.raw || '文末'}"`)
      syncToStatementEnd()
      continue
    }

    const expr = parseExpression(0)
    if (!expr) { fail(nameTok, `变量 "${nameTok.value}" 缺少表达式`); continue }

    // 绘图属性：A:EXPR,COLORRED,LINETHICK2;
    const attrs = []
    while (peek().type === T.COMMA) {
      next()
      const attrTok = peek()
      if (attrTok.type === T.IDENT) {
        next()
        // 属性可能带参数，如 DRAWICON(1,10) —— 这里只记名字
        if (peek().type === T.PUNCT && peek().value === '(') {
          let depth = 0
          do {
            const t = next()
            if (t.type === T.PUNCT && t.value === '(') depth++
            else if (t.type === T.PUNCT && t.value === ')') depth--
            else if (t.type === 'eof') break
          } while (depth > 0)
        }
        attrs.push(attrTok.value.toUpperCase())
      } else if (attrTok.type === T.NUMBER) {
        // 形如 A:EXPR,0.5 的粗细/透明度数值参数，忽略
        next()
      } else {
        fail(attrTok, `绘图属性位置出现意外的 "${attrTok.raw}"`)
        break
      }
    }

    statements.push({ kind, name: nameTok.value, expr, attrs, line: nameTok.line })

    // 语句终止：; 或 下一个看起来是新语句的开头（缺失分号容错）
    if (peek().type === T.SEMI) { next(); continue }
    if (atEnd() || looksLikeStatementStart()) continue
    // 其它情况：语句尾部有无法归属的内容，报错后跳到下一条语句
    const stray = peek()
    fail(stray, `语句 "${nameTok.value}" 之后出现无法解析的内容 "${stray.raw}"`)
    syncToStatementEnd()
  }

  return { statements, diagnostics }
}

// ─────────────────────────── 面向调用方的门面 ───────────────────────────

/** 把 parse 的诊断整理成可读的、带行号的报错列表 */
export function formatDiagnostics(diagnostics) {
  return diagnostics.map((d) => `第 ${d.line} 行：${d.message}`)
}

/** 判断输入是否像加密/二进制公式（不可打印字节占比高） */
export function looksBinary(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  let bad = 0
  const sample = text.slice(0, 2000)
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i)
    // 允许制表/换行/回车与常规可打印字符
    if (code === 9 || code === 10 || code === 13) continue
    if (code < 32 || code === 0xFFFD) bad++
  }
  return bad / sample.length > 0.1
}