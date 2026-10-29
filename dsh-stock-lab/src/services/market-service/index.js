/**
 * index.js — MarketService：Stock Lab 唯一数据入口
 *
 * 职责：
 *   - 对 UI / AI Tools 暴露稳定接口（见 ARCHITECTURE §3）
 *   - symbol 规范化（symbols.js）
 *   - 多数据源路由与 fallback（tencent 主 → sina 备）
 *   - TTL 缓存 + single-flight
 *   - 输出统一 schema，不暴露数据源原生字段名
 *
 * 禁止：datasource/* 被 UI/Tools 直接引用；本层之外的代码 import datasource 视为架构违规。
 */

import { TtlCache } from './cache.js'
import { normalize, INDEX_MAP } from './symbols.js'
import * as tencent from '../../datasource/tencent.js'
import * as sina from '../../datasource/sina.js'
import * as eastmoney from '../../datasource/eastmoney.js'
import * as local from '../../datasource/local.js'

const TTL = {
  quote: 3000,      // 实时行情 3s
  kline: 60000,     // K线 60s（盘中新 bar 刷新粒度）
  minute: 5000,     // 分时 5s
  search: 600000,   // 搜索 10min
  overview: 5000,   // 大盘概览 5s
  breadth: 10000,   // 涨跌家数 10s
  moneyFlow: 15000, // 资金流 15s
  financials: 86400000, // 财务 24h
  profile: 86400000,    // 公司概况 24h
  news: 300000,         // 新闻 5min
  sectorList: 15000,    // 板块列表 15s
  sector: 10000,        // 单个板块 10s
  universe: 3600000,    // 全 A 股标的池 1h（5000+ 条，翻页抓取约 1–3s，别频繁拉）
}

export class MarketService {
  constructor(options = {}) {
    this.cache = new TtlCache(options.now)
    this.log = options.log || (() => {})
  }

  // ── 行情 ──────────────────────────────────────────────

  async getQuote(input) {
    const info = normalize(input)
    return this.cache.get(`quote:${info.symbol}`, TTL.quote, async () => {
      try {
        return await tencent.getQuote(info.symbol)
      } catch (e) {
        this.log('tencent quote 失败，无备源：' + e.message)
        throw e
      }
    })
  }

  async getQuotes(inputs) {
    // 并发 + single-flight 合并由 cache 保证
    return Promise.all(inputs.map((s) => this.getQuote(s)))
  }

  /**
   * K线。source 路由：
   *   'auto'（默认）— 本地库覆盖足够且新鲜时用本地（可复现、无网络），否则走实时源
   *   'local'       — 只用本地库，没有则报错
   *   'live'        — 强制实时源
   */
  async getKline(input, opts = {}) {
    const info = normalize(input)
    const timeframe = opts.timeframe || '1d'
    const adjust = opts.adjust || 'qfq'
    const want = opts.count || 320
    const mode = opts.source || 'auto'
    const key = `kline:${info.symbol}:${timeframe}:${adjust}:${want}:${opts.end || ''}:${mode}`
    return this.cache.get(key, TTL.kline, async () => {
      if (mode !== 'live') {
        const fromLocal = local.getLocalKline(info.symbol, { timeframe, adjust, count: want, start: opts.start, end: opts.end })
        if (fromLocal && fromLocal.length > 0) {
          // 本地数据是否"够长且新鲜"：够长指满足请求根数；新鲜指最后一根不早于实时源的上一根太多
          const meta = local.getLocalMeta(info.symbol, timeframe, adjust)
          const enough = !meta || fromLocal.length >= Math.min(want, meta.rows)
          if (mode === 'local') {
            if (!enough) throw new Error(`本地库仅 ${fromLocal.length} 根，不足 ${want} 根（可用 collect_history 补采）`)
            return fromLocal
          }
          if (enough && this._localIsUsable(meta)) {
            return fromLocal
          }
        } else if (mode === 'local') {
          throw new Error(`本地库没有 ${info.symbol} 的 ${timeframe}/${adjust} 数据（先用 collect_history 采集）`)
        }
      }
      try {
        const bars = await tencent.getKline(info.symbol, { timeframe, adjust, count: want, end: opts.end })
        return bars
      } catch (e) {
        // 日线可降级新浪（不复权）
        if (timeframe === '1d') {
          this.log('tencent kline 失败，降级 sina：' + e.message)
          return sina.getKline(info.symbol, { timeframe, adjust, count: want })
        }
        throw e
      }
    })
  }

  /** 本地数据是否可用于"最新"分析：最后一根距今不超过 N 个自然日 */
  _localIsUsable(meta) {
    if (!meta || !meta.last_bar) return true // 无元信息时按可用处理
    const last = Date.parse(String(meta.last_bar) + 'T00:00:00+08:00')
    if (!Number.isFinite(last)) return true
    const days = (Date.now() - last) / 86400000
    return days <= 7
  }

  /**
   * K 线 + 溯源信息（工具层报告"这批数据从哪来、是哪一版"时用）。
   * 返回结构与 getKline 一致，额外带 provenance。
   */
  async getKlineInfo(input, opts = {}) {
    const info = normalize(input)
    const timeframe = opts.timeframe || '1d'
    const adjust = opts.adjust || 'qfq'
    const bars = await this.getKline(info.symbol, opts)
    const src = bars[0]?.source || 'unknown'
    const meta = src === 'local' ? local.getLocalMeta(info.symbol, timeframe, adjust) : null
    return {
      symbol: info.symbol,
      timeframe,
      adjust,
      bars,
      provenance: {
        dataSource: src === 'local' ? '本地历史库' : src === 'tencent' ? '腾讯实时接口' : src === 'sina' ? '新浪备源' : src,
        sourceKey: src,
        upstreamSource: meta?.source || null,
        collectedAt: meta?.fetched_at || null,
        localRows: meta?.rows ?? null,
        localRange: meta ? `${meta.first_bar} ~ ${meta.last_bar}` : null,
        dataVersion: src === 'local' ? local.localDataVersion([info.symbol], timeframe, adjust) : null,
        reproducible: src === 'local',
      },
    }
  }

  /** 显式取本地库（研究用；不看新鲜度）。没有数据时抛错。 */
  getKlineFromLocal(input, opts = {}) {
    const info = normalize(input)
    const timeframe = opts.timeframe || '1d'
    const adjust = opts.adjust || 'qfq'
    const bars = local.getLocalKline(info.symbol, { timeframe, adjust, count: opts.count, start: opts.start, end: opts.end })
    if (!bars || bars.length === 0) {
      throw new Error(`本地库没有 ${info.symbol} 的 ${timeframe}/${adjust} 数据（先用 collect_history 采集）`)
    }
    return bars
  }

  /** 本地库状态（供工具与 UI 展示可复现性信息） */
  getLocalDataStatus() {
    const { dataDir, symbols } = local.listLocalMeta()
    return { dataDir, symbols, diagnostics: local.localDiagnostics(), available: symbols.length > 0 }
  }

  /** 数据版本指纹（Research Note 记录用） */
  getDataVersion(symbols, opts = {}) {
    return local.localDataVersion(symbols, opts.timeframe || '1d', opts.adjust || 'qfq')
  }

  async getMinute(input) {
    const info = normalize(input)
    return this.cache.get(`minute:${info.symbol}`, TTL.minute, () => tencent.getMinute(info.symbol))
  }

  // ── 市场结构 ──────────────────────────────────────────

  async getIndex(input) { return this.getQuote(input) }

  /** 大盘概览：四个核心指数 + 涨跌家数 + 成交额 + 情绪合成 */
  async getMarketOverview() {
    return this.cache.get('overview', TTL.overview, async () => {
      const symbols = ['IDX000001', 'IDX399001', 'IDX399006', 'IDX000300']
      const [indices, breadth] = await Promise.all([
        Promise.all(symbols.map(async (s) => {
          const q = await this.getQuote(s)
          const idx = INDEX_MAP[s]
          return { ...q, name: idx ? idx.name : q.name }
        })),
        this.getMarketBreadth().catch(() => null),
      ])
      // 两市成交额：上证 + 深证成交额之和（腾讯 amount 已归一为元）
      const sh = indices.find((i) => i.symbol === 'IDX000001')
      const sz = indices.find((i) => i.symbol === 'IDX399001')
      const totalAmount = sh?.amount && sz?.amount ? sh.amount + sz.amount : null
      return {
        indices,
        breadth,
        totalAmount,
        sentiment: this._sentiment(indices, breadth),
        timestamp: new Date().toISOString(),
        source: 'tencent+eastmoney',
      }
    })
  }

  /**
   * 市场情绪合成（纯代码计算，LLM 不算——原则 3）。
   * 由涨跌家数比 + 主要指数涨跌 合成 0–100 分。
   */
  _sentiment(indices, breadth) {
    if (!breadth || breadth.total === 0) return null
    const upRatio = breadth.up / breadth.total
    const idxAvg = indices.length
      ? indices.reduce((a, i) => a + (i.changePct || 0), 0) / indices.length
      : 0
    // 涨跌家数占 70%，指数涨跌占 30%（把 ±2% 映射到 ±1）
    const score = Math.max(0, Math.min(100, upRatio * 70 + (50 + idxAvg * 15) * 0.3))
    const label = score >= 70 ? '强' : score >= 55 ? '偏强' : score >= 45 ? '中性' : score >= 30 ? '偏弱' : '弱'
    return { score: Math.round(score * 10) / 10, label, upRatio: Math.round(upRatio * 1000) / 10, method: 'upRatio*70 + indexChange*30' }
  }

  // ── 市场宽度 / 资金 / 财务 / 公司 / 新闻 ────────────────

  async getMarketBreadth() {
    return this.cache.get('breadth', TTL.breadth, () => eastmoney.getMarketBreadth())
  }

  async getMoneyFlow(input) {
    const info = normalize(input)
    return this.cache.get(`moneyflow:${info.symbol}`, TTL.moneyFlow, () => eastmoney.getMoneyFlow(info.symbol))
  }

  async getFinancials(input) {
    const info = normalize(input)
    return this.cache.get(`fin:${info.symbol}`, TTL.financials, () => eastmoney.getFinancials(info.symbol))
  }

  async getCompanyProfile(input) {
    const info = normalize(input)
    return this.cache.get(`profile:${info.symbol}`, TTL.profile, () => eastmoney.getCompanyProfile(info.symbol))
  }

  async getNews(input, opts = {}) {
    const info = normalize(input)
    const key = `news:${info.symbol}:${opts.limit || 10}`
    return this.cache.get(key, TTL.news, () => eastmoney.getNews(info.symbol, opts))
  }

  // ── 行业 / 板块 ───────────────────────────────────────

  /** 板块列表（行业/概念/地域），按涨跌幅或资金流排序 */
  async getSectorList(opts = {}) {
    const key = `sectors:${opts.type || 'industry'}:${opts.sort || 'changePct'}:${opts.limit || 50}`
    return this.cache.get(key, TTL.sectorList, () => eastmoney.getSectorList(opts))
  }

  /** 某板块行情（含由成分股统计的涨跌家数——不采信东财对板块指数的 f104/f105/f106） */
  async getSector(sectorId, opts = {}) {
    const key = `sector:${sectorId}:${opts.withBreadth ? 'b' : 'n'}`
    return this.cache.get(key, TTL.sector, async () => {
      const quote = await eastmoney.getSectorQuote(sectorId)
      if (!opts.withBreadth) return quote
      const members = await eastmoney.getSectorMembers(sectorId, { limit: 200 }).catch(() => [])
      const pcts = members.map((m) => m.changePct).filter((v) => typeof v === 'number')
      const sorted = [...pcts].sort((a, b) => a - b)
      return {
        ...quote,
        memberCount: members.length,
        upCount: pcts.filter((v) => v > 0).length,
        downCount: pcts.filter((v) => v < 0).length,
        flatCount: pcts.filter((v) => v === 0).length,
        changeMedian: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
        breadthSource: 'computed-from-members',
      }
    })
  }

  /** 某板块成分股 */
  async getSectorMembers(sectorId, opts = {}) {
    const key = `sectorMembers:${sectorId}:${opts.limit || 30}`
    return this.cache.get(key, TTL.sectorList, () => eastmoney.getSectorMembers(sectorId, opts))
  }

  /** 个股所属行业（含反查到的板块代码与板块涨跌） */
  async getStockSector(input) {
    const info = normalize(input)
    return this.cache.get(`stockSector:${info.symbol}`, TTL.sector, () => eastmoney.getStockSector(info.symbol))
  }

  /** 全 A 股标的池（东财 clist，分页取全；缓存 1 小时） */
  async getStockUniverse(opts = {}) {
    return this.cache.get('stockUniverse', TTL.universe, () => eastmoney.getStockUniverse(opts))
  }

  // ── 本地历史库（只读；选股 / 研究用） ─────────────────────
  //
  // 为什么放在 MarketService：架构铁律是"只有 market-service 可以 import datasource/"。
  // 选股引擎需要枚举本地库、读本地 K 线、算数据版本——都必须经这里，不能自己去 import。

  /** 本地库已落库的标的列表（含行数/区间/来源） */
  listLocalMeta() {
    return local.listLocalMeta()
  }

  /** 本地库数据版本指纹（文件大小 + mtime；数据一变就变） */
  localDataVersion(symbols, timeframe = '1d', adjust = 'qfq') {
    return local.localDataVersion(symbols, timeframe, adjust)
  }

  /** 只读本地 K 线（不落网、不写盘；没有数据返回 null） */
  getLocalKline(input, opts = {}) {
    const info = normalize(input)
    return local.getLocalKline(info.symbol, opts)
  }

  // ── 检索 ──────────────────────────────────────────────

  async search(query) {
    return this.cache.get(`search:${String(query).trim()}`, TTL.search, () => tencent.search(query))
  }

  // ── 元信息 ────────────────────────────────────────────

  normalizeSymbol(input) { return normalize(input) }
}
