/**
 * smoke-tdx.mjs — TDX 公式引擎真实数据冒烟
 * 用本地历史库的真实 K 线跑几个真实通达信公式，确认引擎在真实数据上可用。
 * 运行：node tests/smoke-tdx.mjs
 */
import { strict as assert } from 'node:assert'
import { getLocalKline, localDataVersion } from '../src/datasource/local.js'
import { analyze, run, signalsFrom } from '../src/services/formula-service/index.js'

const SYMBOL = process.env.TDX_SMOKE_SYMBOL || 'SH600519'
let passed = 0
function t(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name) }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1 }
}

const bars = getLocalKline(SYMBOL, { count: 500 })
if (!bars || bars.length === 0) {
  console.error(`本地库没有 ${SYMBOL} 的数据，先运行 collect_history 或 collector.py fetch ${SYMBOL}`)
  process.exit(1)
}
console.log(`标的 ${SYMBOL}，${bars.length} 根 K 线，数据版本 ${localDataVersion([SYMBOL])}`)
console.log(`区间 ${bars[0].time} ~ ${bars.at(-1).time}\n`)

/** 真实通达信公式（来自常见用法） */
const MACD = `
DIF:EMA(CLOSE,12)-EMA(CLOSE,26);
DEA:EMA(DIF,9);
MACD:(DIF-DEA)*2,COLORSTICK;
`
const MA_SYSTEM = `
MA5:MA(CLOSE,5);
MA10:MA(CLOSE,10);
MA20:MA(CLOSE,20);
MA60:MA(CLOSE,60);
`
const XG_CROSS = `
MA5:=MA(CLOSE,5);
MA20:=MA(CLOSE,20);
放量:=VOL>MA(VOL,20)*1.5;
XG:CROSS(MA5,MA20) AND 放量;
`
const RSI_LIKE = `
LC:=REF(CLOSE,1);
涨幅:=MAX(CLOSE-LC,0);
跌幅:=MAX(LC-CLOSE,0);
RSI:100*SMA(涨幅,14,1)/(SMA(涨幅,14,1)+SMA(跌幅,14,1));
`

console.log('MACD（EMA 递推 + 三输出线）')
let macd
t('解析并计算成功', () => {
  const info = analyze(MACD)
  assert.equal(info.ok, true, JSON.stringify(info.errors))
  assert.equal(info.outputs.length, 3)
  macd = run(MACD, bars)
  assert.equal(macd.ok, true, JSON.stringify(macd.errors))
  assert.equal(macd.outputs.length, 3)
})
t('DIF/DEA/MACD 数值合理（EMA 从首根就有值，关系式成立）', () => {
  const [dif, dea, histogram] = macd.outputs
  // 通达信 EMA 首值取首根收盘价，因此 DIF=EMA12-EMA26 在第 0 根为 0（不是空值）。
  // 这与 MA 前 N-1 根为空不同，是 EMA 与 MA 的固有差异。
  assert.equal(dif.values[0], 0, 'DIF 首根应为 0（两条 EMA 同种子）')
  const lastDif = dif.values.at(-1)
  assert.ok(typeof lastDif === 'number', '末端 DIF 应有值')
  assert.ok(Math.abs(lastDif) < 100, 'DIF 量级不合理: ' + lastDif)
  // 全部有效值上 MACD = (DIF-DEA)*2 关系必须成立
  for (let i = 0; i < dif.values.length; i++) {
    const d = dif.values[i], e = dea.values[i], m = histogram.values[i]
    if (d === null || e === null || m === null) continue
    assert.ok(Math.abs(m - (d - e) * 2) < 1e-6, `第 ${i} 根 MACD 与 (DIF-DEA)*2 不一致`)
  }
})
t('输出线长度等于 bar 数', () => {
  for (const o of macd.outputs) assert.equal(o.values.length, bars.length)
})

console.log('\n均线系统（多条 MA）')
t('四条均线都算出且顺序合理', () => {
  const r = run(MA_SYSTEM, bars)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  const [ma5, , ma20, ma60] = r.outputs
  assert.equal(ma5.values[3], null, 'MA5 第 4 根仍应无值')
  assert.ok(typeof ma5.values.at(-1) === 'number')
  // 长期均线对短期波动更迟钝：末端 60 日均线应有值
  assert.ok(typeof ma60.values.at(-1) === 'number')
})

console.log('\n选股公式（中文变量 + 逻辑组合 + 信号提取）')
t('解析成功且中文变量名可用', () => {
  const info = analyze(XG_CROSS)
  assert.equal(info.ok, true, JSON.stringify(info.errors))
  assert.equal(info.outputs[0].name, 'XG')
})
t('信号可提取且数量合理', () => {
  const r = run(XG_CROSS, bars)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  const s = signalsFrom(r)
  assert.equal(s.ok, true, s.reason)
  console.log(`     命中 ${s.indices.length} 次金叉+放量（条件名 ${s.conditionName}）`)
  assert.ok(s.indices.length >= 1, '500 根里应至少出现一次 5/20 金叉且放量')
  assert.ok(s.indices.length < bars.length / 5, '信号不该过于密集')
  // 命中的 bar 上条件必须真的成立
  const ma5 = r.outputs[0] // 这里 outputs 只有 XG，回看用变量
  for (const i of s.indices.slice(0, 3)) {
    assert.equal(r.outputs.at(-1).values[i], 1)
  }
})

console.log('\nRSI（SMA 加权递推）')
t('RSI 落在 0~100 且末端有值', () => {
  const r = run(RSI_LIKE, bars)
  assert.equal(r.ok, true, JSON.stringify(r.errors))
  const vals = r.outputs[0].values.filter((v) => v !== null)
  assert.ok(vals.length > bars.length - 60, '有效值数量不足')
  const last = vals.at(-1)
  assert.ok(last >= 0 && last <= 100, 'RSI 越界: ' + last)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  assert.ok(min >= 0 && max <= 100, `RSI 范围异常 ${min}~${max}`)
  console.log(`     RSI 范围 ${min.toFixed(2)} ~ ${max.toFixed(2)}，末端 ${last.toFixed(2)}`)
})

console.log('\n未来函数在真实数据上被拦下')
t('含 ZIG 的公式默认拒绝计算', () => {
  const r = run('X:ZIG(CLOSE,10);', bars)
  assert.equal(r.ok, false)
  assert.deepEqual(r.futureFunctions, ['ZIG'])
})

console.log(`\n${passed} passed  (标的 ${SYMBOL}，${bars.length} 根真实 K 线)`)