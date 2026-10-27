/**
 * tools/quant-tools.js — Quant Engine 相关 AI Tools
 *
 * 定位（ARCHITECTURE §14）：Quant Engine 的第一目标不是找赚钱策略，
 * 而是**验证研究假设**。所以工具必须：
 *   - 明确返回样本量与显著性，而不是只给一个收益数字
 *   - 强制附带因果免责
 */

import { runPythonJson } from '../services/quant-bridge/index.js'

const OUT_TEXT = {
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
}

const CONDITIONS = ['volume_spike', 'breakout', 'drawdown', 'ma_cross', 'big_move']

export function registerQuantTools(ctx) {
  if (ctx.tools === undefined) return 0
  let count = 0
  const reg = (def) => { ctx.tools.register({ output: OUT_TEXT, ...def }); count++ }

  reg({
    name: 'run_event_study',
    description: '事件研究：验证"某条件出现后，未来 N 日是否更容易跑赢基准"这类假设。内置条件：volume_spike（放量）、breakout（突破N日新高）、drawdown（回撤）、ma_cross（均线上穿）、big_move（单日大涨大跌）。返回样本量、平均超额收益、胜率、t 统计量与显著性判断。这是历史统计描述，不是因果结论，也不保证未来重复。前置条件：该股票历史数据已落库（用 collect_history 采集）。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '股票代码，如 SH600519' },
        condition: { type: 'string', enum: CONDITIONS, description: '事件条件' },
        horizon: { type: 'integer', minimum: 1, maximum: 60, description: '事件后观察天数，默认 5' },
        benchmark: { type: 'string', description: '基准指数，默认 IDX000300' },
        params: {
          type: 'object',
          description: '条件参数。volume_spike: {n:20,mult:1.5}；breakout: {n:20}；drawdown: {n:20,pct:0.1}；ma_cross: {fast:5,slow:20}；big_move: {pct:0.05}',
          additionalProperties: true,
        },
      },
      required: ['symbol', 'condition'],
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const out = await runPythonJson('quant/event_study.py', [
          '--symbol', String(args.symbol),
          '--condition', String(args.condition),
          '--horizon', String(args.horizon || 5),
          '--benchmark', String(args.benchmark || 'IDX000300'),
          '--params', JSON.stringify(args.params || {}),
        ])
        return out
      } catch (e) {
        const msg = String(e?.message || e)
        if (/无历史数据/.test(msg)) {
          throw new Error(msg + '（请先调用 collect_history 采集该股票历史数据）')
        }
        throw new Error('事件研究执行失败：' + msg)
      }
    },
  })

  reg({
    name: 'collect_history',
    description: '采集某只股票/指数的历史日线并落库到本地（供事件研究、回测使用）。同一个标的多采几次会自动合并去重，不会重复占空间。',
    parameters: {
      type: 'object',
      properties: {
        symbols: { type: 'array', items: { type: 'string' }, description: '标的数组，如 ["SH600519","IDX000300"]' },
        count: { type: 'integer', minimum: 60, maximum: 800, description: '拉取根数，默认 500（约两年）' },
        adjust: { type: 'string', enum: ['qfq', 'hfq', 'none'], description: '复权方式，默认 qfq' },
      },
      required: ['symbols'],
      additionalProperties: false,
    },
    async execute(args) {
      const list = Array.isArray(args.symbols) ? args.symbols.slice(0, 30) : []
      if (list.length === 0) throw new Error('symbols 不能为空')
      try {
        const out = await runPythonJson('collectors/collector.py', [
          'fetch-many', ...list,
          '--count', String(args.count || 500),
          '--adjust', String(args.adjust || 'qfq'),
        ])
        return out
      } catch (e) {
        throw new Error('采集失败：' + String(e?.message || e))
      }
    },
  })

  reg({
    name: 'local_data_status',
    description: '查看本地历史数据库里已有哪些标的、多少行、时间范围与数据来源。做量化验证前先查这个，避免对没有数据的标的做事件研究。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '只看某只标的（可选）' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const argv = ['status']
      if (args.symbol) argv.push('--symbol', String(args.symbol))
      try {
        return await runPythonJson('collectors/collector.py', argv)
      } catch (e) {
        throw new Error('查询失败：' + String(e?.message || e))
      }
    },
  })

  return count
}
