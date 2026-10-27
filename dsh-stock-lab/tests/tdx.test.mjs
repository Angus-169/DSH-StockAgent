/**
 * tdx.test.mjs — 通达信公式引擎测试（纯离线，不取数）
 * 运行：node tests/tdx.test.mjs
 *
 * 覆盖：词法/语法、求值语义（含边界）、诊断（不支持项必须报错）、
 *       未来函数检测、选股信号提取的安全性。
 */
import { strict as assert } from 'node:assert'

const { analyze, run, signalsFrom, looksBinary, supportedFunctionNames } =
  await import('../src/services/formula-service/index.js')

let passed = 0
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

/** 造 K 线：收盘价 = 给定数组 */
function bars(closes, extra = {}) {
  return closes.map((c, i) => ({
    time: `2026-01-${String(i + 1).padStart(2, '0')}`,
    open: extra.open?.[i] ?? c,
    high: extra.high?.[i] ?? c + 1,
    low: extra.low?.[i] ?? c - 1,
    close: c,
    volume: extra.volume?.[i] ?? 1000 + i,
    amount: null,
  }))
}
const closeOf = (out) => out.outputs[0].values.map((v) => (v === null ? null : Math.round(v * 10000) / 10000))

console.log('词法 / 语法')
t('解析赋值与输出线', () => {
  const r = analyze('A:=CLOSE*2;\nB:A+1;')
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.statements.length, 2)
  assert.equal(r.statements[0].kind, 'assign')
  assert.equal(r.statements[1].kind, 'output')
  assert.equal(r.outputs.length, 1)
  assert.equal(r.outputs[0].name, 'B')
})
t('末行缺分号也能解析', () => {
  const r = analyze('A:=CLOSE; B:A*2')
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.statements.length, 2)
})
t('整篇按行写、完全不带分号也能解析', () => {
  const r = analyze('A:=CLOSE\nB:=MA(A,3)\nC:B>REF(B,1)')
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.statements.length, 3)
  assert.deepEqual(r.outputs.map((o) => o.name), ['C'])
})
t('支持 { } 与 // 注释', () => {
  const r = analyze('{这是注释}\nA:=CLOSE; // 行尾注释\nB:A;')
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.statements.length, 2)
})
t('支持中文变量名', () => {
  const r = analyze('均价:=MA(CLOSE,5);\n信号:CLOSE>均价;')
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.equal(r.outputs[0].name, '信号')
})
t('绘图属性被解析并保留', () => {
  const r = analyze('A:MA(CLOSE,5),COLORRED,LINETHICK2;')
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.deepEqual(r.outputs[0].attrs, ['COLORRED', 'LINETHICK2'])
})
t('运算符优先级：* 高于 +', () => {
  const r = run('X:2+3*4;', bars([1]))
  assert.equal(closeOf(r)[0], 14)
})
t('括号改变优先级', () => {
  const r = run('X:(2+3)*4;', bars([1]))
  assert.equal(closeOf(r)[0], 20)
})
t('比较与逻辑运算', () => {
  // bars() 默认 open = close，所以 CLOSE>OPEN 为假、CLOSE>=OPEN 为真
  const r = run('X:CLOSE>=OPEN AND VOL>0;', bars([10]))
  assert.equal(closeOf(r)[0], 1)
  const r2 = run('X:CLOSE>OPEN;', bars([10]))
  assert.equal(closeOf(r2)[0], 0)
  const r3 = run('X:CLOSE>OPEN OR VOL>0;', bars([10]))
  assert.equal(closeOf(r3)[0], 1)
})
t('大小写不敏感的函数名', () => {
  const b = bars([1, 2, 3])
  const a = run('X:ma(CLOSE,2);', b)
  const c = run('X:MA(CLOSE,2);', b)
  assert.deepEqual(closeOf(a), closeOf(c))
})

console.log('\n语法错误诊断')
t('括号未闭合报错', () => {
  const r = analyze('X:MA(CLOSE,5;')
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /括号/.test(e)), JSON.stringify(r.errors))
})
t('缺少 := / : 报错并带行号', () => {
  const r = analyze('A CLOSE;')
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /第 1 行/.test(e)), JSON.stringify(r.errors))
})
t('运算符右侧缺表达式报错', () => {
  const r = analyze('X:CLOSE+;')
  assert.equal(r.ok, false)
})
t('注释未闭合报错', () => {
  const r = analyze('{未闭合\nX:CLOSE;')
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /注释/.test(e)))
})
t('空公式被拒', () => {
  assert.equal(analyze('').ok, false)
  assert.equal(analyze('   \n  ').ok, false)
})
t('超长公式被拒（防粘贴巨文本）', () => {
  const r = analyze('X:1;'.repeat(30000))
  assert.equal(r.ok, false)
  assert.ok(r.errors[0].includes('过长'))
})

console.log('\n不支持的函数必须明确报错（不静默近似）')
t('未知函数报错并给出行号与名字', () => {
  const r = analyze('A:=MA(CLOSE,5);\nB:魔法函数(CLOSE);')
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /魔法函数/.test(e) && /第 2 行/.test(e)), JSON.stringify(r.errors))
})
t('未确认口径的平滑函数不注册（MEMA 应报不支持）', () => {
  const r = analyze('X:MEMA(CLOSE,5);')
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /MEMA/.test(e)), JSON.stringify(r.errors))
})
t('提供可用函数清单', () => {
  const names = supportedFunctionNames()
  for (const f of ['MA', 'EMA', 'SMA', 'REF', 'HHV', 'LLV', 'SUM', 'STD', 'CROSS',
    'COUNT', 'EVERY', 'EXIST', 'IF', 'MAX', 'MIN', 'ABS', 'BARSLAST', 'BARSCOUNT']) {
    assert.ok(names.includes(f), '缺少函数 ' + f)
  }
})
t('参数个数错误报错', () => {
  const r = run('X:CROSS(CLOSE);', bars([1, 2, 3]))
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /CROSS/.test(e) && /参数/.test(e)), JSON.stringify(r.errors))
})
t('引用未定义变量报错', () => {
  const r = run('X:不存在的变量+1;', bars([1, 2, 3]))
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /未定义的变量/.test(e)), JSON.stringify(r.errors))
})

t('一处笔误只报一条错（不级联）', () => {
  // 早期实现逐个 token 跳过，一个笔误会产生十几条报错，用户看不出真正错在哪
  const r = analyze('低估值:PE:=CLOSE/FINANCE(33)<20;\n高ROE:FINANCE(37)>15;\nXG:低估值 AND 高ROE;')
  assert.equal(r.ok, false)
  const syntaxErrors = r.errors.filter((e) => !/FINANCE|数据/.test(e))
  assert.ok(syntaxErrors.length <= 2, `语法报错应被收敛，实际 ${syntaxErrors.length} 条：` + JSON.stringify(r.errors))
})
t('坏语句之后的合法语句仍能被解析', () => {
  const r = analyze('bad statement here;\nOK:MA(CLOSE,5);')
  assert.equal(r.ok, false, '坏语句仍要报错')
  assert.ok(r.outputs.some((o) => o.name === 'OK'), '恢复后应继续解析后面的语句')
})
t('多处笔误各报一条（互不淹没）', () => {
  const r = analyze('A B;\nC:MA(CLOSE,5);\nD E;\nF:MA(CLOSE,10);')
  const syntax = r.errors.filter((e) => /应为 := 或 :/.test(e))
  assert.equal(syntax.length, 2, '两处笔误应各报一条：' + JSON.stringify(r.errors))
})

console.log('\n未来函数与绘图指令')
t('检测 ZIG 并默认拒绝计算', () => {
  const r = run('X:ZIG(CLOSE,5);', bars([1, 2, 3, 4, 5]))
  assert.equal(r.ok, false)
  assert.deepEqual(r.futureFunctions, ['ZIG'])
  assert.ok(r.warnings.some((w) => /未来函数/.test(w)), JSON.stringify(r.warnings))
})
t('BACKSET / PEAK 也被识别', () => {
  // analyze 只做"语法与函数层面"的判断：未来函数给 warning 而非 error，
  // 但会通过 requiresFutureOptIn 告诉调用方"必须让用户确认"
  const r = analyze('A:BACKSET(CLOSE>OPEN,3);\nB:PEAK(CLOSE,5,1);')
  assert.equal(r.ok, true, 'analyze 层面语法是合法的：' + JSON.stringify(r.errors))
  assert.equal(r.requiresFutureOptIn, true)
  assert.deepEqual(r.futureFunctions.sort(), ['BACKSET', 'PEAK'])
})

console.log('\n三类"不能用"必须分开报（缺数据 ≠ 未来函数）')
// 真实踩过的分类错误：早期把 FINANCE/DYNAINFO 当成"未来函数"，
// 于是"我们没有财务数据"被说成"你的公式会重画历史"——指向了错误的原因。
t('FINANCE 归为「缺数据」而非未来函数', () => {
  const r = analyze('X:CLOSE/FINANCE(33);')
  assert.equal(r.ok, false, '缺数据应直接判为不可用')
  assert.deepEqual(r.dataDependentFunctions, ['FINANCE'])
  assert.deepEqual(r.futureFunctions, [], 'FINANCE 不该被算作未来函数')
  assert.equal(r.requiresFutureOptIn, false, '不该要求用户确认，而是根本无法计算')
  assert.ok(r.errors.some((e) => /无法计算/.test(e) && /数据缺失/.test(e)), JSON.stringify(r.errors))
  assert.ok(r.errors.some((e) => /stock_financials/.test(e)), '应给出可走的替代路径')
})
t('DYNAINFO / CAPITAL 同样归为缺数据', () => {
  const r = analyze('A:DYNAINFO(4);\nB:CAPITAL;')
  assert.deepEqual(r.dataDependentFunctions.sort(), ['CAPITAL', 'DYNAINFO'])
  assert.deepEqual(r.futureFunctions, [])
})
t('COST / WINNER 归为「未实现」而非缺数据', () => {
  const r = analyze('X:WINNER(CLOSE);')
  assert.equal(r.ok, false)
  assert.deepEqual(r.notImplementedFunctions, ['WINNER'])
  assert.deepEqual(r.dataDependentFunctions, [], '筹码类只靠 K 线可算，不该说成缺数据')
  assert.ok(r.errors.some((e) => /实现缺口/.test(e)), JSON.stringify(r.errors))
})
t('真未来函数与缺数据可以同时出现且各自报告', () => {
  const r = analyze('A:ZIG(CLOSE,5);\nB:FINANCE(33);')
  assert.deepEqual(r.futureFunctions, ['ZIG'])
  assert.deepEqual(r.dataDependentFunctions, ['FINANCE'])
  assert.equal(r.requiresFutureOptIn, true)
  assert.equal(r.ok, false)
})
t('报错带行号（指向真正出问题的那一行）', () => {
  const r = analyze('A:=CLOSE;\nB:=MA(A,5);\nC:FINANCE(33);')
  const e = r.errors.find((x) => /FINANCE/.test(x))
  assert.ok(e && /第 3 行/.test(e), '应指向第 3 行，实际: ' + e)
})
t('未来函数警告也带行号', () => {
  const r = analyze('A:=CLOSE;\nB:ZIG(A,5);')
  const w = r.warnings.find((x) => /未来函数/.test(x))
  assert.ok(w && /第 2 行/.test(w), '实际: ' + w)
})
t('显式允许后可计算（用户只想看图）', () => {
  const r = run('X:ZIG(CLOSE,5);', bars([1, 2, 3, 4, 5]), { allowFutureFunctions: true })
  assert.ok(r.warnings.some((w) => /未来函数/.test(w)))
})
t('绘图指令被列为忽略，且不阻断输出线', () => {
  const r = analyze('A:DRAWTEXT(CLOSE>OPEN,CLOSE,\'买\');\nB:CLOSE;')
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  assert.deepEqual(r.ignoredDrawCalls, ['DRAWTEXT'])
  assert.ok(r.warnings.some((w) => /绘图指令/.test(w)))
})

console.log('\n函数语义（与通达信口径核对）')
const B = bars([10, 11, 12, 13, 14, 15])

t('MA：前 N-1 根无效', () => {
  const r = run('X:MA(CLOSE,3);', B)
  assert.deepEqual(closeOf(r), [null, null, 11, 12, 13, 14])
})
t('EMA：首值取首个有效值，之后递推 alpha=2/(N+1)', () => {
  const r = run('X:EMA(CLOSE,2);', bars([10, 20, 30]))
  // alpha=2/3: 首=10; 20*2/3+10*1/3=16.6667; 30*2/3+16.6667/3=25.5556
  const v = closeOf(r)
  assert.equal(v[0], 10)
  assert.equal(v[1], Math.round((20 * 2 / 3 + 10 / 3) * 10000) / 10000)
  assert.equal(v[2], Math.round((30 * 2 / 3 + (20 * 2 / 3 + 10 / 3) / 3) * 10000) / 10000)
})
t('EMA 从首根就有值（与 MA 前 N-1 根为空不同）', () => {
  const b = bars([10, 11, 12, 13])
  const ema = run('X:EMA(CLOSE,5);', b).outputs[0].values
  const ma = run('X:MA(CLOSE,5);', b).outputs[0].values
  assert.equal(ema.filter((v) => v !== null).length, 4, 'EMA 每根都应有值')
  assert.equal(ma.filter((v) => v !== null).length, 0, 'MA5 在 4 根数据下应全为空')
})
t('SMA：Y=(M*X+(N-M)*Y)/N，首值取 X', () => {
  const r = run('X:SMA(CLOSE,3,1);', bars([9, 12, 15]))
  // 首=9; (1*12+2*9)/3=10; (1*15+2*10)/3=11.6667
  const v = closeOf(r)
  assert.equal(v[0], 9)
  assert.equal(v[1], 10)
  assert.equal(v[2], Math.round(((15 + 2 * 10) / 3) * 10000) / 10000)
})
t('REF：前 N 根，越界为 null', () => {
  const r = run('X:REF(CLOSE,2);', B)
  assert.deepEqual(closeOf(r), [null, null, 10, 11, 12, 13])
})
t('HHV / LLV 取窗口极值', () => {
  assert.deepEqual(closeOf(run('X:HHV(HIGH,3);', B)), [null, null, 13, 14, 15, 16])
  assert.deepEqual(closeOf(run('X:LLV(LOW,3);', B)), [null, null, 9, 10, 11, 12])
})
t('SUM：N=3 窗口求和；N=0 累计', () => {
  assert.deepEqual(closeOf(run('X:SUM(CLOSE,3);', B)), [null, null, 33, 36, 39, 42])
  assert.deepEqual(closeOf(run('X:SUM(CLOSE,0);', B)), [10, 21, 33, 46, 60, 75])
})
t('STD 用总体标准差（除以 N）', () => {
  const r = run('X:STD(CLOSE,3);', bars([1, 2, 3]))
  // mean=2, var=((1-2)^2+0+1)/3=2/3 → sqrt(2/3)
  assert.equal(closeOf(r)[2], Math.round(Math.sqrt(2 / 3) * 10000) / 10000)
})
t('CROSS：当根上穿为 1', () => {
  // 10, 9, 12 对 5 日线（用常量比较）
  const r = run('X:CROSS(CLOSE,11);', bars([10, 12, 13]))
  assert.deepEqual(closeOf(r), [0, 1, 0])
})
t('CROSS 首根不可能为上穿', () => {
  const r = run('X:CROSS(CLOSE,5);', bars([10, 12]))
  assert.equal(closeOf(r)[0], 0)
})
t('COUNT / EVERY / EXIST', () => {
  const bb = bars([1, 2, 3, 4, 5])
  assert.deepEqual(closeOf(run('X:COUNT(CLOSE>2,3);', bb)), [null, null, 1, 2, 3])
  assert.deepEqual(closeOf(run('X:EVERY(CLOSE>0,3);', bb)), [null, null, 1, 1, 1])
  assert.deepEqual(closeOf(run('X:EXIST(CLOSE>4,3);', bb)), [null, null, 0, 0, 1])
})
t('IF 逐元素选择', () => {
  const r = run('X:IF(CLOSE>2,100,0);', bars([1, 3]))
  assert.deepEqual(closeOf(r), [0, 100])
})
t('BARSLAST 给出距上次为真的根数', () => {
  const r = run('X:BARSLAST(CLOSE>2);', bars([1, 3, 1, 1]))
  assert.deepEqual(closeOf(r), [null, 0, 1, 2])
})
t('MAX / MIN / ABS', () => {
  const bb = bars([-5, 3])
  assert.deepEqual(closeOf(run('X:ABS(CLOSE);', bb)), [5, 3])
  assert.deepEqual(closeOf(run('X:MAX(CLOSE,0);', bb)), [0, 3])
  assert.deepEqual(closeOf(run('X:MIN(CLOSE,0);', bb)), [-5, 0])
})
t('除零产生 null 而不是 Infinity', () => {
  const r = run('X:CLOSE/0;', bars([1, 2]))
  assert.deepEqual(closeOf(r), [null, null])
})

console.log('\n行情序列变量')
t('O/H/L/C/V/AMOUNT 映射正确', () => {
  const bb = bars([10], { high: [11], low: [9], open: [9.5], volume: [5000] })
  assert.equal(closeOf(run('X:C;', bb))[0], 10)
  assert.equal(closeOf(run('X:H;', bb))[0], 11)
  assert.equal(closeOf(run('X:L;', bb))[0], 9)
  assert.equal(closeOf(run('X:O;', bb))[0], 9.5)
  assert.equal(closeOf(run('X:V;', bb))[0], 5000)
  assert.equal(closeOf(run('X:VOL;', bb))[0], 5000)
})
t('amount 为 null 时该序列为 null（不假装是 0）', () => {
  const r = run('X:AMOUNT;', bars([10]))
  assert.equal(closeOf(r)[0], null)
})

console.log('\n选股信号提取（安全性）')
t('纯 0/1 的条件线可作选股条件', () => {
  const r = run('XG:CLOSE>11;', bars([10, 12, 13, 10]))
  const s = signalsFrom(r)
  assert.equal(s.ok, true)
  assert.deepEqual(s.indices, [1, 2])
})
t('指标线（非 0/1）拒绝当信号，并说明原因', () => {
  const r = run('X:MA(CLOSE,2);', bars([10, 12, 14]))
  const s = signalsFrom(r)
  assert.equal(s.ok, false)
  assert.ok(/不是 0\/1 条件/.test(s.reason), s.reason)
})
t('多输出线时取最后一条（通达信选股约定）', () => {
  const r = run('A:MA(CLOSE,2);\nXG:CLOSE>12;', bars([10, 12, 13, 14]))
  const s = signalsFrom(r)
  assert.equal(s.ok, true)
  assert.deepEqual(s.indices, [2, 3])
})

console.log('\n加密/二进制识别')
t('可打印文本不被误判为二进制', () => {
  assert.equal(looksBinary('X:MA(CLOSE,5);'), false)
})
t('含大量控制字符被判定为二进制/加密', () => {
  assert.equal(looksBinary('\u0000\u0001\u0002\u0003abc'), true)
})
t('二进制内容给出可操作的提示（指向公式管理器导出）', () => {
  const r = analyze('\u0000\u0001\u0002\u0003\u0004\u0005\u0006\u0007')
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /公式管理器/.test(e)), JSON.stringify(r.errors))
})

console.log('\n长度对齐与稳健性')
t('输出长度始终等于 bar 数', () => {
  const r = run('X:MA(CLOSE,20);', bars([1, 2, 3]))
  assert.equal(r.outputs[0].values.length, 3)
})
t('空 K 线被拒而不是崩溃', () => {
  const r = run('X:CLOSE;', [])
  assert.equal(r.ok, false)
})
t('bar 中缺字段不影响其它序列', () => {
  const r = run('X:CLOSE;', [{ time: 't1', close: 5 }, { time: 't2', close: null }])
  assert.equal(closeOf(r)[0], 5)
  assert.equal(closeOf(r)[1], null)
})
t('求值结果带 usedFunctions 便于审计', () => {
  const r = run('X:MA(EMA(CLOSE,5),10);', bars(new Array(20).fill(10)))
  assert.deepEqual(r.usedFunctions, ['EMA', 'MA'])
})

console.log(`\n${passed} passed`)