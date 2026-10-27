# PLUGIN_REVIEW.md — DSH 股票相关插件调研报告（源码版）

> 版本 v1.0 · 2026-10-23 · 基于五个候选插件的完整源码评审（源码位于 `research/` 下）
> 结论先行：**主 fork 对象 = `dsh-astock`**（可读、有测试、架构清晰）；辅助借鉴 `dsh-stock-leek`（SSE 推送/指数栏）、`dsh-astock-research`（AI Tool 注册模式 + 合规 skill）、`dsh-stock-mentions`（多源 fallback + RPC 通道）；**`dsh-waste-market` 排除**（代码混淆不可维护）。

---

## 0. 关于用户点名的三个插件

`dsh-plugin-stock`、`dsh-stock-market`、`dsh-finance-plugins` 在两个 DSH 插件市场均不存在，GitHub 也无对应知名项目。已用市场真实存在的五个 A 股相关插件替代评估。

---

## 1. dsh-astock（hzy1522）0.9.0 — ⭐⭐⭐ 主 fork 对象

**文件**：`research/dsh-astock-main/dsh-astock-main/`

### 1.1 项目结构

```
package.json         main=lib/index.js, exports["./client"], dsh.bundle.patch
cordis.patch.yml     - insert: { id: astock, name: dsh-astock }
lib/index.js         Host 端，2055 行，单文件
client/client.js     Client bundle，3110 行，__ModuleLoader__ 工厂块，仅 require('react')
tests/               engine(43,离线) / host(280,打真实上游+mock llm) / client(274,自建hook运行时)
```

- **DSH 插件结构**：标准 bundle。Host `export const name/inject=['webServer']/apply(ctx)`；Client `window.__ModuleLoader__.load({id, factory})` 返回 `{name, inject:['slots'], apply}`。
- **无构建步骤**：手写 ESM，client 是手写 bundle 而非打包产物——可读、可直接改。
- **通信方式**：Client ↔ Host 走 `ctx.webServer.register` 注册的 HTTP 路由（`/astock/api/*`，共 13 条，见 `lib/index.js:2299-2420`），**不用 WebSocket/FastAPI**，无 Python 后端。README 明确注明"`host.call` 是动态插件专有机制，正式 bundle 不可用"。
- **slot 挂载**：`client.js:3102-3104` —— `main` 整页 + `sidebar.panellist`（label 'A股港股', order 60）。

### 1.2 数据源（全部免密钥）

| 用途 | 端点（`lib/index.js:29-33,327-330`） |
|---|---|
| K线（主） | 腾讯 `web.ifzq.gtimg.cn/appstock/app/fqkline/get`（按年分页，前/后/不复权） |
| K线（备） | 新浪 `money.finance.sina.com.cn`（主源失败自动切换，`source` 字段溯源） |
| 实时行情 | 腾讯 `qt.gtimg.cn`（GBK 解码） |
| 搜索 | 东方财富 `searchapi.eastmoney.com`（代码/名称/拼音首字母） |
| 财务 | 东方财富 `datacenter-web.eastmoney.com`（16 期 EPS/BPS/ROE/毛利率，仅 A 股） |
| 事件 | 东财公告正文（np-cnotice-stock，解析结果按 art_code 落盘缓存）+ 预约披露表 + 分红公告 |
| 可选 | 同花顺官方 REST（fuyao.aicubes.cn，用户自配 Key，0.9.0 新增） |

**没有 pytdx / Tushare**——Stock Lab 需自行新增这两个适配器。

### 1.3 已有能力（可直接复用）

- **K线组件**：手写 SVG 蜡烛图（阳空心红/阴实心绿）、MA5/10/20/60、成交量副图、十字光标、60–500 根缩放平移。无第三方图表库依赖。
- **自选股**：A股/港股混排，JSON 落盘（`$DSH_ASTOCK_HOME/watchlist.json`）。
- **回测引擎**（纯函数，`client.js` 内）：A股 T+1/涨跌停分板块/整手 vs 港股 T+0/逐股手数/双边印花税自动切换；佣金/印花税/滑点；收益/年化/最大回撤/夏普/卡玛/胜率。
- **策略系统**：表达式 DSL（自写词法/语法分析器，不用 eval）+ JS 模式共用同一指标实现；9 个参数化模板。
- **相对强弱因子**：`RS(n)` `BETA(n)` `IDXRET/IDXMA/IDXDEV/IDXVOL`（个股 K线 + 沪深300 计算，无前视偏差处理）——正是 Stock Lab Relative Strength Engine 的雏形。
- **事件因子**：`EV/EVMEET/EVREP/EVDIV/EVCUS(n)`，公告日前置合规保护（当天未公告不触发，有测试守着）。
- **AI 策略对话**：走宿主 `ctx.get('llm')` + `agentDefaultModel`，**不需插件自配 API Key**；多轮、表达式/JS 双模式产出、试运行校验；宿主 web_search 坏时自动降级到内置东财资讯检索。
- **交易证据链**：条件函数返回时记录身份/操作数/结果，信号日反向还原"为什么买/卖"——这与 Stock Lab"事实/证据"研究方法论完全同构。
- **免责声明**：首次强制确认（落盘、版本变更重提示）+ 底部常驻精简声明。

### 1.4 实测发现的重要架构事实（README 0.8.0 节，运行时探针验证）

> 插件上下文中 `ctx.get('tools')` 只有 `register/schemas/get`，**没有 `execute`**；`ctx.get('skills').list()` 返回 0 条——**插件无法调用宿主注册的工具（含 MCP），也读不到 skill 目录**。

对 Stock Lab 的含义：AI Tools 必须由我们自己的插件**注册**（tools.register 可用），LLM 在 agent 会话中可调用；但插件不能反向执行别的插件的工具。dsh-astock-research 正是用 `inject: ['tools','skills']` + `ctx.tools.register` / `ctx.skills.register` 的模式（见其 `index.js:10,26,79`），验证了这条注册路径可行。

### 1.5 不建议复用 / 需重构

- **单文件 2055 行 Host + 3110 行 Client**：需要按 Stock Lab 的模块边界（market-service / datasource / tools / ui）拆分。
- **字段未完全归一化**：K线/行情解析散落在路由层，没有独立 MarketService 抽象与统一 schema（Quote/Bar）。重构时按 ARCHITECTURE §3 封装。
- **无本地历史数据库**：只有 watchlist/events/announcements 三个 JSON + 进程内缓存。Parquet/SQLite 层需新建。
- **"择时→选股→仓位→止损"色彩**：策略/回测是主流程。按项目原则降级为可选策略模块；Stock Lab 主流程改为"市场→行业→个股→假设→验证→跟踪→复盘"。
- **客户端与 Host 用 HTTP 轮询**，无 SSE 推送（leek 有，见 §3）。

### 1.6 维护状态

0.9.0（2026-09-14），版本记录详尽（0.5.0→0.9.0 每版都有问题复现与测试计数），597 项测试。单作者，但工程质量在五个候选中最高。**维护活跃，风险可接受**。

---

## 2. dsh-waste-market（@czf1995）0.8.2 — ❌ 排除

**文件**：`research/dsh-waste-market-main/dsh-waste-market-main/`

- **全部代码混淆**：`lib/index.js / advisor.js / backtest.js / emrank.js / screener.js / client.js / fetch-utils.js` 均为 `a0_0x…` 十六进制字符串混淆产物（单文件单行）。
- 功能面（大盘仪表盘/13 信号选股/情绪温度计/板块轮动）与 Stock Lab 部分重叠，但**混淆代码无法阅读、无法审计、无法安全 fork**；且选股器路线与项目原则 8 不符。
- **结论：排除。仅参考其功能清单（大盘宽度/情绪指标），不参考代码。**

---

## 3. dsh-stock-leek（@shiqyka）0.7.1/0.7.2 — ⭐⭐ 借鉴推送与指数栏

**文件**：`research/dsh-stock-leek-main/dsh-stock-leek-main/`

### 结构

```
index.js       Host 1627 行：/dsh-stock-leek/* 只读行情路由 + 配置原子写盘
client.js      Client（indexbar 指数栏 + 悬浮窗 大盘/自选/持仓）
lib/shared.js  共享纯逻辑（格式化/盈亏口径/交易时段/预警步进），test/shared-drift.mjs 防双端漂移
test/          8 套测试（契约/隔离/路由/安全/e2e 渲染）
docs/          architecture.md 等 4 篇
```

### 值得借鉴

- **SSE 行情推送**：`/stream` 多标签页共用一次拉取（`index.js:1268-1474`），订阅集合驱动上游抓取，无订阅即休眠；`/alert-stream` 独立预警评估循环——**Watch Engine 的直接参考实现**。
- **腾讯 smartbox 全市场搜索**（A/北/港/美/指数/ETF，`proxy.finance.qq.com/.../smartbox/search/get`）——比 dsh-astock 的东财搜索覆盖更广，可做 Stock Lab `market.search` 的主源。
- **分时端点** `minute/query`（astock 没有分时）。
- **美股 K 线需用 `usfqkline` 端点**的实测备注（fqkline 对美股只回 1 根）。
- **配置原子写盘 + 惰性路径解析 + 历史路径迁移**的工程细节。
- 缓存 TTL 参考：quote 1.5s / minute 5s / kline 60s。

### 局限

无 AI Tools、无 LLM 集成、纯展示型。预警规则是简单价格/涨跌幅阈值，不是 Stock Lab 的智能事件。

---

## 4. dsh-astock-research（tiantianlaolao）0.1.1 — ⭐⭐ 借鉴 Tool 注册与合规 skill

**文件**：`research/dsh-astock-research-master/dsh-astock-research-master/`（单文件 194 行 + skill.md 64 行）

### 结构（`index.js`）

- `inject: ['tools','skills']`；`ctx.tools.register({name, description, parameters(JSON Schema), execute, output})` ×6：`stock_search / stock_profile / stock_announcements / stock_financials / factor_catalog / open_aihey_backtest`。
- `ctx.skills.register({name:'stock-research', content: 读同目录 skill.md, source:'bundled'})`——**skill 随插件分发**的模式，Stock Lab 直接沿用。
- 零依赖：原生 fetch 调云端量化 API（`quant.tybbtech.com`，第三方托管服务，约 5000 只 A 股、2011 至今）。
- 细节：输出瘦身（`slimBar` 控 token）、404 视为正常返回而非工具错误、限流错误翻译成人话。

### skill.md 的合规/方法论框架（直接可改造为 Stock Lab 的 skill）

- 合规铁律：只陈述事实、不给投资建议、每条个股回复附免责声明。
- 来源分层："确定数字用工具，开放叙事用联网"，**不得把模型记忆冒充工具返回**。
- 越界识别：回测/反找/全市场统计 → 引导到重计算引擎（Stock Lab 里改为引导到自家 Quant Engine）。

### 局限

- **数据依赖第三方云端服务**（quant.tybbtech.com），不是自可控数据源；Stock Lab 不能用这个后端，只借鉴其 tool schema 与 skill 文本。
- 无 UI、无 K线、无本地库。重型功能引导去外部产品（AIHEY）——正是 Stock Lab 要自建的能力。

---

## 5. dsh-stock-mentions（mingzeng21）0.1.3 — ⭐ 借鉴多源 fallback 与 RPC 通道

**文件**：`research/dsh-stock-mentions-main/dsh-stock-mentions-main/`（TypeScript + Vitest，五候选中工程规范最标准）

### 值得借鉴

- **多数据源 fallback 链**（`src/stock-api/service.ts`）：按用途分别配置 provider 顺序（resolver/quote/intraday/kline/news 各一条链，`eastmoney/tencent/sina/tonghuashun` 四源），`withFallback` 逐源尝试 + 结果互补（quote 缺 marketCap 时自动用东财补，`enrichQuote`）——**正是 ARCHITECTURE §3"多源 fallback + 字段归一"的参考实现**。
- **schemastery Config schema**（`src/index.ts:16-43`）：缓存 TTL/超时/provider 顺序全部进插件配置——Stock Lab 的 MarketService 配置可照此建模。
- **Host↔Client 通信用 `connection.rpc.handle`**（版本化 RPC 协议，`rpc-contract.ts`），比裸 HTTP 路由更结构化；注意它需要同时 `inject: ['connection','webServer']`。
- **SecurityResolver**：对话文本中股票名→候选→确认后才上行请求（安全设计：不把任意文本/URL 发给上游）。
- ADR 文档（`docs/adr/0001-standalone-data-layer.md`）论证了"独立数据层"的决策——与 MarketService 分层同思路。

### 局限

功能面窄（对话中股票名可点击 → 侧边栏行情面板）；无 K 线主图工作台（面板内有小图）；无 AI tools。

---

## 6. 复用矩阵

| 能力 | 来源 | 复用方式 |
|---|---|---|
| DSH bundle 骨架、slot 挂载（main+sidebar.panellist） | dsh-astock | fork 后改 |
| K线 SVG 组件（蜡烛/MA/量/十字光标） | dsh-astock | 直接保留，移入 ui/components |
| 腾讯 K线/行情/GBK 解码 + 新浪备源 | dsh-astock | 移入 datasource/tencent.js、sina.js，加归一化层 |
| 东财搜索/财务/公告事件（含限流退避、正文落盘缓存） | dsh-astock | 移入 datasource/eastmoney.js |
| 全市场搜索（smartbox）+ 分时 + SSE 推送 + 预警循环 | dsh-stock-leek | 移植进 datasource/tencent.js 与 watch-service |
| 回测引擎（T+1/涨跌停/成本模型）+ 策略 DSL + 证据链 | dsh-astock | 降级为可选策略模块 quant/strategy/ |
| 相对强弱因子 RS/BETA/IDX* | dsh-astock | 扩展为 Relative Strength Engine |
| AI Tool 注册模式 + 输出瘦身 + 错误翻译 | dsh-astock-research | tools/ 层规范 |
| 合规 skill（事实/建议分离、来源分层、免责声明） | dsh-astock-research skill.md | 改造为 stock-lab skill |
| 多源 fallback 链 + Config schema + RPC 通道 | dsh-stock-mentions | MarketService 配置与通信参考 |
| 宿主 llm/agentDefaultModel 复用（免配 Key） | dsh-astock | 保留 |
| 免责声明强制确认 + 常驻条 | dsh-astock | 保留 |

## 7. 风险更新（v1.0）

| 风险 | 状态 |
|---|---|
| dsh-astock 单文件过大 | 确认：需按模块边界重构，fork 时第一批工作 |
| 无 pytdx/Tushare 现成实现 | 确认：需自写适配器（datasource/pytdx.js 经 Python sidecar，Phase 2） |
| 无本地历史库 | 确认：Phase 2 新建 backend/storage |
| 东财公告接口限流（ECONNRESET） | dsh-astock 已有退避+落盘缓存方案，沿用 |
| 宿主 web.search 可能坏 | dsh-astock 已有内置检索降级方案，沿用 |
| 插件作用域无法执行宿主工具/读 skill | 确认（两插件独立验证）：AI Tools 必须自行注册，skill 随插件 bundled |
| waste-market 混淆代码 | 排除，零复用 |

## 8. 最终决策

**D2 落地：fork `dsh-astock` 为 `dsh-stock-lab` 起点。**

- 保留：bundle 骨架、slot 结构、K线组件、回测引擎（移为可选模块）、腾讯/新浪/东财适配逻辑、事件因子体系、LLM 复用宿主、免责声明机制、测试风格。
- 重构：lib/index.js 按 market-service/datasource/tools 拆分；字段归一化到统一 schema。
- 新增：MarketService 抽象、AI Tools 8 个、StockContext provider、SSE 推送（自 leek）、stock-research skill（自 research）、本地数据层（Phase 2）、Research Notebook / Quant / Watch（Phase 2–4）。
- 删除/不做：选股推荐话术、任何"买卖建议"色彩、waste-market 的任何代码。
