# ARCHITECTURE.md — DSH Stock Lab 系统架构设计

> 版本 v0.1 · 2026-10-23 · 状态：初稿（Task 1 源码评审后可能微调复用层）
> 2026-10-27 更新：§15 决策表状态按代码核实（D10–D13 改为"已实施"、新增 D18/D19），§9.3/§9.4 归档 D18/D19。
> 核心原则：**UI 和 LLM 都不得直接访问具体行情 API；一切数据经 MarketService；不 fork DSH Core。**

---

## 1. 总体架构

```text
┌─────────────────────────────────────────────────────────┐
│                 DSH Web UI（Client 插件层）              │
│  Stock Workspace Page: 指数栏 │ 自选/搜索 │ K线 │ AI Chat │
│  底部 Tabs: News │ Events │ Fundamentals │ Quant │ Notes│
└──────────────┬──────────────────────────────────────────┘
               │ ctx.service 调用（禁止直连外部 API）
               ▼
┌─────────────────────────────────────────────────────────┐
│              DSH Host 插件层（Node.js）                  │
│                                                         │
│  ┌───────────────┐   ┌──────────────────────────────┐   │
│  │  AI Tools 层  │   │   StockContext Provider      │   │
│  │ stock_quote   │   │ (当前股票/时间范围/基准 → LLM)│   │
│  │ stock_kline   │   └──────────────────────────────┘   │
│  │ research_…    │                                       │
│  └──────┬────────┘                                       │
│         │ 只允许调用                                      │
│         ▼                                                │
│  ┌─────────────────────────────────────────────────┐    │
│  │            MarketService（统一数据接口）          │    │
│  │  代码规范化 / 缓存路由 / 多源 fallback / 字段归一  │    │
│  └──────┬───────────────────┬──────────────────────┘    │
│         │                   │                            │
│  ┌──────▼──────┐     ┌──────▼───────────┐               │
│  │ datasource/ │     │  Local Data Layer │               │
│  │ eastmoney   │     │  (缓存读取/写入)   │               │
│  │ pytdx       │     └───────────────────┘               │
│  │ tushare     │                                          │
│  └─────────────┘                                          │
└───────────────────────────────────────────────────────────┘
               │ Python 子进程 / sidecar（重计算）
               ▼
┌─────────────────────────────────────────────────────────┐
│         Python Backend（Quant / Research 引擎）          │
│  collectors/  quant/  research/  storage/               │
│  DuckDB · Parquet · SQLite                              │
└─────────────────────────────────────────────────────────┘
```

分层职责：

| 层 | 职责 | 禁止 |
|---|---|---|
| Client UI | 渲染、交互、把 UI 状态写入 StockContext | 直连任何行情/数据 API（包括 fetch 东方财富） |
| AI Tools | 给 LLM 的稳定结构化工具 | 直接 import datasource |
| MarketService | 唯一数据入口：symbol 规范化、缓存、fallback、schema 归一 | 暴露数据源原生字段名 |
| datasource/* | 单一数据源的适配器 | 被 UI/Tools 直接引用 |
| Python Backend | 历史数据落库、量化计算、事件研究 | 被 LLM 当计算器实时调用（走批处理+落库） |

---

## 2. 代码组织（monorepo，单插件仓库起步）

第一阶段在**一个插件仓库**内实现，但目录边界按下述模块切分，保证未来可拆包：

```text
dsh-stock-lab/
├── package.json
├── cordis.patch.yml
├── README.md
├── icon.svg / locale/
│
├── src/
│   ├── index.js                 # Host 入口：注册 service、tools、context provider
│   ├── client.js                # Client 入口：注册 slots、workspace page
│   │
│   ├── services/
│   │   ├── market-service/      # ★ 统一数据接口（本文件第 3 节）
│   │   │   ├── index.js         #   MarketService 类 + cordis service 注册
│   │   │   ├── symbols.js       #   代码规范化（SH/SZ/BJ、指数、ETF）
│   │   │   ├── cache.js         #   缓存策略与 TTL 路由
│   │   │   └── schema.js        #   统一 schema 校验（zod/手工）
│   │   ├── research-service/    #   Research Notebook CRUD + 复盘
│   │   ├── watch-service/       #   Watch 规则引擎（Phase 4）
│   │   └── quant-bridge/        #   调 Python sidecar 的桥（Phase 3）
│   │
│   ├── datasource/              # 只能被 market-service 引用
│   │   ├── eastmoney.js
│   │   ├── pytdx.js             # 通过 python sidecar 或 node 端口
│   │   ├── tushare.js
│   │   └── README.md            # 每个源的字段映射表
│   │
│   ├── tools/                   # AI Tools（只调 MarketService）
│   │   ├── stock-quote.js
│   │   ├── stock-kline.js
│   │   ├── market-overview.js
│   │   ├── sector-overview.js
│   │   ├── stock-relative-strength.js
│   │   ├── stock-news.js
│   │   ├── stock-financials.js
│   │   └── stock-research-snapshot.js   # ★ 核心聚合工具
│   │
│   ├── context/
│   │   └── stock-context.js     # UI 状态 → LLM context 注入
│   │
│   └── ui/
│       ├── workspace/           # 工作台页面（顶部指数栏/左栏/图表/右AI/底部tabs）
│       ├── components/          # K线、分时、指数条、自选股列表
│       └── store.js             # Client 状态（当前股票、timeframe…）
│
├── backend/                     # Python sidecar（Phase 2 起）
│   ├── pyproject.toml
│   ├── api/                     # FastAPI（仅本地回环，给 Host 调）
│   ├── collectors/              # 历史数据采集（Tushare → Parquet）
│   ├── research/                # 快照聚合、事件时间线
│   ├── quant/                   # event_study / regression / backtest
│   └── storage/                 # DuckDB/SQLite + Parquet IO
│
└── data/                        # 本地数据（运行时生成，gitignore）
    ├── quotes/ bars/ indices/ sectors/ financials/   # Parquet
    ├── news/ events/
    ├── research/                # Research Notes（markdown + index.db）
    ├── watchlist/ watch/
    └── quant/
```

**为什么 Host 里不直接跑 Python 逻辑**：pytdx/tushare/pandas 是 Python 生态；Node 侧保持轻量。MVP 阶段（Phase 1）可以**不要 Python**，实时行情全部走东方财富 HTTP，Python sidecar 从 Phase 2（历史落库）才引入——架构上已留出 quant-bridge 边界。

---

## 3. MarketService 接口（稳定契约）

```ts
interface MarketService {
  // 行情
  getQuote(symbol: Symbol): Promise<Quote>
  getQuotes(symbols: Symbol[]): Promise<Quote[]>
  getKline(symbol: Symbol, opts: {
    timeframe: '1m'|'5m'|'15m'|'30m'|'60m'|'1d'|'1w',
    start?: ISODate, end?: ISODate,
    adjust?: 'none'|'qfq'|'hfq',
    limit?: number
  }): Promise<Bar[]>

  // 市场结构
  getIndex(symbol: IndexSymbol): Promise<Quote>
  getMarketOverview(): Promise<MarketOverview>        // 指数+宽度+情绪
  getSector(sectorId: string): Promise<SectorQuote>
  getSectorMembers(sectorId: string): Promise<Symbol[]>
  getMarketBreadth(): Promise<MarketBreadth>           // 涨跌停/涨跌家数
  getLimitUpPool(): Promise<LimitUpItem[]>
  getTradingCalendar(): Promise<TradingDay[]>

  // 个股深度
  getMoneyFlow(symbol: Symbol): Promise<MoneyFlow>
  getFinancials(symbol: Symbol): Promise<Financials>
  getCompanyProfile(symbol: Symbol): Promise<CompanyProfile>
  getNews(symbol: Symbol, opts?: {limit?: number}): Promise<NewsItem[]>
  getAnnouncements(symbol: Symbol, range): Promise<Announcement[]>

  // 检索
  search(query: string): Promise<SymbolInfo[]>
}
```

### Symbol 规范化

内部统一格式 ` exchangesuffix 代码`：**`SH600519` / `SZ300750` / `BJ430047` / `IDX000300`**（指数前缀 IDX）。所有入口先过 `symbols.normalize()`，接受用户输入的 `600519`、`600519.SH`、`sh600519`、中文名（经 search 映射）。

### 统一 Schema 要点（不暴露数据源字段名）

```ts
Quote {
  symbol, name, market: 'SH'|'SZ'|'BJ',
  price, change, changePct,        // 统一小数，pct 用百分数值
  open, high, low, prevClose,
  volume,                          // 股（不是手）
  turnover,                        // 元
  amount,                          // 成交额（元）
  timestamp,                       // ISO8601 +08:00
  status: 'trading'|'suspended'|'halt',
  flags: { st?: boolean, new?: boolean },   // ST/新股
  source: 'eastmoney'|'pytdx'|...,          // 数据溯源（原则 5）
  fetchedAt                        // 采集时间戳
}

Bar { time, open, high, low, close, volume, amount, adjust, source }

MarketOverview {
  indices: Quote[],                // 上证/深证/创业板/沪深300
  breadth: { up, down, flat, limitUp, limitDown },
  totalAmount,                     // 两市成交额
  sentiment: { score?, label? },   // 简单合成，LLM 不算
  timestamp, source
}
```

缺失值统一 `null` + `status`/`flags` 标注停牌、ST、新股；价格精度统一保留源精度，展示层格式化。

### 缓存与 fallback 策略

| 数据 | 主源 | 备用 | 缓存 TTL |
|---|---|---|---|
| 实时行情 | 东方财富 push2 | pytdx | 3–5s（盘中） |
| 日 K | 东方财富 | Tushare | 当日收盘前 15min，收盘后持久 |
| 分钟 K | pytdx | 东方财富 | 60s |
| 财务/公告 | Tushare Pro | 东方财富 F10 | 24h |
| 指数/板块 | 东方财富 | pytdx | 10s |
| 新闻 | 东方财富 | — | 5min |

每个适配器实现同一 `Datasource` 接口；MarketService 按上表路由 + 故障切换 + 记录 `source`。

---

## 4. 本地数据层

- **Parquet**：日线、分钟线、指数、板块、因子、技术指标 → `data/bars/` 等，按 `symbol/year` 分区。
- **DuckDB（MVP 用 SQLite，接口层抽象保留迁移能力）**：股票基础信息、新闻、公告、事件、自选股、Watch 规则、回测元数据、AI 分析结果索引。
- **Research Notes**：markdown 文件（人可读）+ SQLite 索引（可查询），每条 note 记录：`dataVersion, asOfDate, universe, benchmark, params` —— 满足可复现（原则 4/7）。

---

## 5. AI Tools 设计（MVP 8 个，稳定优先）

> **实现现状（2026-10-27）**：当前共 **30 个工具**（`src/tools/` 六个模块注册：index 9 + research 4 +
> watch 5 + quant 3 + formula 6 + drawing 3；清单见 ROADMAP T6.2 与插件 README）。
> 下表是 MVP 的 8 个核心工具，**仍在用**；但本节的"追加"清单不等于已支持——见下表后的现状注记。

| Tool | 输入 | 输出要点 |
|---|---|---|
| `stock_quote` | symbol | Quote |
| `stock_kline` | symbol, timeframe, range, adjust | Bar[]（截断到 LLM 可用长度，附带统计摘要） |
| `market_overview` | — | MarketOverview |
| `sector_overview` | sectorId 或 stock symbol（自动找行业） | 板块行情 + 成员涨跌分布 |
| `stock_relative_strength` | symbol, benchmark, period | 超额收益/rolling beta/相关性/波动率/量 z-score |
| `stock_news` | symbol, limit | 新闻列表 |
| `stock_financials` | symbol | 关键财务指标卡片 |
| **`stock_research_snapshot`** | symbol | 标准化快照（见第 6 节） |

Phase 3+ 追加：`stock_money_flow / compare_stocks / market_breadth / screen_stocks / run_event_study / run_regression / run_backtest / save_research_note / create_watch_rule`。

> **其中仍未实现（2026-10-27 实测）**：`compare_stocks` / `market_breadth` / `screen_stocks`
> ——选股属 ROADMAP **T5.7 ⬜**（信号提取接口已就绪，全市场批量求值未做）；
> `run_regression` / `run_backtest` ——回归与回测属 🧊 **范围冻结**（保留可用、不再扩展的是 Event Study）。
> **已实现**：`stock_money_flow`、`run_event_study`、`save_research_note`、`create_watch_rule`，
> 以及后续加入的公式（6）、画线（3）、盯盘（5）、笔记（4）类工具，合计 30（见本节开头的实现现状）。

---

## 6. stock_research_snapshot 输出契约

```json
{
  "stock":        { "symbol", "name", "quote", "flags" },
  "market":       { "indices", "breadth", "sentiment" },
  "sector":       { "id", "name", "changePct", "memberStats" },
  "priceBehavior":{ "returns": {"1d","5d","20d","60d"}, "drawdown", "position52w" },
  "volumeBehavior":{ "volVsMa20", "turnoverRate", "zScore" },
  "volatility":   { "realized20d", "atr14" },
  "relativePerformance": { "vsIndex": {...}, "vsSector": {...}, "excess20d" },
  "moneyFlow":    { "mainNetInflow5d", "northbound?" },
  "financials":   { "pe", "pb", "roe", "revGrowth", "reportDate" },
  "events":       [ { "date", "type", "summary" } ],
  "news":         [ { "time", "title", "source" } ],
  "anomalies":    [ { "kind", "metric", "value", "baseline", "zScore", "note" } ],
  "meta":         { "asOf", "sources", "dataVersion" }
}
```

anomalies 由**代码**计算（z-score 超阈值、相对强度突变等），LLM 只负责解释——符合原则 3（LLM 不算关键数值）。

---

## 7. UI Context 设计（Context-aware AI）

Client store 维护当前状态，每次 Agent 调用前由 `stock-context` provider 注入：

```json
{
  "currentStock": "SH600519",
  "currentName": "贵州茅台",
  "timeframe": "1d",
  "chartRange": "6M",
  "benchmark": "IDX000300",
  "sector": "白酒",
  "selectedNewsId": null,
  "activeNoteId": null,
  "activeQuantResultId": null
}
```

实现：Host 侧注册 context provider（cordis agent context 扩展点），Client 通过共享 service 事件同步状态。用户问"最近怎么回事？"时 LLM 直接知道对象。

---

## 8. LLM 职责边界（写进 skill 与 tool 描述）

- LLM **不做**：实时计算、指标计算、清洗、数据库、回测核心、排名、大规模筛选。
- LLM **做**：理解、假设、解释、关联、区分事实/推断、设计验证、解释量化结果、写 Research Note。
- 回答结构：事实 → 异常 → 可能原因 → 证据 → 反证 → 未确认 → 建议验证。**相关性不得表述为因果**（原则 6）。
- 随插件发布 `stock-lab` skill：合规红线（不构成投资建议）、方法论、工具路由规则、盯盘与提醒的正确用法。

### 实测边界：统计与判定全部由代码算（LLM 只做解释）

对 `src/**` 与 `backend/**` 做 grep（`ctx.llm` / `get('llm')` / `llm.stream` / `agentDefaultModel`）：
**设计期（Phase 1）实测 0 处**；但自 **Phase 6 自建 Chat** 起，插件代码已经直接调用 LLM
（`src/index.js:136` `llm: ctx.get?.('llm')`、`:139`/`:359` `ctx.get?.('agentDefaultModel')`；
`src/services/chat-service/index.js:214` `stream: (options) => this.llm.stream(options)`——见 §12 与 D10）。
也就是说，下面这张表的边界仍然成立：**数值与判定归代码，语言归 LLM**。

| 层 | 由谁决定 | 是否可复现 |
|---|---|---|
| 取数与归一化（含多源 fallback、GBK 解码、字段校准） | **代码 100%** | ✅ |
| 全部数值统计（区间收益、年化波动、量能 z-score、超额收益、相关系数、t 统计量） | **代码 100%** | ✅ |
| 异常判定（**5 类**规则：量能 / 相对强度 / 价格动量 / 波动 / 行业背离，见 `src/tools/index.js:385/392/399/406/414`） | **代码 100%** | ✅ |
| 盯盘条件（9 种）与冷却逻辑 | **代码 100%** | ✅ |
| 事件研究与显著性判断 | **代码 100%** | ✅ |
| 存储、指纹、台账 CRUD 与复盘统计 | **代码 100%** | ✅ |
| 行业归类、资金流、财务、新闻取回 | **代码 100%** | ✅ |
| ——— 分界 ——— | | |
| 选哪个工具、把 JSON 讲成人话、提出可能解释、形成假设、设计下一步验证 | **LLM** | ❌ |

**设计含义**：LLM 是"说话的人"，不是"算数的人"。所以任何结论如果重要，其**事实骨架必须能追到代码产出的数值**（`provenance` / `metrics` / `anomalies` 都是为此存在的）。

**自建 Chat 的约束（已实施，规则仍适用）**：§12 的自建 Chat（Phase 6 已完成，见 D10）让插件代码直接调用 LLM。因此必须遵守：

1. 聊天得到的数字**只能来自工具返回**，不得由模型心算（system prompt 明确禁止）
2. 工具结果里已有的统计量，聊天回复不得改写
3. 自建 Chat 不设"自动保存结论"——落笔成笔记仍由用户确认（避免模型替用户下判断）

---

## 9. UI 布局（Phase 1 工作台页面）

```text
┌──────────────────────────────────────────────────────────────────┐
│ 上证 │ 深证 │ 创业板 │ 沪深300 │ 成交额 │ 涨/跌 │ 情绪           │
├──────────┬───────────────────────────────┬───────────────────────┤
│ 自选股    │                               │  Stock Lab Chat       │
│ 搜索      │   K线 / 指标叠加（含TDX公式）  │  ┌─────────────────┐  │
│ 行业/概念 │   成交量副图                   │  │ 对话记录（可滚动）│  │
│ 最近查看  │   逐根十字读数                 │  │                 │  │
│          │                               │  └─────────────────┘  │
│          │   行情卡                       │  ┌─────────────────┐  │
│          │                               │  │ 输入框           │  │
├──────────┴───────────────────────────────┴───┴─────────────────┴──┤
│ 新闻 │ 财务 │ 资金流 │ 所属行业 │ 指标公式 │ 智能盯盘 │ 研究笔记    │
└──────────────────────────────────────────────────────────────────┘
```

（底部另有「量化验证」tab：**保留可用但不再扩展**，见 §13 范围冻结与 D13；上图底部未列出它——
实际 tabs 见 `src/client.js:3544`）

### 9.1 主题词汇表（实测，2026-10-25）

用户要求"右栏尽可能与 DSH 原生对话界面一致"。实测后确认了三条关键事实：

| 事实 | 证据 |
|---|---|
| 官方 Theme 契约**只承诺 14 个** token（13 个 `--dsw-alias-*` + `--dsw-specific-sidebar-fill`） | `cordis_inspect_query` Theme.listTokens |
| 但主题包 `dsh-client-ui-theme/lib/client.js` 在运行期**实际定义了 414 个**变量 | 从 `app.asar` 提取 `client.js` 后统计 |
| **`--sys-*` 一类的 token 在插件页面里不存在**——它们只定义在 `dsh-experimental-inspector/lib/devtools/design_system_tokens.css`，主前端 CSS 对 `--sys-*` 的引用数为 **0** | 逐个 CSS 文件比对 |

**因此定下规则**（`src/client.js` 的 CSS 注释里也写了）：

1. **颜色**只用 token，**不写兜底**——硬编码色值被测试禁止，且必须跟随明暗主题
2. **非颜色**（字号/行高/圆角/焦点环）一律写 `var(--token, 兜底值)`：
   主题改名时**退化为兜底值**，而不是让整块样式静默失效（例如圆角变 0）
3. **绝不引用 `--sys-*`**：它们不在插件页面里

可以放心使用的原生词汇（都来自主题包，随用户字号设置变化）：

```
排版   --dsw-font-markdown-base / -strong / -code / -code-block / -h1..h4 / -table
       --dsw-font-xxxs-11 · -xxs-12 · -xs-13 · -s-14 · -base-16 · -m-18 · -l-20 · -xl-24
       （每个还有 -font-family / -font-size / -line-height / -font-weight 子变量）
表面   --dsw-specific-bubble（对话气泡）· --dsw-specific-input-major（输入框）
       --dsw-specific-sidebar-fill（侧栏/标题行）· --dsw-alias-markdown-code-block
圆角   --dsw-radius-xs / sm / md / lg / xl / panel
其它   --dsw-shadow-lv1..3 · --dsw-elevation-* · --dsw-focus-ring-color / -width
       --dsh-scrollbar-thumb / -width / -track-margin · --dsh-content-font-size / --dsh-code-font-size
```

> 复制 DSH 安装目录里的资源仅用于**读取样式词汇**；提取出的副本已删除，不留在工作区。

### 9.2 教训：token 名字不能判断用途，必须查实际值

**两次**"发送按钮不清晰"都是因为按 token 名字猜颜色：

| 尝试 | 结果 | 实际原因 |
|---|---|---|
| 只用 `button-primary-fill` + `label-primary-foreground` | 禁用态白箭头画在浅灰圆上 | 禁用背景换成了 `#ebeef2`，前景仍是 `#fff` |
| 改用 `label-dimmed` 做禁用前景 | **依然看不见** | `label-dimmed` = `#e1e5ee`，与 `#ebeef2` 几乎同色（对比度 **1.10**）——它其实是给浅色背景/遮罩用的 |
| 改用 `label-secondary`（`#61666b`） | ✅ 对比度 ≈4.97 | — |

**规则**：改任何颜色前，先把 token 链解到最终 hex、算 WCAG 对比度
（`var()` 可以层层嵌套，光看名字会得出完全错误的结论）。

**第三次改色（发送按钮要"原生的蓝"）又验证了同一条**：
`--dsw-alias-button-primary-fill` 名字带 primary，实际却是 `brand-primary` = **`#0f1115`（近黑）**；
DSH 真正的蓝是 `--dsw-alias-button-info-fill` = **`#4176e6`**（= `--dsw-alias-link` = `--dsw-static-deepseek-500`）。
**名字带 primary ≠ 颜色对**。

浅色主题关键值：`bubble #edf3fe` · `input #fff` · `bg-layer-1 #fff` ·
`sidebar-fill #f9fafb` · `button-info-fill #4176e6` · `button-info-hover #7aaaff` ·
`button-primary-fill #0f1115` · `button-primary-dimmed #ebeef2` ·
`label-secondary #61666b` · `label-tertiary #81858c` · `label-dimmed #e1e5ee`。

另一个教训：**"像原生"不等于"用原生那个区域的颜色"**。右栏曾用
`--dsw-specific-sidebar-fill`(#f9fafb) 模仿原生侧栏，结果那层浅灰让用户气泡(#edf3fe)
不够突出——已回到 `bg-layer-1`(#fff)。**该突出内容的区域要留白。**

### 9.3 K 线交互与历史深度（决策 D18）

**目标定位**：这个平台是**替代证券软件**的——证券软件的短板正是没有 AI。因此操作习惯按证券软件来。

**可视窗口模型**（取代根数预设）：一张缓冲区 + 一个窗口 `{count, end}`。

- 缩放/平移**只改窗口**，不重新取数、不重算指标 → 滚轮/按键是即时的
- **但这也意味着上限由"已取到的数据量"决定**，而不是由请求参数决定

**三条必须做对的**（都属于"看起来正常但其实是错的"）：

1. 指标在**缓冲区**上算、按窗口切片。只按窗口算会让左边缘的 MA 变空值
2. `end < 0` = "跟随最新"哨兵。否则新交易日进来后画面停在旧位置
3. `CHART_GEO` 共用一份几何常量。SVG 固定 viewBox 再缩放，指针坐标必须换算，
   两处各写一份就会在容器变宽时算偏

**历史深度：实测的上游限制**（这是"能否替代证券软件"的关键约束）

| 请求 | 腾讯实际返回 |
|---|---|
| 800 根 | 801 根（≈3.2 年）← 上限 |
| 1500 根 | **641 根**（请求更多反而更少） |
| 3000 根 | `param error` |

- **日线上限约 800 根**，是**上游限制**（我们的 800 与它一致，不是我们卡住的）
- ⚠️ **超限时静默返回更少数据而非报错**——这种静默降级要记住，别盲目调大 count

**更深历史的三条可行路径**（未实施，待定）：

1. **周线 / 月线**：同样 800 根，周线 ≈15 年——长期结构今天就能看
2. **本地库随时间累积**：本地库不受单次接口上限约束
3. **另接更深的数据源**（此前推迟的 pytdx / Tushare 属此类）

> 附带发现一个**静默少数据**的隐患：`MarketService` 的 `auto` 来源判断是
> `fromLocal.length >= Math.min(want, meta.rows)`——它判断的是"本地是否比它自称的行数少"，
> 而不是"本地是否比你要的少"。所以**你请求超过本地已有量时，它会安静地只给你本地的量**。
> 在窗口模型下这会表现为"缩放到某处就停住"。目前靠图表显式提示"已到数据起点"来兜住；
> 若要真正取更多，需要改这条判定或走 `source: live`。

### 9.4 图表画线（决策 D19）

**画线是"表达一个判断"的载体**，不只是看图方便：一条线可以挂 `reason`（为什么画在这里），
因此它天然是 Research Note 的补充。而且**AI 可以画**——这是"证券软件 + AI"最直接的结合点。

**锚点模型**（这一条决定了整个功能可不可用）：

```
anchors: [{ date: 'YYYY-MM-DD', price: number }]   // x 锚日期，y 锚价格
adjust:  'qfq' | 'hfq' | 'none'                    // 画线时的复权模式，必须记录
```

三个坑，**都属于"看起来正常但其实是错的"**：

| 坑 | 为什么错 | 对策 |
|---|---|---|
| 用 K 线序号存 x | 序号随根数变化、被新数据推移 → 线跑到别处 | 存日期；绘制时 `indexOfDate` 解析成当前窗口下标 |
| 不记复权模式 | 前复权基准随除权整体平移 → 线与蜡烛错位 | 记录 `adjust`；不一致时**画虚线 + 明确提示** |
| 直接用鼠标坐标 | SVG 固定 viewBox 再缩放 → 容器宽 ≠900 时算偏 | 共用 `CHART_GEO`（与缩放同一份） |

**"照画但标注"而不是隐藏**：复权不一致时不画会让人以为线丢了，画实线会让人以为它还对得上。
所以画成虚线并说明原因——这是唯一不误导的选择。

**存储**：`数据根目录/drawings/<标的>.json`。不放 localStorage，因为画线是研究产物，
要能备份、diff、被 AI 读写。**不合法就报错，不静默修正**；文件损坏如实报告。

**交互（第二步）**：

| 操作 | 做法 |
|---|---|
| 画 | 选工具 → 按下拖动 → 松开保存 |
| 选中 | 「选择」模式点线（点到线距离，容差 6px） |
| 删除 | Delete 键 / 「删除选中」按钮；Esc 取消选中 |
| 写说明 | 选中后出现输入框，写标签与"为什么画在这里" |

三条设计要点：

1. **吸附必须有**：手画的线永远对不准 K 线高低点。锚点先吸到最近的 K 线，
   再把价格吸到那根的**开/高/低/收**里最近的一个（`snapAnchor`；曾经漏掉 `open`，
   表现为"一根 K 线只能吸 3 个点"）。
2. **画线模式才接管指针**：没选工具时保持原有逐根十字读数，不拦截；
   选了工具才进入画线态（十字光标 + 禁止选中文本）。
3. **比例尺只有一处计算**（`computePriceScale`）：图表与交互层共用。
   两边各算一份的话，叠加公式线时范围不同 → 画线就会偏（与 `CHART_GEO` 同理）。

**"选中后能写 reason"不是可选装饰**：AI 画的线能带判断依据，人画的也必须能——
否则手画的线只是条线，而画线的价值在于**记下一个判断**。

**手感细节（都不难，但没有就难用）**：

| 细节 | 为什么 |
|---|---|
| **幽灵提示**（按下前） | 移动鼠标就显示"会吸附到哪、松手会得到什么线"。不用先点下去试 |
| **预览线**（按下后） | 虚线 + 端点圆点，随鼠标实时变化 |
| **Ctrl+Z 撤销** | 画线是**高频易错**操作；"选中→找到线→点删除"三步太绕，会让人不敢随手画 |
| 趋势线 **线段/射线/直线** | 延伸用 `ext` 字段表达；渲染时按参数区间 + 画布 slab 裁剪 |
| 换标的清空撤销栈 | 跨标的撤销会张冠李戴 |

**撤销的栈顶必须从当前渲染的 state 读**，不能写在 `setState` 的 updater 里：
updater 何时执行由 React 决定，写进去会导致"栈非空却提示没有可撤销"——静默失效。

**圆的锚点模型**：**圆心 + 圆上一点**（不是包围框）。用户更习惯"先点圆心、再拉半径"，
而且这样渲染出来是**真正的圆**，不会因横纵比例不同而变成随缩放变化的椭圆。
代价说清：半径由两个锚点在数据空间的位置决定，**缩放时圆的屏幕大小会变**——
这是数据空间锚定的必然结果，不是缺陷。

**颜色存"色名"而不是色值**：`{"color":"red"}`。色值一旦写死，**明暗主题切换后可能看不清**
（浅色主题下合适的深蓝，在深色主题上几乎不可见）。存色名由客户端映射到主题 token。
主题没有紫色 token，紫色用 `color-mix()` 由红+蓝两个 token 派生——跟随主题、无硬编码色值。
非法色名（含 `#ff0000` 这类色值）明确拒绝。

### 9.5 画线踩过的两个"静默失效"

两个都是**功能看起来做了、实际没生效**，而且根因都不在功能本身：

| 现象 | 根因 |
|---|---|
| 拖动时**预览线不跟随** | 图表画水平线读 `s.price`，草稿只带 `points` → `yP(undefined)`=NaN、线不可见。幽灵线能显示，只是因为那条路径恰好设了 `price` |
| **Ctrl+Z 不生效**（Delete 却能用） | `onPointerDown` 的 `e.preventDefault()` **阻止了浏览器把焦点交给容器**；键盘事件只在容器有焦点时到达。Delete 能用是因为它在**选择模式**下点的图（没有 `preventDefault`） |

教训：**"输入焦点"这种前提条件不写清楚，功能就等于没做**。
另一个相关教训：`preventDefault()` 的影响范围要连带考虑（这里连带干掉了焦点）。

### 9.7 一个根因、三个症状：「渲染字段透传」

`resolveDrawings` 负责把存储形状转成"可绘制几何"。它一度**只透传 label/reason，
丢掉了 `color` 与 `ext`** —— 于是：

| 症状 | 真实原因 |
|---|---|
| 改颜色不变色 | `color` 被丢，永远用默认色 |
| 趋势线**预览是射线、画出来是线段** | `ext` 被丢，回落成线段（预览走草稿，草稿自带 ext） |
| 选中后切换延伸方式"没反应" | 存对了，渲染时又丢 |

**教训**：存储层与渲染层之间有一道"字段过滤"，**新建字段时极易只加一半**
（存储加了、渲染没加）。所以：

1. 把会参与渲染的字段集中在一个 `carry(d)` 里透传，避免散落各处
2. 加一条**断言透传**的测试——新增字段时必须同时加，否则静默失效
3. 症状跨了三个功能，但根因只有一个：**排查"某个功能没生效"时，先确认数据有没有走完全程**

### 9.9 浮层必须"独占指针"（否则容器会抢）

浮动调色板画在图表 SVG **里面**，而图表容器的 `onPointerDown`/`onClick` 会接管指针：

| 抢占的后果 | 表现 |
|---|---|
| 容器的 pointerdown 开始画线 | 点色块 = **又画了一条线** |
| 容器的 onClick 做命中判定 | 点色块时**顺手取消选中** → 调色板消失 → 看起来"点了没反应" |

对策是两条一起上：**浮层自己 `stopPropagation()`**，并且**容器在浮层矩形内不接管**。

> **排查经验**：这次数据里 `color` 其实**已经存成 blue 了**——保存成功、只是界面反馈坏了。
> 所以"某个操作没反应"要先分清是**没生效**还是**没反馈**：
> 查数据/日志比盯着界面猜快得多。

### 9.10 两点型图形：拖动与两次点击并存

趋势线/圆支持两种画法（拖动完成，或"点一下、再点一下"）。判定用**屏幕位移阈值**，
而不是数据坐标差——后者会被缩放级别影响，"点在同一个位置"在放大时也会算成拖动。

顺带解决一个真实毛病：**小位移拖动会让圆半径≈0、画出一个看不见的点**。
现在小位移转入两次点击模式，第二下才定半径。

### 9.12 浮层的 z 序：交互层必须在命中层之上

浮动调色板"画了、也点了，但完全没反应"的真实原因**不是事件绑定**，而是 **z 序**：

图表在 `paletteMarks` **之后**又铺了一层 `bars.map(...)` 的**透明 hover 命中矩形**（覆盖整个价格区）。
先画调色板就被盖住 → 点击落在 hover 矩形上 → 调色板的 `onClick` / `stopPropagation` **根本没机会执行** →
而容器又因为 `insidePalette` 提前返回 → **三方都以为自己不该处理，结果谁都没处理**。

**教训**：SVG 里没有 z-index，**后画的在上层**。
一个"看起来有按钮、点了没反应"的浮层，先检查它是不是被后续绘制的透明命中层盖住了。

### 9.13 命中规则要覆盖"实际可见的形状"，而不是"存储的锚点"

| 曾经的缺陷 | 后果 |
|---|---|
| 趋势线按**两个锚点之间**判距离 | 改成射线/直线后，**延长出去的部分点不中** |
| `hitTestDrawings` **完全没有圆的分支** | 圆**根本选不中** |

现在趋势线先按 `ext` 裁剪到画布再判距离；圆判"到圆周的距离"，圆心附近也算命中，
但**圆内部空白不抢点击**（否则一个大圈会把里面所有东西的点击都吃掉）。

**框选则用包围盒相交**，与逐点命中互补：圆半径在屏幕上可能只有 ~18px，
逐点命中很难，框选一定选得中。

### 9.14 三种指针模式必须互不冲突

同一块画布上，拖动的含义随模式而变，所以把「选择」提升为**真正的工具值**（`'select'`），
而不是"没有工具"：

| 模式 | 拖动 |
|---|---|
| 选了画线工具 | 画线 |
| `select` | 框选多条（批量删除） |
| 没有任何工具 | 框选放大（只按横向范围；价格轴自动定，纵向不参与） |

把"没选工具"与"选择模式"混为一谈时，框选放大与框选多选会抢同一个手势——所以必须分开。

### 9.16 守门测试的价值：它连续抓到了三个"运行期才炸"的缺陷

`ChartStage` 的 prop 解构漏项，是同一类缺陷的**第三次**发生：

| 次数 | 漏掉的 prop | 症状 |
|---|---|---|
| 1 | `windowStart` | 一按鼠标就抛 `ReferenceError`，线画不上 |
| 2 | `onUndo` 相关（同批） | 快捷键没反应 |
| 3 | `onExitTool` | **按 Esc 直接抛错** |

共同点：**纯函数测试抓不到**（只有 React 事件路径才会执行到那些分支）。
所以有了那条通用守门测试：**调用点传入的每个 prop，组件必须解构**。
它在第 3 次发生时立刻报了 `传入了 onExitTool 但没有解构`。

**教训**：这类"接线错误"不会体现在算法测试里，只能靠**结构断言**兜住。
写组件时加 prop 就顺手加断言，比事后靠手点可靠得多。

### 9.18 同一类错误要在整个功能里"扫一遍"，而不是只修一处

**"锚点存下标"这个错误，我在同一个功能里犯了两次**：

| 位置 | 错法 | 后果 |
|---|---|---|
| 画线（D19） | 差点用 K 线序号存 x | 已在设计阶段改掉 |
| **测幅** | 真的存了**窗口下标** | 缩放/平移后位置**漂到别的 K 线上** |
| 钉住的 K 线 | 用的是**绝对**下标 | ✅ 正确（绝对下标不会随窗口变） |

画线的文档里明明写着"x 锚日期、绝不锚下标"，测幅却违反了——因为**写下来不等于检查过**。

**对策**：一个设计约束确立后，要把它当成**检查项**在所有相关实现里过一遍。
"锚点用什么定位"这个问题，每个涉及坐标存储的功能都要回答一次。

顺带一条：**"临时结果"要有明确的消亡条件**。测幅一开始只在 Esc 时清除，
于是切到别的工具后它还留在图上（用户以为坏了）。现在改成"工具失活即清除"——
**临时状态要绑定到产生它的上下文**，不要依赖用户记得清理。

### 9.19 附带修掉的一个 `data-root` 缺陷

写画线测试时发现：只设置 `DSH_STOCK_LAB_HOME` 时，如果那个目录里**还没有 meta.db / bars**，
`resolveDataRoot()` 会**静默回退到包内 data** —— 于是测试把画线写进了插件的真实数据目录。

对一个**专门用来防"写 A 读 B"**的模块来说，这条回退本身就是同一类缺陷。
已改为：`DSH_STOCK_LAB_DATA` 与 `DSH_STOCK_LAB_HOME` 都是**显式指定、直接采用**，
只有隐式候选才走"有没有数据"的判断。并加了回归测试。

> 教训：测试只设 HOME 是不够的——**隔离不彻底时，测试会污染真实数据**，而且不报错。

### 右栏宽度：用户可调（决策 D14）

固定宽度行不通：显示器宽度千差万别，DSH 窗口也未必最大化——固定 380px 在窄窗口里会把中间图表挤得没法看，在 2560px 宽屏上又浪费空间。

因此右栏宽度**由用户拖拽决定**，并遵守以下约束：

| 项 | 规则 | 理由 |
|---|---|---|
| 默认宽度 | 380px | 能放下对话气泡而不至于过窄 |
| 下限 | 260px | 再窄就没法读对话 |
| 上限 | `min(900px, 容器宽度 × 55%)` | **保证中间图表区始终占 ≥45%**；超宽屏也不无限放宽 |
| 下限兜底 | 上限不会低于下限 | 否则极窄容器里 `min > max` 会导致宽度抖动 |
| 容器未知 | 用 900px 硬上限 | 首帧 `getBoundingClientRect` 可能为 0 |
| 键盘 | ←/→ 调 ±24px（Shift ×4）；Home/End 到最小/最大；回车复位 | 不用鼠标也能调 |
| 鼠标 | 拖拽分隔条；**双击复位** | 拖坏了容易恢复 |
| 持久化 | `localStorage['stock-lab:rightPane']` 存 `{width, collapsed}` | 跨会话记住；拖动过程中不写盘（每帧写会卡） |
| 窄窗口 | 容器 < 880px 时可**收起为竖条**（`sl-rail`），一键展开 | 手机/小窗下三栏挤不下 |
| 可见性 | 头部实时显示当前像素宽度 | 让用户知道拖到多少了 |

夹取逻辑抽成**纯函数** `clampPaneWidth(requested, containerWidth, cfg)`，因此可以离线测试边界（非法输入、未知容器、极窄容器、超宽屏），不必依赖浏览器。测试见 `tests/client.test.mjs` 的「右栏宽度可调」一节。

实现细节：分隔条用 `role="separator"` + `aria-valuenow/min/max`，拖动用 Pointer Events + `setPointerCapture`（拖出元素外不丢事件），拖动中给根节点加 `sl-dragging` 禁用文本选中。

### 关于右栏 Chat：原方案已不可行，改为自建

原设计（本节旧版与决策 D5）写的是"**AI Chat 复用/嵌入 DSH 会话，不自造对话框**"。实践后发现这条走不通：

| 事实 | 来源 |
|---|---|
| `main` 是 keyed slot，**只有保留键 `conversation` 会绑定 Session**；其它键（如我们的 `stock-lab`）"receive no Session binding" | `Slots.listSubTree` 的 `main` catalog |
| 因此我们的页面**拿不到 Session**，也就无法承载官方 Conversation 组件 | 同上 |
| 客户端插件之间不共享 JS 模块（bundle 只能 `require('react')`），无法 import 官方 Chat 组件 | `dsh-astock` 客户端 bundle 结构 |
| 若强行占用 `conversation` 键，会**替换掉官方会话**（`replaceRisk: shadows-shipped-ui`），等于要重写一遍 Conversation | 同上 catalog |

**但插件可以自己调 LLM。** `ctx.llm`（可选依赖）提供：

- `stream(options)` → `AsyncIterable<StreamChunk>`，chunk 类型含 `text-delta` / `reasoning-delta` / **`tool-call-delta`**（带 `name` 与 `argumentsDelta`）
- `GenerateOptions` 支持 `messages`、`system`、**`tools: ToolSchema[]`**、`temperature`、`maxTokens`、`signal`
- `ctx.get('agentDefaultModel').currentSelection()` 给出 provider/model → **不需要插件自配 API Key**

所以自建对话框是可行的，并且有一个原方案没有的好处：**我们已有的 30 个工具就在本进程内，聊天可以直接调用它们的 `execute`，不需要经过 agent 层**。详见 §12。

---

## 12. Stock Lab Chat（自建对话 + 以标的为单位的线程）

### 为什么自建反而是更好的选择

| 维度 | 复用 DSH 会话 | 自建（本节方案） |
|---|---|---|
| 出现在工作台页面内 | ❌ 架构不支持 | ✅ 右栏整列 |
| 以标的为单位组织 | ❌ 会话是线性的 | ✅ 每个标的独立线程 |
| 工具调用 | agent 层自动 | 自己实现循环（但工具就在手边） |
| 对话可见于 DSH 会话列表 | ✅ | ❌（数据归插件，见下） |
| 需要重造的轮子 | 无 | 流式渲染、工具循环、重试、上下文裁剪 |

### 设计

```
每个标的（股票/ETF/指数）一条线程
    threads/<symbol>/  ← SQLite 索引 + 消息持久化
    每条线程维护：
      - messages[]            原始消息（可滚动回看）
      - summary               该标的的研究摘要（滚动更新）
      - noteIds[]             关联的研究笔记（结论落在这里）
      - lastActiveAt
另有一条「全局」线程：跨标的的问题（如"哪个行业最强"）不归属任何标的
```

请求装配（发给 LLM 的内容）：

```
system     = skill.md 的合规与方法论 + 当前标的事实底座（snapshot 摘要）
messages   = [线程摘要] + [最近 N 轮原始消息] + [本次提问]
tools      = 本插件自有的 30 个工具 schema（`src/tools/` 六个模块注册，见 ROADMAP T6.2）
```

**多轮工具循环**：收到 `tool-call-delta` → 拼参数 → 调本进程的工具 `execute` → 把结果作为 tool message 回灌 → 继续流式，最多 K 轮（防止无限循环），每轮都可取消。

### 关键取舍：对话保存过程，笔记保存结论

**不能承诺"完整记忆"**——原始对话会无限增长，塞进上下文既贵又不准。所以：

- **过程**：线程里保存原始消息，用于**人回看**（不上全部喂给模型）
- **结论**：结构化判断交给 Research Note（已有：观察/假设/证据/反证/预测/复盘日）
- **桥梁**：线程的 `summary` 与 `noteIds` —— 摘要由代码裁剪（最近 N 轮 + 旧轮摘要），笔记由用户/AI 显式保存

这样"回溯之前的判断是否准确"落到**已有且更可靠的机制**上：笔记 + 复盘，而不是靠模型回忆聊天记录。

### 与 DSH 真实工作区/会话的关系（**实测结论**）

用户的要求是：**右栏只显示当前标的的会话；同一份会话在工作区里也能看到。**

为了确定这条路是否可行，写了临时探针（`src/probe-workspace.js`，用文件哨兵启用）实测，
结论如下 —— **全部为实测，不是文档推断**：

| 要验证的 | 结果 | 证据 |
|---|---|---|
| 插件能否创建**持久工作区** | ✅ 能 | `workspaceRegistry.create(path, title)` 成功，且**活过插件重装**（`list()` 里仍在） |
| 插件能否创建**持久会话** | ✅ 能 | `agentLoop.create(id, {}, { cwd })` 成功；磁盘出现 `~\sessions\<cwd编码目录>\<sessionId>` 与 `~\storages\session_projcache\sessions\<sessionId>.json`（5927 字节），**目录名解码正是工作区路径** |
| 会话能否**活过插件重装** | ✅ 能（需 resume） | 重装后 `sessions.get(id)` == undefined（活存储随 fiber 释放），但 **`agentLoop.resume(ctx, {resumeSessionId})` 成功**，随后 `sessions.get(id)` 返回活会话，`seq=4` |
| 插件能否**往会话里写消息、并被持久化** | ✅ 能 | resume → `live.append('user/message', {...}, { surfaceOp: 'append' })` 成功（`seq=5`）；projection 文件从 5926 → 6054 字节，且**内容里能搜到写入的文本** |
| 创建的会话是否**立即出现在工作区列表** | ❌ **不会** | 即使写入并 dispose 后，该工作区的 `sessionIds` 仍是 `[]`。文档说明该列表来自 **"startup/live canonical-cwd header index"**，即**启动时构建**——运行期新建的会话要等 **DSH 重启**才会归位。**这一点我未能验证成功，不能承诺** |

**由此确定的架构（决策 D16：两层）**

```
DSH 真实会话（cwd = 工作区目录）   ← 持久、工作区里（重启后）可见
        ↕
右栏（只显示当前标的）             ← 只是这份会话的一个视图
插件的 llm 工具循环                ← 负责"生成"（带 30 工具白名单 + 研究硬约束）
```

- **一层：右栏即时问答**（已实现）——插件自己的线程 + 自己的 llm 循环，轻、快、按标的自动切
- **二层：真实会话**（待实现）——需要"会话在工作区里长期可见 + 可用完整 agent"时，
  用 `agentLoop.create`/`resume` + `append` 把这份对话落成真会话

**三条必须写明的限制**（否则会做出错误承诺）：

1. **运行期创建的会话不会立刻出现在工作区列表**，要等 DSH 重启（实测）
2. `sessions.create` 单独用**没有意义**——文档明确"在 agent 生命周期之外发布的会话什么都不会持久化"，必须走 `agentLoop`
3. 插件创建的 agent **由插件 fiber 拥有**，重装会释放它；要继续写必须**先 resume**

### 懒创建（决策 D15）

> 用户的原话："只有真的在右栏输入内容开始交流了，才会创建一个新的对话，而不是反过来，先每个标的都创建好对话等着用户输入"

这条规则适用于**两层**（线程与真实会话），且是**必须遵守**的：

- **读路径绝不创建**。`listMessages` / `buildSystem` 都要用 `findThread`（不创建）
- 创建只发生在 `start()`（用户真的发了第一句）
- 启动时 `pruneEmptyThreads()` 收敛历史遗留

**这是一条被真实 bug 验证过的规则**：早期实现里 `listMessages` 用了 `ensureThread`，
而前端每次切换标的都会调它 —— 于是**每浏览过一只股票就会留下一个空线程**，
全市场浏览一遍就是几千条垃圾记录（而用户的判断是对的：一个人真正会提问的标的并不多）。

---

## 13. 通达信公式引擎（TDX 兼容）

### 目标

在对话里**粘贴公式文本**或**指定公式文件**导入，解析后把输出线画到主页面 K 线上，并保存为该标的的「指标方案」。

### 语法范围（MVP）

| 支持 | 说明 |
|---|---|
| 语句 | `A:=EXPR;`（中间变量）、`A:EXPR;`（输出线）、`A:EXPR,COLORRED;`（带绘图属性，属性先解析并保留） |
| 序列变量 | `O H L C V VOL AMOUNT`（**7 个名字 / 6 个序列**；`V` 与 `VOL` 同指成交量）、常量、算术/比较/逻辑运算 |
| 常用函数 | **设计期清单**：`MA EMA SMA REF HHV LLV SUM STD CROSS COUNT EVERY EXIST IF MAX MIN ABS BARSCOUNT BARSLAST`
（⚠️ 此处曾把**未来函数 `REFDATE`** 混进"支持"清单，已删除——见下"实现现状"） |
| 周期 | 日/周/月（由 K 线 timeframe 决定，公式本身不含周期） |

| 不支持（明确报错，不静默近似） | 原因 |
|---|---|
| 加密公式文件（`.tne` 等二进制） | 加密格式无法解析——**必须如实告知，不能猜** |
| 引用其它公式（`"MACD.MA1"`） | 需要跨公式解析；先提示用户展开 |
| `ZIG PEAK PEAKBARS TROUGH TROUGHBARS BACKSET REFDATE`（**未来函数，7 个**） | 会重画历史、使回测与信号失效 → 识别并在结果里标注，且 **`run()` 默认拒绝计算**，只有显式 `allowFutureFunctions=true` 才出图（**本节旧文写"不阻止"，与实现不符，2026-10-27 已更正**） |
| `FINANCE FINANCE_EX DYNAINFO CAPITAL SELFDATA HYBLOCK INBLOCK`（**依赖数据，7 个**） | ⚠️ **它们不是未来函数**（不会重画历史）。真正限制是引擎只提供 K 线序列、拿不到财务与实时盘口 → 报"缺数据"，**不能把原因说成"会重画历史"** |
| `COST WINNER LWINNER PPART PWINNER`（**明确未实现，5 个**） | 只靠 K 线理论上可算，属实现缺口 → 报"尚未实现" |
| `DRAWTEXT DRAWICON DRAWLINE POLYLINE` 等（**绘图指令，18 个**） | MVP 忽略并在结果里列出"已忽略的指令"（输出线数值照算） |

> **实现现状（2026-10-27 按代码核实，覆盖上表的"设计期/MVP"口径）**：
> **29 个可计算函数**（`supportedFunctionNames().length === 29`）+ **7 个序列变量名**（`O/H/L/C/V/VOL/AMOUNT`；其中 `V` 与 `VOL` 同指成交量，共 **6 个序列**）。
> 注册表 `FUNCTIONS`（Map）共 58 个键 = **29 个函数 × 2**（大写名 + 小写别名，函数名大小写不敏感）——**不是"58 个函数"**；
> 上表四类"不能用"的名字（未来函数 7 / 依赖数据 7 / 未实现 5 / 绘图指令 18）**不在**这张表里，各在独立集合。
> 四类的处置分支在 `tdx-evaluate.js:146-182`，**分开报原因**——把"缺数据"说成"未来函数"会让用户找错方向（真实修过的分类错误）。
> 逐项进度见 `ROADMAP.md` 的 T5.2 / T5.3，边界表述见插件 README「明确不支持」一节。

### 为什么用 Node 而不是 Python 实现

- 展示路径不需要起子进程（本地库直读已经证明了这一点）
- 解析与求值是**纯函数**，最容易做可复现测试（符合原则 4）
- 与「量化暂停」不冲突：这是**展示与计算**，不是统计研究

### 未来函数检测（这个必须做）

通达信公式里 `ZIG/PEAK/TROUGH/BACKSET` 之类会在后续数据到来时**改变历史信号**。如果直接拿去当信号，会得到虚假的高胜率。所以解析阶段就扫描函数表，命中即：

1. 结果里标 `futureFunction: true` + 具体函数名
2. UI 上打醒目标记
3. 若将来要接事件研究，直接拒绝该公式（因为验证结果无意义）

### 诚实的边界

这是一个**兼容子集**，不是完整通达信。遇到不支持的语法要**明确指出是哪一行哪个函数**，而不是算出一个看起来像但实际错误的结果。

---

## 14. 数据源落地计划

| 阶段 | 实时 | 历史/研究 | 本地 |
|---|---|---|---|
| Phase 1 MVP | 东方财富 HTTP | — | 内存缓存 + watchlist JSON |
| Phase 2 | + pytdx fallback | 东方财富公告/新闻；Tushare（有 token 时） | SQLite + 首批 Parquet |
| Phase 3 | 同上 | Tushare 历史落库 | DuckDB 评估迁移 |
| Phase 4+ | 多源校验 | 事件库 | 完整 data/ 目录 |

---

## 15. 设计决策记录

### D15 懒创建（2026-10-25，用户提出）

> "只有真的在右栏输入内容开始交流了，才会创建一个新的对话，而不是反过来，先每个标的都创建好对话等着用户输入"

**规则**：读路径（`listMessages` / `buildSystem` / 任何"查看"操作）**绝不创建**线程或会话；
创建只发生在用户真的发出第一句时（`start()`）。适用于线程层与真实会话层。

**为什么必须写成规则**：早期 `listMessages` 用了 `ensureThread`，而前端每次切换标的都会调它，
于是**每浏览过一只股票就留下一个空线程**。用户的原话也点出了规模问题：不会每只标的都提问，
真正关注的就那么多——所以预建是纯粹的浪费。启动时 `pruneEmptyThreads()` 收敛遗留。

### D16 两层对话（2026-10-25，用户澄清 + 实测）

> "右栏只显示当前标的对应的会话。工作区也可以查看它"

**不是二选一，而是"一份对话、两个视图"**：

- **一层（右栏即时问答）**：插件自己的线程 + 自己的 llm 循环。轻、快、按标的自动切。
- **二层（真实会话）**：`agentLoop.create/resume` + `append`，使对话在工作区里长期可见，
  必要时可用完整 agent。

**实测限制**（见 §12）：运行期新建的会话**不会立即出现在工作区列表**（索引启动时构建），
要等 DSH 重启。UI 必须如实说明，不能承诺"立刻可见"。

**会话 id 必须确定性**：`sessionIdForSymbol('SH600519')` → `session-stocklab-sh600519`。
两周后 DSH 重启、插件重装、内存全空，仍可用同一 id 去 `agentLoop.resume` 找回，
**不需要额外的映射表**。反推函数 `symbolFromSessionId` 支持回溯归属。
（若随机生成或以内存为索引，用户的"两周后接着聊"就会静默失效——这是必须在设计期定死的。）

---

### 历史决策（Phase 0–4 实施中确认）

| # | 决策 | 状态 |
|---|---|---|
| D1 | 不 fork DSH Core，全部 plugin/bundle 实现 | ✅ 已定 |
| D2 | 以 `dsh-astock` 为**设计参考**，最终自建 `dsh-stock-lab` | ✅ 已定（源码评审后：其交易/回测逻辑不作为主线，仅借鉴 K 线组件与数据源经验） |
| D3 | Python 从 Phase 2 引入（存储 + 计算），行情与 UI 纯 Node | ✅ 已定 |
| D4 | 存储 Parquet 优先、无 pyarrow 时回退 csv.gz，接口层抽象保留迁移能力 | ✅ 已定（实测：环境无 pyarrow，当前走 csv.gz） |
| D6 | `stock_research_snapshot` 的 anomalies 由代码计算 | ✅ 已定（**实现为 5 类**规则，见 §8 与 `src/tools/index.js`；设计期曾按 6 类描述） |
| D7 | 所有数值统计由代码计算，**统计与判定路径不调用 LLM** | ✅ 已定（Phase 1 实测 grep = 0 处；**Phase 6 起 `chat-service` 经 `ctx.llm.stream` 调 LLM 只用于"说话"**，数值仍全部来自工具，见 §8 / D10） |
| D8 | 本地库读写两方共用 `src/data-root.js` 的唯一根目录定义 | ✅ 已定（曾因两方不一致出现「写 A 读 B」） |
| D9 | 插件无法向会话推送 → 主动提醒 = 插件产出待看清单 + DSH 调度器叫起 | ✅ 已定（架构边界，已写入 skill.md） |

**修订**

| # | 原决策 | 修订为 | 理由 |
|---|---|---|---|
| **D5** | ~~AI Chat 复用/嵌入 DSH 会话，不自造对话框~~ | **自建右栏 Chat**（`ctx.llm` + 本插件工具直调），官方会话保持可用且互补 | 原方案技术上不可行：`main` 只有 `conversation` 键绑定 Session，我们的页面拿不到 Session，也无法 import 官方 Chat 组件；强占 `conversation` 键等于重写官方会话。详见 §9/§12 |

**新增（自 2026-10-25 起实施；状态于 2026-10-27 按代码逐条核实）**

| # | 决策 | 状态 |
|---|---|---|
| D10 | 右栏 Chat 采自建方案：`ctx.llm.stream` + 多轮工具循环，最多 K 轮，工具直接调用本进程 `execute` | ✅ 已实施（`src/services/chat-service/llm-loop.js` + `index.js`；工具白名单只含本插件自有工具，见 §12） |
| D11 | 对话以**标的为单位**分线程；线程存原始消息（供人回看），结论存 Research Note；上下文 = 线程摘要 + 最近 N 轮 | ✅ 已实施（**分线程与原始消息**：`chat-store.js` 的 `findThread` / `summary` / `summarizedUpTo` 字段；**"摘要 + 最近 N 轮"的上下文装配仍未实施**——即 ROADMAP 的 T7.2 ⬜，字段只是预留） |
| D12 | 通达信公式按**兼容子集**实现（Node 纯函数），不支持项明确报错；**未来函数检测并警告** | ✅ 已实施（`src/services/formula-service/`；能力边界见 §13） |
| D13 | **量化研究暂停**：Event Study 与 Quant UI 保留可用但不再扩展；不做回归/回测/walk-forward | ✅ 已实施（量化：**保留可用、不再扩展**；`run_event_study` 与「量化验证」tab 仍在） |
| **D14** | **右栏宽度由用户拖拽决定**（不固定）：显示器与 DSH 窗口尺寸差异太大，固定宽度在窄窗口挤掉图表、在超宽屏浪费空间 | ✅ 已实施 |
| **D18** | **K 线交互与历史深度**：缓冲区 `BARS_BUFFER=800` + 可视窗口 `{count, end}`（`end < 0` = "跟随最新"哨兵）；指标在缓冲区上算、按窗口切片；`CHART_GEO` 共用几何；滚轮以指针所在那根为锚；↑↓ 缩放 / ←→ 平移 / PageUp·PageDown 半屏 / Home·End；点某根 K 线钉住读数；未选工具时拖动 = 按横向范围框选放大；到数据起点明确提示 | ✅ 已实施（设计、三条"必须做对的"与上游历史深度实测见 **§9.3**；实现 `src/client.js`） |
| **D19** | **图表画线**：`hline / trend / circle / marker` 四种工具；锚点 x 锚日期、y 锚价格并记录画线时的 `adjust`（不一致时虚线 + 提示）；吸附到最近一根 K 线的 开/高/低/收；颜色存色名（拒绝色值）；幽灵提示 + 预览线；Ctrl+Z 撤销；框选多选与 Delete 批量删除；选中后可写 label 与 reason；测幅不落库；存 `数据根目录/drawings/<标的>.json`；AI 可画（`save_drawing` / `list_drawings` / `delete_drawing`） | ✅ 已实施（设计与踩坑记录见 **§9.4 – §9.19**；实现 `src/services/drawing-service/drawing-store.js`、`src/tools/drawing-tools.js`、`src/client.js`） |

**范围冻结（依据用户"加进去的东西有点多"的反馈）**

| 处理 | 项目 |
|---|---|
| 🧊 **冻结**（保留可用，不再开发） | 量化验证（Event Study / Quant UI）、Phase 5（状态模型 / Regime / ML / 组合） |
| ⏸ **推迟** | 事件时间线（公告/财报/除权）、snapshot 接入 pytdx/Tushare |
| ✅ **保留** | 行情与工作台、AI Tools、Research Notebook、行业维度、本地历史库、智能盯盘 |
| 🆕 **新增** | 通达信公式（展示侧）、右栏 Chat、按标的的对话线程 |

### 原则：宁少勿多

本项目的价值在**闭环可靠**，不在功能数量。因此新增功能前先问：

1. 它是否让"看到现象 → 形成假设 → 验证 → 记录 → 复盘"这条主线更可靠？
2. 它是否引入新的不确定性（比如依赖模型判断、依赖不可复现的数据）？
3. 删掉它，用户会真的缺什么吗？

TDX 公式与右栏 Chat 通过第 1 条（前者让"现象"可自定义，后者让"追问"顺手）；量化扩展不通过（主线已够用，且会稀释精力）。
