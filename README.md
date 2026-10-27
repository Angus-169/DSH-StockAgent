# DSH Stock Lab

> 集成在 DeepSeek Harness 内部的中国 A 股智能研究平台
> AI 原生 · 研究 / 盯盘 / 量化三者兼顾 · 当前阶段不做自动下单

**⚠️ 免责声明**：本项目仅用于技术学习与量化研究，**不构成任何投资建议**。所有数据来自第三方公开接口，可能存在错误、延迟或缺失。历史统计不预示未来表现。任何据此做出的投资决策由使用者自行判断并承担全部后果。

---

## 目录

- [这是什么](#这是什么)
- [这**不是**什么](#这不是什么)
- [核心差异：从"发生了什么"到"为什么"](#核心差异从发生了什么到为什么)
- [快速上手](#快速上手)
- [界面结构](#界面结构)
- [能力清单](#能力清单)
- [架构与铁律](#架构与铁律)
- [目录结构](#目录结构)
- [数据源](#数据源)
- [测试与验证](#测试与验证)
- [当前完成度](#当前完成度)
- [设计文档索引](#设计文档索引)
- [已知的坑](#已知的坑)

---

## 这是什么

一个装在 DSH（DeepSeek Harness）里的**AI 原生 A 股研究工作台**，由四部分构成：

| 模块 | 作用 |
|---|---|
| **行情终端** | 工作台页面：指数栏、自选股、K 线、行业、财务、资金流、新闻 |
| **AI 研究助手** | 21 个结构化工具 + 上下文感知，让 LLM 能拿到真实数据回答问题 |
| **研究台账** | Research Notebook：把判断固化成可复查、可推翻的记录，到期提醒复盘 |
| **量化验证** | Event Study 等：把"感觉"变成有样本量、有效显著性判据的结论 |
| **智能盯盘** | 9 种事件条件 + 与研究台账联动（假设到期自动提醒复盘） |

全部以 DSH 插件（bundle）形式实现，**不修改 DSH Core**。

## 这**不是**什么

- ❌ 不是自动交易机器人，**不做下单与实盘执行**
- ❌ 不是同花顺 / 东方财富 / 通达信的复制品
- ❌ 不是"技术指标大全"——不优先堆砌指标
- ❌ 不是荐股工具——合规红线写死在插件自带的 skill 里

## 核心差异：从"发生了什么"到"为什么"

传统行情软件回答 **"市场发生了什么"**。Stock Lab 还要往下走：

```
看到行情 → 发现异常 ─┬→ 问 AI ──→ 比较市场 / 行业 / 个股
                     │              ↓
                     │          找新闻和事件
                     │              ↓
                     │          提出可能解释
                     │              ↓
                     │          区分事实与假设  ← 强制标注
                     │              ↓
                     └→ 形成 Research Note ──→ 用 Quant Engine 验证
                                                   ↓
                                            建立 Watch 条件
                                                   ↓
                                            未来自动提醒复盘
```

这个闭环**十二步都有实现，且都用真实数据跑通过**。

### 它和普通"AI 聊股票"的区别

1. **数字不由 LLM 计算**：收益、波动率、z-score、超额收益、t 统计量全部由代码算好，LLM 只负责解释
2. **异常由代码判定**：`anomalies` 是规则命中结果，不是模型猜测
3. **强制区分事实与假设**：工具契约要求 `observation`（客观事实）与 `hypothesis`（假设）分开填
4. **强制列反证**：保存研究笔记时 `counterEvidence` 是必填项，工具描述写明"不能空着糊弄"
5. **诚实报告不显著**：Quant UI 把**样本量与 t 值放在最显眼位置**，而不是只展示好看的收益数字
6. **不假装可复现**：本地库没有该标的数据时，笔记里如实写"实时接口数据，未落库，无法精确复现"

## 快速上手

### 前置条件

- DSH（DeepSeek Harness），Node.js ≥ 22
- 可选：Python 3.10+（量化引擎需要；DSH 自带运行时可自动发现）

### 安装

```bash
dsh plugin --profile <你的profile> add -w "<仓库>/dsh-stock-lab"
```

`-w` 必需（profile 的 `pnpm-workspace.yaml` 把插件目录标记为 workspace root）。首次安装后需重启 `dsh web`。

### 使用

1. 打开 DSH Web UI，**左侧栏底部点「股票研究」图标**
2. 顶部看大盘，左侧搜索股票加入自选
3. 中央看 K 线，底部切各个 tab
4. **直接和 AI 对话**——当前看的股票会自动带上上下文，可以直接问「最近怎么回事？」

```
你：宁德时代最近怎么了？
AI：（自动知道你在看 300750，调用 stock_research_snapshot 拿到事实）
    事实：近 120 日 -46.43%，沪深300 -13.92%，超额 -32.51pp
    异常：5 条（量能 2.48σ、负超额、短期动量偏离、波动率放大 91%、与行业背离）
    事件：10/20 发布三季报（营收 +56.19%、净利 +31.60%），次日盘中跌超 10%
    可能解释：……
    尚不能确认：……
```

### 量化验证需要先落库数据

```bash
# 在对话里让 AI 采集，或直接命令行
python backend/collectors/collector.py fetch-many SH600519 SZ300750 IDX000300 --count 500
```

## 界面结构

```
┌────────────────────────────────────────────────────────────┐
│ 上证 深证 创业板 沪深300 │ 成交额 │ 涨/跌 │ 情绪分        │  ← 10s 刷新
├──────────┬──────────────────────────────┬──────────────────┤
│ 搜索      │  名称 价格 涨跌 ST/停牌标记    │  （右侧留给对话） │
│ 自选股    │  日/周/月 · 复权 · 根数        │                  │
│ （可增删）│  手写 SVG 蜡烛 + MA20 + 成交量  │                  │
│          │  开盘 最高 最低 昨收 换手 PE   │                  │
├──────────┴──────────────────────────────┴──────────────────┤
│ 新闻 │ 财务 │ 资金流 │ 所属行业 │ 量化验证 │ 智能盯盘 │ 研究笔记 │
└────────────────────────────────────────────────────────────┘
```

各个底部 tab：

| Tab | 内容 |
|---|---|
| **新闻** | 个股相关财经新闻与公告标题（东财站内搜索） |
| **财务** | 最近 12 期：营收/净利及同比、ROE、毛利率、负债率、EPS |
| **资金流** | 今日与近 5 日主力净流入、超大单/大单/中单/小单分解 |
| **所属行业** | 板块行情 + 成分股涨跌榜 → 判断"行业普跌"还是"个股独立行情" |
| **量化验证** | 选事件条件与参数 → 跑 Event Study → 样本量/超额/胜率/t 值/显著性 → 一键存笔记 |
| **智能盯盘** | 建规则（9 种条件）· 立即评估 · 触发记录（严重度分级 + 依据数值 + 确认） |
| **研究笔记** | 统计条 + 新建表单 + 列表 + 内联复盘（四档结论） |

## 能力清单

### 27 个 AI 工具

| 类别 | 工具 |
|---|---|
| 行情（9） | `stock_quote` · `stock_kline` · `market_overview` · `stock_relative_strength` · `stock_financials` · `stock_money_flow` · `stock_news` · `sector_overview` · **`stock_research_snapshot`**（核心聚合） |
| 研究（4） | `save_research_note` · `list_research_notes` · `review_research_note` · `research_notebook_stats` |
| 量化（3） | `run_event_study` · `collect_history` · `local_data_status` |
| 盯盘（5） | `create_watch_rule` · `list_watch_rules` · `evaluate_watch_rules` · `list_watch_triggers` · `watch_digest` |
| 通达信公式（6） | `import_formula` · `import_formula_dir` · `run_formula` · `list_formulas` · `delete_formula` · `tdx_capabilities` |

### 通达信（TDX）公式引擎

在对话里粘贴公式、或指定公式文件即可导入并计算。支持 40+ 常用函数、中文变量名、`:=`/`:` 语句、绘图属性。

**这是兼容子集，不是完整通达信**——三个诚实边界：

1. **加密公式文件（`.tne`）无法解析**：格式限制，不是权限问题。会让用户去「公式管理器」导出源码
2. **未来函数（`ZIG/PEAK/BACKSET` 等）检测并默认拒绝计算**：它们会重画历史，用来判断信号会得到虚假高胜率
3. **绘图指令（`DRAWTEXT` 等）被忽略但如实列出**：数值照算，不假装画出来了

口径未确认的平滑函数（`MEMA/WMA/DMA`）**不注册**——宁可报"不支持"，也不给"看起来像"的结果。

### 核心工具：stock_research_snapshot

一次调用返回标准化「当前股票状态快照」，避免 LLM 串联大量底层工具：

```
meta（数据源 + 数据版本指纹 + 是否可复现）
stock（行情 + 公司概况）        market（四大指数 + 涨跌家数 + 情绪分）
sector（行业涨跌 + 成分股统计 + 个股 vs 行业）
priceBehavior（5/20/60/120 日收益）
volumeBehavior（量能 z-score）  volatility（20/60 日波动率 + 环比）
relativePerformance（5/20/60/120 日超额）
moneyFlow · financials · news · anomalies（代码判定）
```

### 量化的 5 种事件条件

`volume_spike`（放量）· `breakout`（突破N日新高）· `drawdown`（回撤）· `ma_cross`（均线上穿）· `big_move`（单日大涨跌）

### 盯盘的 9 种条件

`price_threshold` · `daily_change_pct` · `volume_anomaly` · `turnover_spike` · `volatility_breakout` · `relative_strength_shift` · `money_flow_anomaly` · `sector_relative` · **`hypothesis_review_due`**（关联研究笔记，到期提醒复盘）

## 架构与铁律

```
┌──────────────────────────────────────────────────────┐
│              DSH Web UI（Client 插件层）              │
│   工作台页面 · 8 个区域 · 只调 /stock-lab/* 路由       │
└───────────────────────┬──────────────────────────────┘
                        │ 禁止直连任何行情 API
┌───────────────────────▼──────────────────────────────┐
│                 Host 插件层（Node.js）                │
│  AI Tools 21 个 ──→ MarketService ──→ datasource/*    │
│  StockContext  ·  Research  ·  Watch  ·  Quant 桥     │
└───────────────────────┬──────────────────────────────┘
                        │ Python 子进程（重计算）
┌───────────────────────▼──────────────────────────────┐
│   Python Backend：storage（csv.gz/Parquet）· quant    │
└──────────────────────────────────────────────────────┘
```

### 六条铁律（部分**由测试强制**）

| # | 铁律 | 强制方式 |
|---|---|---|
| 1 | **UI 与 LLM 都不得直接访问行情 API** | Client 测试断言代码里不含任何行情域名 |
| 2 | **只有 `market-service` 可 import `datasource/`** | Host 测试扫描全部源码，违规即失败 |
| 3 | **LLM 不算关键金融数据** | 收益/波动/z/t 值全部由代码算好再返回 |
| 4 | **数据必须带来源与时间戳** | 每条响应含 `source`、`fetchedAt`、`provenance` |
| 5 | **不把相关性说成因果** | 写死在 skill 与每个量化工具的返回里 |
| 6 | **可复现** | 数据版本指纹写入研究笔记 |

### 一个必须说清的架构边界

**插件无法向会话推送消息**（DSH 的插件作用域到不了 agent 层）。所以"主动提醒"由两层配合：

- **插件侧**：后台每 5 分钟评估盯盘规则（仅交易时段），写触发记录；`watch_digest` 提供紧凑简报
- **会话侧**：用 DSH 自带的提醒（`schedule_create`）在固定时间把它叫起来

这条边界与 `dsh-astock` 记录的"插件不可执行宿主工具"是同一类设计，已在 `skill.md` 写明正确用法。

## 目录结构

```
DSH股票工作台/
├── README.md               ← 你在这里（项目总览）
├── PLUGIN_REVIEW.md        Phase 0：5 个候选插件的源码级评审与 fork 决策
├── ARCHITECTURE.md         Task 2：分层架构、MarketService 契约、统一 schema
├── ROADMAP.md              Task 3：Phase 0–5 拆解 + 验收标准 + 当前进度
├── research/               被评审的 5 个插件源码（只读参考，不参与构建）
│
└── dsh-stock-lab/          实际交付的插件
    ├── package.json            bundle 清单
    ├── cordis.patch.yml        插入 DSH 层栈
    ├── skill.md                合规红线 + 研究方法论 + 盯盘用法（随插件分发）
    ├── README.md               插件实现细节（数据源坑、DSH 机制坑、测试清单）
    ├── src/
    │   ├── index.js            Host 入口：37 条路由 + 工具注册装配
    │   ├── client.js           Client bundle：工作台页面与全部 UI
    │   ├── data-root.js        数据根目录的唯一定义（读写两方共用）
    │   ├── datasource/         单一数据源适配器（只被 market-service 引用）
    │   │   ├── tencent.js          行情/K线/分时/搜索（GBK 解码）
    │   │   ├── sina.js             日线备源
    │   │   ├── eastmoney.js        宽度/资金流/财务/行业/新闻
    │   │   └── local.js            本地库直读（node:zlib + node:sqlite）
    │   ├── services/
    │   │   ├── market-service/     ★ 唯一数据入口（路由 + 缓存 + 归一化）
    │   │   ├── research-service/   Research Notebook（SQLite + markdown）
    │   │   ├── watch-service/      盯盘引擎（规则 + 求值 + 触发 + 冷却）
    │   │   ├── formula-service/    ★ 通达信公式（解析/求值/未来函数检测/公式库）
    │   │   └── quant-bridge/       Node → Python 子进程桥
    │   ├── tools/              AI 工具（行情 / 研究 / 量化 / 盯盘）
    │   └── context/            UI 状态 → LLM 上下文注入
    ├── backend/                Python
    │   ├── storage/            存储层（Parquet 优先，回退 csv.gz）
    │   ├── collectors/         历史数据采集（经 MarketService 取数）
    │   ├── quant/              Event Study
    │   └── tests/
    ├── tests/                  JS 测试（9 套）
    └── data/                   本地历史库（gitignore）
```

## 数据源

全部**免密钥**：

| 用途 | 主源 | 备源 |
|---|---|---|
| 实时行情 | 腾讯 `qt.gtimg.cn`（GBK） | — |
| K 线 | 腾讯 `fqkline`（前/后/不复权） | 新浪（日线） |
| 分时 | 腾讯 `minute/query` | — |
| 搜索 | 腾讯 smartbox | — |
| 涨跌家数 | 东财 `ulist.np` | — |
| 资金流 | 东财 `fflow/kline` | — |
| 财务 | 东财 datacenter | — |
| 行业板块 | 东财 `clist`（496 个板块） | — |
| 新闻 | 东财站内搜索 | — |

**如上表变动的唯一影响面是 `src/datasource/`**——UI、Tools、Agent 都不受影响。

## 测试与验证

```bash
cd dsh-stock-lab

# Node 侧
node tests/market-service.test.mjs   # 19 项  代码规范化 / 缓存 / single-flight
node tests/tools.test.mjs            # 11 项  工具计算逻辑 / 异常检测 / 溯源
node tests/host.test.mjs             # 20 项  装配契约 + 架构铁律 + 降级
node tests/client.test.mjs           # 28 项  bundle 契约 + 渲染 + UI 完整性
node tests/research.test.mjs         # 18 项  研究台账生命周期
node tests/research-tools.test.mjs   # 14 项  研究工具 + 数据版本自动记录
node tests/quant-bridge.test.mjs     #  7 项  Node→Python 桥
node tests/watch.test.mjs            # 39 项  盯盘求值 / 冷却 / digest
node tests/local-storage.test.mjs    # 20 项  本地库读写 + **跨语言契约**
node tests/tdx.test.mjs              # 52 项  通达信解析 / 求值语义 / 诊断
node tests/formula-store.test.mjs    # 41 项  公式库 + 公式工具
node tests/validate-resources.mjs    # 13 项  展示资源（locale / icon）与清单一致性
node tests/smoke-live.mjs            # 真实网络冒烟（腾讯）+ 字段合理性断言
node tests/smoke-live2.mjs           # 真实网络冒烟（东财）
node tests/smoke-tdx.mjs             # TDX 引擎在真实 K 线上的冒烟

# Python 侧
python backend/tests/test_storage.py       # 10 项  存储层
python backend/tests/test_event_study.py   #  9 项  事件研究
```

**合计 302 项自动化测试 + 3 套真实冒烟，当前全部通过。**

### 几个值得说明的测试设计

| 测试 | 为什么这样做 |
|---|---|
| **跨语言契约测试** | 本地库 Python 写、Node 读。测试让 Python **真的写一次**、Node 读回来逐项比对，并比对两侧解析出的目录一致——这条守着一个真实修过的 bug（写进 A 却读 B） |
| **架构铁律测试** | 扫描全部源码，任何非 `market-service` 文件 import `datasource/` 就失败——用测试锁住分层，而不是靠自觉 |
| **前后端一致性测试** | 前端条件 key **从后端源码读出后逐一比对**，防止两边漂移 |
| **防未来函数测试** | 事件研究专门测"末尾 horizon 根不作为事件" |
| **字段合理性断言** | 冒烟测试断言换手率 0<t<100、成交额 1e9~1e12、涨停价>现价——防止数据源字段错位再次发生 |
| **降级路径测试** | `tools`/`timer` 服务缺失时必须告警而非静默失败（曾因静默失败导致 AI 功能整体不可用） |
| **展示资源校验** | 校验 locale JSON 含真实标题、icon 是合法 SVG 且未超 256 KiB、`package.json` 的 `exports`/`files` 指向的文件真实存在——防止"声明了不存在的文件"这类清单漂移 |

## 当前完成度

| 阶段 | 状态 | 说明 |
|---|---|---|
| **Phase 0** 插件调研与复用决策 | ✅ 完成 | 源码级评审 5 个插件；`dsh-waste-market` 因代码混淆被排除 |
| **Phase 1** Stock Terminal MVP | ✅ 完成 | 工作台 UI + 行情工具 + Context + 合规 skill |
| **Phase 2** AI Research | 🟡 约 90% | 台账✅ UI✅ 行业✅ 历史落库✅ 本地库接入✅ snapshot 长窗口✅ ／ 事件时间线⬜ |
| **Phase 3** Quant Lab | 🟡 约 70% | Event Study✅ Quant UI✅ ／ 回归·回测·walk-forward⬜ |
| **Phase 4** Intelligent Watch | ✅ 基本完成 | 9 条件✅ 异常检测✅ 假设提醒✅ UI✅ 提醒通道✅ |
| **Phase 5** 通达信公式 | 🟡 引擎完成 | 解析/求值/未来函数检测/导入通道✅ ／ 主页面展示⬜ |
| **Phase 6** 右栏 Chat | ⬜ 未开始 | 已定方案：`ctx.llm` + 自建工具循环 |
| **Phase 7** 按标的对话线程 | ⬜ 未开始 | 设计已定，待实施 |
| ~~Phase 3 量化扩展~~ | 🧊 冻结 | 回归/回测/walk-forward 不做 |
| ~~Phase 5 高级研究~~ | 🧊 冻结 | 状态向量/Regime/ML/组合 不做 |

**完成度自评**：代码层面约 75%。但**UI 从未被人眼确认过**——所有界面验证都是接口级的。这是当前最大的不确定性。

### 规模

| 类型 | 规模 |
|---|---|
| 设计文档 | 470 行（3 份） |
| JS 源码 | 4,532 行 / 20 文件 |
| Python 后端 | 530 行 / 3 文件 |
| 测试 | 1,753 行 / 13 文件 |
| **合计** | **约 6,800 行** |

## 设计文档索引

| 文档 | 内容 |
|---|---|
| [`PLUGIN_REVIEW.md`](PLUGIN_REVIEW.md) | Phase 0 调研：5 个候选插件的结构 / 数据源 / 可复用模块 / 风险，以及 fork 决策与理由 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 分层架构、MarketService 契约、统一数据 schema、UI Context 设计、工具设计、设计决策记录 |
| [`ROADMAP.md`](ROADMAP.md) | Phase 0–5 的完整任务拆解（Goal / Input / Output / Files / Acceptance / Deps）+ 逐项进度 |
| [`dsh-stock-lab/README.md`](dsh-stock-lab/README.md) | 插件实现细节：数据源字段坑、DSH 插件机制坑、测试清单、安装与验证方法 |

## 已知的坑

开发过程中踩到并修复的**真实缺陷**（完整记录在插件 README）：

| 类型 | 例子 |
|---|---|
| **数据源字段** | 腾讯按位置取值：误把成交量当成交额（差 13 倍）、误把成交额当换手率（变成 76 万）；东财 PE/PB 放大 100 倍；东财财务字段是 `REPORTDATE` 不是 `REPORT_DATE` |
| **DSH 插件机制** | `inject` 缺 `tools`/`skills` → **AI 工具静默不注册**（界面正常但 AI 完全不可用）；`ctx.set()` 需要 `declare provide` |
| **跨语言契约** | 读写两方数据目录解析不一致 → **写进 A 却读 B**，数据在却报"无数据" |
| **统计边界** | 成交量 z-score 在历史标准差为 0 时（一字板）会算出无穷大，原实现返回 null 导致"极端异常"被静默吞掉 |

---

## 许可与合规

- 代码：MIT
- 数据：来自第三方公开接口，请遵守各数据源的服务条款
- **禁止**用于内幕交易、市场操纵等违法用途
- 本项目**不提供投资建议**，不代客理财，不做自动下单