/**
 * tools/index.js — AI Tools 注册（只调 MarketService）
 *
 * 设计原则（ARCHITECTURE §5）：
 *   - 工具少而稳，不暴露细碎底层
 *   - 输出结构化 JSON，且已做数值计算（LLM 不算关键金融数据）
 *   - 错误翻译成人话，不让模型看到上游原始报错
 */

const OUT_TEXT = {
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
}

/** 计算区间收益率（%），纯代码计算 */
function retPct(bars, n) {
  if (!Array.isArray(bars) || bars.length < n + 1) return null
  const last = bars.at(-1).close
  const prev = bars.at(-(n + 1)).close
  if (!prev) return null
  return Math.round(((last - prev) / prev) * 10000) / 100
}

/** 波动率（日收益标准差年化，%） */
function realizedVol(bars, n = 20) {
  if (!Array.isArray(bars) || bars.length < n + 1) return null
  const slice = bars.slice(-(n + 1))
  const rets = []
  for (let i = 1; i < slice.length; i++) {
    const a = slice[i - 1].close, b = slice[i].close
    if (a && b) rets.push((b - a) / a)
  }
  if (rets.length < 2) return null
  const mean = rets.reduce((x, y) => x + y, 0) / rets.length
  const varr = rets.reduce((x, y) => x + (y - mean) ** 2, 0) / (rets.length - 1)
  return Math.round(Math.sqrt(varr) * Math.sqrt(252) * 10000) / 100
}

/** 成交量 z-score（近 20 日） */
function volumeZScore(bars, n = 20) {
  if (!Array.isArray(bars) || bars.length < n + 2) return null
  const vols = bars.slice(-(n + 1), -1).map((b) => b.volume).filter((v) => v !== null)
  if (vols.length < 5) return null
  const mean = vols.reduce((a, b) => a + b, 0) / vols.length
  const sd = Math.sqrt(vols.reduce((a, b) => a + (b - mean) ** 2, 0) / (vols.length - 1))
  const today = bars.at(-1).volume
  if (today === null) return null
  // sd 为 0 表示历史成交量恒定（一字板/长期停牌后恢复）：今日只要偏离均值就是无限异常，
  // 用 ±99 封顶表示"极端偏离"，而不是返回 null 让异常消失。
  if (!sd) return today === mean ? 0 : (today > mean ? 99 : -99)
  return Math.round(((today - mean) / sd) * 100) / 100
}

function friendly(err) {
  const m = String(err?.message || err)
  if (/timeout|abort/i.test(m)) return '行情接口超时，请稍后重试'
  if (/HTTP 4|HTTP 5/.test(m)) return '数据源暂时不可用：' + m
  return m
}

export function registerStockTools(ctx, market) {
  if (ctx.tools === undefined) {
    ctx.logger?.warn?.('stock-lab: tools 服务不可用，AI 工具未注册（行情 UI 不受影响）')
    return 0
  }
  let count = 0
  const reg = (def) => { ctx.tools.register({ output: OUT_TEXT, ...def }); count++ }

  // ── 1. stock_quote ──────────────────────────────────
  reg({
    name: 'stock_quote',
    description: '查询 A 股/指数实时行情：现价、涨跌幅、开高低、成交量/额、换手、PE、停牌与 ST 标志。支持多只，代码形如 600519 / 300750 / IDX000300（指数需 IDX 前缀）。数据经 MarketService 统一归一，已含来源与时间戳。',
    parameters: {
      type: 'object',
      properties: {
        symbols: { type: 'array', items: { type: 'string' }, description: '股票或指数代码数组，如 ["600519","IDX000300"]' },
      },
      required: ['symbols'],
      additionalProperties: false,
    },
    async execute(args) {
      const list = Array.isArray(args.symbols) ? args.symbols.slice(0, 20) : []
      if (list.length === 0) throw new Error('symbols 不能为空')
      try {
        const quotes = await market.getQuotes(list)
        return { quotes, asOf: new Date().toISOString() }
      } catch (e) { throw new Error(friendly(e)) }
    },
  })

  // ── 2. stock_kline ──────────────────────────────────
  reg({
    name: 'stock_kline',
    description: '查询个股/指数 K 线，并同时返回由代码算好的区间收益、年化波动率、成交量 z-score（这些数值不要自己重算）。返回最近 N 根 OHLCV。可选 source 指定数据来源：auto（默认，本地历史库优先、缺失则走实时）、local（只用本地库，可复现）、live（强制实时）。返回值里的 provenance 会说明这批数据从哪来、是否可复现、数据版本指纹。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '股票代码，如 600519' },
        timeframe: { type: 'string', enum: ['1d', '1w', '1M'], description: '周期，默认 1d' },
        count: { type: 'integer', minimum: 20, maximum: 800, description: '根数，默认 120' },
        adjust: { type: 'string', enum: ['qfq', 'hfq', 'none'], description: '复权方式，默认 qfq' },
        source: { type: 'string', enum: ['auto', 'local', 'live'], description: '数据来源偏好，默认 auto' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
    async execute(args) {
      try {
        const info = await market.getKlineInfo(args.symbol, {
          timeframe: args.timeframe || '1d', adjust: args.adjust || 'qfq',
          count: args.count || 120, source: args.source,
        })
        const bars = info.bars
        return {
          symbol: args.symbol,
          timeframe: info.timeframe,
          adjust: info.adjust,
          count: bars.length,
          bars: bars.slice(-60), // 控 token：只回最近 60 根
          stats: {
            return5d: retPct(bars, 5),
            return20d: retPct(bars, 20),
            return60d: retPct(bars, 60),
            realizedVol20d: realizedVol(bars, 20),
            volumeZScore20d: volumeZScore(bars, 20),
          },
          provenance: info.provenance,
          note: 'bars 仅返回最近 60 根，统计量基于完整请求区间计算',
        }
      } catch (e) { throw new Error(friendly(e)) }
    },
  })

  // ── 3. market_overview ──────────────────────────────
  reg({
    name: 'market_overview',
    description: 'A 股大盘概览：上证/深证/创业板/沪深300 指数、两市成交额、涨跌家数（宽度）、以及由代码合成的市场情绪分（0-100，方法固定可复现）。回答"今天市场怎么样"用这个。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      try { return await market.getMarketOverview() } catch (e) { throw new Error(friendly(e)) }
    },
  })

  // ── 4. stock_relative_strength ──────────────────────
  reg({
    name: 'stock_relative_strength',
    description: '个股相对强弱：个股 vs 基准指数（默认沪深300）在 5/20/60 日的超额收益、个股与指数的相关系数、以及个股/指数波动率对比。用于判断"个股是自身问题还是跟跌大盘"。数值全部由代码计算。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '股票代码' },
        benchmark: { type: 'string', description: '基准指数，默认 IDX000300' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
    async execute(args) {
      const bench = args.benchmark || 'IDX000300'
      try {
        // 用更长的窗口（本地库有数据时可达 500 根），并把来源一并返回
        const [stockInfo, benchInfo] = await Promise.all([
          market.getKlineInfo(args.symbol, { timeframe: '1d', adjust: 'qfq', count: 500 }),
          market.getKlineInfo(bench, { timeframe: '1d', adjust: 'qfq', count: 500 }),
        ])
        const bars = stockInfo.bars
        const bBars = benchInfo.bars
        // 按日期对齐
        const bMap = new Map(bBars.map((b) => [b.time, b.close]))
        const aligned = bars.filter((b) => bMap.has(b.time)).map((b) => ({ time: b.time, close: b.close, bclose: bMap.get(b.time) }))
        const excess = (n) => {
          const s = retPct(aligned.map((x) => ({ close: x.close })), n)
          const b = retPct(aligned.map((x) => ({ close: x.bclose })), n)
          if (s === null || b === null) return null
          return { stock: s, benchmark: b, excess: Math.round((s - b) * 100) / 100 }
        }
        // 相关系数（日收益，20 日）
        let corr = null
        const slice = aligned.slice(-21)
        if (slice.length >= 10) {
          const rs = [], rb = []
          for (let i = 1; i < slice.length; i++) {
            if (!slice[i - 1].close || !slice[i - 1].bclose) continue
            rs.push((slice[i].close - slice[i - 1].close) / slice[i - 1].close)
            rb.push((slice[i].bclose - slice[i - 1].bclose) / slice[i - 1].bclose)
          }
          if (rs.length > 2) {
            const mr = rs.reduce((a, b) => a + b, 0) / rs.length
            const mb = rb.reduce((a, b) => a + b, 0) / rb.length
            let cov = 0, vr = 0, vb = 0
            for (let i = 0; i < rs.length; i++) {
              cov += (rs[i] - mr) * (rb[i] - mb)
              vr += (rs[i] - mr) ** 2
              vb += (rb[i] - mb) ** 2
            }
            if (vr > 0 && vb > 0) corr = Math.round((cov / Math.sqrt(vr * vb)) * 1000) / 1000
          }
        }
        return {
          symbol: args.symbol,
          benchmark: bench,
          alignedDays: aligned.length,
          periods: { d5: excess(5), d20: excess(20), d60: excess(60) },
          correlation20d: corr,
          volatility: {
            stock20d: realizedVol(aligned.map((x) => ({ close: x.close })), 20),
            benchmark20d: realizedVol(aligned.map((x) => ({ close: x.bclose })), 20),
          },
          provenance: {
            stock: stockInfo.provenance,
            benchmark: benchInfo.provenance,
          },
          note: '超额收益 = 个股收益率 − 基准收益率；相关系数基于 20 日日收益。均是统计描述，不构成因果判断。',
        }
      } catch (e) { throw new Error(friendly(e)) }
    },
  })

  // ── 5. stock_financials ─────────────────────────────
  reg({
    name: 'stock_financials',
    description: '个股财务卡：最近 12 期报告期的营收/净利及同比、ROE、毛利率、净利率、负债率、EPS、BPS。只陈述数字与同比变化，不下"好/差"结论。',
    parameters: {
      type: 'object',
      properties: { symbol: { type: 'string', description: '股票代码' } },
      required: ['symbol'],
      additionalProperties: false,
    },
    async execute(args) {
      try { return await market.getFinancials(args.symbol) } catch (e) { throw new Error(friendly(e)) }
    },
  })

  // ── 6. stock_money_flow ─────────────────────────────
  reg({
    name: 'stock_money_flow',
    description: '个股资金流：今日与近 5 日主力净流入（元）、超大单/大单/中单/小单分解、以及逐日序列。数值来自数据源，不由模型计算。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '股票代码' },
        days: { type: 'integer', minimum: 1, maximum: 60, description: '回溯交易日数，默认 10' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
    async execute(args) {
      try { return await market.getMoneyFlow(args.symbol, { days: args.days || 10 }) } catch (e) { throw new Error(friendly(e)) }
    },
  })

  // ── 7. stock_news ───────────────────────────────────
  reg({
    name: 'stock_news',
    description: '检索个股相关财经新闻与公告标题（东财站内搜索）。只返回标题/时间/摘要/链接，不做利好利空判断。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '股票代码' },
        limit: { type: 'integer', minimum: 1, maximum: 30, description: '条数，默认 10' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
    async execute(args) {
      try { return { symbol: args.symbol, news: await market.getNews(args.symbol, { limit: args.limit || 10 }) } } catch (e) { throw new Error(friendly(e)) }
    },
  })

  // ── 9. sector_overview ──────────────────────────────
  reg({
    name: 'sector_overview',
    description: '行业/概念板块概览：可列出涨幅榜（含主力净流入、领涨股），也可查询指定板块的行情与成分股。用于回答"今天哪些行业强""这个板块里谁在涨"，以及判断个股下跌是个股问题还是行业普跌。',
    parameters: {
      type: 'object',
      properties: {
        sectorId: { type: 'string', description: '板块代码 BKxxxx，查该板块详情；不传则返回涨幅榜' },
        symbol: { type: 'string', description: '股票代码，查该股所属行业（与 sectorId 二选一）' },
        type: { type: 'string', enum: ['industry', 'concept', 'region'], description: '板块类型，默认行业' },
        sort: { type: 'string', enum: ['changePct', 'moneyFlow'], description: '排序，默认涨跌幅' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: '条数，默认 20' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      try {
        // 查个股所属行业
        if (args.symbol && !args.sectorId) {
          const s = await market.getStockSector(args.symbol)
          if (!s.sector) return { symbol: args.symbol, industry: s.industry, note: '未能反查到板块代码（该行业名可能不在板块列表中）' }
          const [detail, members] = await Promise.all([
            market.getSector(s.sector.id, { withBreadth: true }),
            market.getSectorMembers(s.sector.id, { limit: args.limit || 20 }),
          ])
          return { symbol: args.symbol, industry: s.industry, sector: detail, topMembers: members }
        }
        // 查指定板块
        if (args.sectorId) {
          const [detail, members] = await Promise.all([
            market.getSector(args.sectorId, { withBreadth: true }),
            market.getSectorMembers(args.sectorId, { limit: args.limit || 20 }),
          ])
          return { sector: detail, members }
        }
        // 涨幅榜
        const list = await market.getSectorList({
          type: args.type || 'industry',
          sort: args.sort || 'changePct',
          limit: args.limit || 20,
        })
        return { type: args.type || 'industry', sort: args.sort || 'changePct', count: list.length, sectors: list }
      } catch (e) { throw new Error(friendly(e)) }
    },
  })

  // ── 10. stock_research_snapshot（核心聚合工具） ──────
  reg({
    name: 'stock_research_snapshot',
    description: '【核心工具】一次调用返回一只股票的标准研究快照：行情 + 市场环境 + 行业 + 价格行为 + 量能 + 波动 + 相对强弱 + 资金流 + 财务 + 新闻 + 自动异常检测。回答"这只股票最近怎么了/为什么这样"时优先用它，避免逐个调用底层工具。所有统计量均由代码计算，anomalies 是代码判定的异常，不是模型猜测。',
    parameters: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: '股票代码，如 600519' },
        benchmark: { type: 'string', description: '基准指数，默认 IDX000300' },
      },
      required: ['symbol'],
      additionalProperties: false,
    },
    async execute(args) {
      const bench = args.benchmark || 'IDX000300'
      try {
        // 用 500 根（约两年）而非 120 根：本地库有数据时自动优先，
        // 使 60 日/120 日/年化等统计更稳；同时带回溯源信息
        const [quote, profile, overview, stockK, benchK, moneyFlow, fin, news, stockSector] = await Promise.all([
          market.getQuote(args.symbol).catch((e) => ({ error: friendly(e) })),
          market.getCompanyProfile(args.symbol).catch(() => null),
          market.getMarketOverview().catch(() => null),
          market.getKlineInfo(args.symbol, { timeframe: '1d', adjust: 'qfq', count: 500 }).catch(() => null),
          market.getKlineInfo(bench, { timeframe: '1d', adjust: 'qfq', count: 500 }).catch(() => null),
          market.getMoneyFlow(args.symbol, { days: 10 }).catch(() => null),
          market.getFinancials(args.symbol).catch(() => null),
          market.getNews(args.symbol, { limit: 8 }).catch(() => []),
          market.getStockSector(args.symbol).catch(() => null),
        ])
        const bars = stockK?.bars || []
        const bBars = benchK?.bars || []

        // 行业对比：取板块成分股同期涨幅中位数，作为"同业"参照
        let sectorInfo = { industry: profile?.industry ?? null, members: '（Phase 2 接入行业成分）' }
        if (stockSector?.sector) {
          const sec = stockSector.sector
          const members = await market.getSectorMembers(sec.id, { limit: 50 }).catch(() => [])
          const pcts = members.map((m) => m.changePct).filter((v) => typeof v === 'number')
          const sorted = [...pcts].sort((a, b) => a - b)
          const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
          const stockPct = quote?.changePct
          sectorInfo = {
            id: sec.id,
            name: sec.name,
            changePct: sec.changePct,
            mainNetInflow: sec.mainNetInflow ?? null,
            memberCount: members.length,
            memberChangeMedian: median,
            memberUpCount: pcts.filter((v) => v > 0).length,
            memberDownCount: pcts.filter((v) => v < 0).length,
            stockVsSectorToday: stockPct !== null && sec.changePct !== null
              ? Math.round((stockPct - sec.changePct) * 100) / 100 : null,
            note: 'sector 涨跌幅为板块指数当日涨跌；stockVsSectorToday = 个股当日涨跌 − 板块当日涨跌（仅当日，多日行业对比待历史落库）',
          }
        }

        // 相对强弱
        const bMap = new Map(bBars.map((b) => [b.time, b.close]))
        const aligned = bars.filter((b) => bMap.has(b.time))
        const excess = (n) => {
          const s = retPct(aligned, n)
          const b = retPct(aligned.map((x) => ({ close: bMap.get(x.time) })), n)
          if (s === null || b === null) return null
          return { stock: s, benchmark: b, excess: Math.round((s - b) * 100) / 100 }
        }

        // 异常检测（纯代码判定）
        const anomalies = []
        const volZ = volumeZScore(bars, 20)
        if (volZ !== null && Math.abs(volZ) >= 2) {
          anomalies.push({
            kind: 'volume', metric: 'volumeZScore20d', value: volZ,
            note: volZ > 0 ? `成交量显著放大（${volZ}σ），为近 20 日均量的异常水平` : `成交量显著萎缩（${volZ}σ）`,
          })
        }
        const e20 = excess(20)
        if (e20 && Math.abs(e20.excess) >= 5) {
          anomalies.push({
            kind: 'relativeStrength', metric: 'excess20d', value: e20.excess,
            note: e20.excess > 0 ? `20 日跑赢基准 ${e20.excess} 个百分点，超额收益显著` : `20 日跑输基准 ${Math.abs(e20.excess)} 个百分点，负超额显著`,
          })
        }
        const r5 = retPct(bars, 5), r20 = retPct(bars, 20)
        if (r5 !== null && r20 !== null && Math.abs(r5 - r20 / 4) >= 8) {
          anomalies.push({
            kind: 'priceMomentum', metric: 'return5d vs return20d/4', value: { r5, r20 },
            note: '近 5 日涨跌幅与 20 日均速明显偏离，短期动量异常',
          })
        }
        const volNow = realizedVol(bars, 20), volPrev = realizedVol(bars.slice(0, -20), 20)
        if (volNow !== null && volPrev !== null && volPrev > 0 && volNow / volPrev >= 1.6) {
          anomalies.push({
            kind: 'volatility', metric: 'realizedVol20d ratio', value: Math.round((volNow / volPrev) * 100) / 100,
            note: `20 日波动率较前一期放大 ${Math.round((volNow / volPrev - 1) * 100)}%`,
          })
        }
        // 个股 vs 行业：当日显著跑输/跑赢板块
        if (sectorInfo.stockVsSectorToday !== null && sectorInfo.stockVsSectorToday !== undefined
            && Math.abs(sectorInfo.stockVsSectorToday) >= 3) {
          anomalies.push({
            kind: 'sectorRelative', metric: 'stockVsSectorToday', value: sectorInfo.stockVsSectorToday,
            note: sectorInfo.stockVsSectorToday > 0
              ? `当日跑赢所属板块 ${sectorInfo.stockVsSectorToday} 个百分点，个股有独立强势`
              : `当日跑输所属板块 ${Math.abs(sectorInfo.stockVsSectorToday)} 个百分点，个股有独立弱势`,
          })
        }

        return {
          meta: {
            symbol: args.symbol, benchmark: bench, asOf: new Date().toISOString(),
            sources: [...new Set([quote?.source, profile?.source, overview?.source, moneyFlow?.source, fin?.source, 'tencent'].filter(Boolean))],
            barsUsed: bars.length,
            provenance: {
              stock: stockK?.provenance ?? null,
              benchmark: benchK?.provenance ?? null,
            },
            note: '所有统计量由代码计算；anomalies 为规则判定结果，需结合新闻与事件解释，不可直接当因果。'
              + 'provenance.reproducible=true 表示该批 K 线来自本地历史库（可用数据版本指纹复现）。',
          },
          stock: { quote, profile },
          market: overview ? { indices: overview.indices, breadth: overview.breadth, totalAmount: overview.totalAmount, sentiment: overview.sentiment } : null,
          sector: sectorInfo,
          priceBehavior: {
            return5d: r5, return20d: r20, return60d: retPct(bars, 60),
            return120d: retPct(bars, 120),
            barsAvailable: bars.length,
            rangeStart: bars[0]?.time ?? null,
            rangeEnd: bars.at(-1)?.time ?? null,
          },
          volumeBehavior: { volumeZScore20d: volZ, turnoverRate: quote?.turnover ?? null },
          volatility: {
            realized20d: volNow, previous20d: volPrev,
            realized60d: realizedVol(bars, 60),
          },
          relativePerformance: { d5: excess(5), d20: e20, d60: excess(60), d120: excess(120) },
          moneyFlow: moneyFlow ? { today: moneyFlow.today, mainNetInflow5d: moneyFlow.mainNetInflow5d } : null,
          financials: fin ? { latest: fin.reports?.[0] ?? null, reportCount: fin.reports?.length ?? 0 } : null,
          news: news.slice(0, 8),
          anomalies,
        }
      } catch (e) { throw new Error(friendly(e)) }
    },
  })

  ctx.logger?.info?.('stock-lab: 已注册 %d 个 AI 工具', count)
  return count
}
