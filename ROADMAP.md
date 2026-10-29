# ROADMAP — DSH Stock Lab 分阶段任务路线图

> 版本 v0.4 · 2026-10-27
> 每个任务包含：Goal / Input / Output / Files / Acceptance（验收标准）/ Deps（依赖）。
> 阶段严格串行；完成验收后才进入下一阶段。
>
> **文档结构**：一、原始阶段计划（Phase 0–4，已完成） → 二、范围调整 → 三、当前主线（Phase 5–8） → 四、冻结与推迟 → 五、进度与验证记录
>
> **v0.4 变更（2026-10-27）**：补录 2026-10-25 ~ 10-27 的既成事实 —— **D18 K 线交互**、**D19 图表画线**（新增 Phase 8）、
> 侧栏显示名改「看盘助手」、T6.5 的 `session-map.js` 未接线这一实测状态；验证记录与依赖图按 2026-10-27 复跑数字更新。

---

# 一、原始阶段计划（Phase 0–4）

## Phase 0 — 调研与复用决策

### T0.1 插件源码获取 ✅（本机网络受限，等用户手动下载）
- **Goal**：拿到候选插件源码
- **Output**：`research/dsh-astock/`、`research/dsh-waste-market/` 等
- **Acceptance**：目录下存在各仓库 package.json
- **Deps**：用户提供 ZIP 或网络恢复

### T0.2 源码级评审
- **Goal**：按 PLUGIN_REVIEW.md 第 3 节清单逐项核实 13 个维度
- **Input**：T0.1 源码
- **Output**：PLUGIN_REVIEW.md v1.0（含源码分析章节 + fork/自建终判）
- **Acceptance**：每个维度有源码证据（文件路径+行号引用）；D2 决策落地
- **Deps**：T0.1

### T0.3 运行基线插件
- **Goal**：在当前 profile 安装并运行首选插件（dsh-astock），确认可用性
- **Output**：运行截图/验证记录附入 PLUGIN_REVIEW.md
- **Acceptance**：K线/自选/行情在 DSH GUI 可见
- **Deps**：T0.2；plugin_manager 安装

---

## Phase 1 — Stock Terminal MVP

### T1.1 插件骨架
- **Goal**：创建 `dsh-stock-lab` 插件包（fork 或自建，依 T0.2 结论）
- **Output**：package.json / cordis.patch.yml / src/index.js / src/client.js / locale / icon
- **Files**：`dsh-stock-lab/` 全骨架
- **Acceptance**：install_bundle 成功；GUI 出现插件入口；inspect 可见 service
- **Deps**：T0.2

### T1.2 MarketService + 东方财富适配器
- **Goal**：实现 `getQuote/getQuotes/getKline/search/getIndex` + symbol 规范化 + 内存缓存
- **Files**：`src/services/market-service/`、`src/datasource/eastmoney.js`
- **Acceptance**：Host 内 `ctx.service` 调用返回统一 schema（Quote/Bar）；字段无 eastmoney 原生名；停牌/ST 标注正确
- **Deps**：T1.1

### T1.3 工作台页面：顶部指数栏 + 左侧自选/搜索
- **Goal**：workspace page 挂载；指数栏（上证/深证/创业板/沪深300/成交额/涨跌家数）；自选股增删（本地持久化）；搜索框
- **Files**：`src/ui/workspace/`、`src/ui/store.js`
- **Acceptance**：GUI 中指数实时刷新（盘中 ≤10s）；自选股重启后保留；搜索能定位股票并设为当前股票
- **Deps**：T1.2

### T1.4 K线组件
- **Goal**：日K/分时 + 成交量，复用 fork 源或 lightweight-charts
- **Acceptance**：选中股票出图；timeframe 切换；复权切换
- **Deps**：T1.3

### T1.5 AI Tools 首批 + Context 注入
- **Goal**：注册 `stock_quote/stock_kline/market_overview`；StockContext provider 注入当前股票
- **Files**：`src/tools/`、`src/context/stock-context.js`
- **Acceptance**：会话中问"现在这只股票多少钱"（当前页已选中茅台）→ LLM 经 tool 返回正确答案且不要求用户重复股票名
- **Deps**：T1.2、T1.3

**Phase 1 总验收**：点击股票 → 出 K线 → 直接和 LLM 讨论该股票。

---

## Phase 2 — AI Research

### T2.1 Python sidecar + 历史落库
- **Goal**：FastAPI sidecar；Tushare/东财日线采集 → Parquet；SQLite 元信息库
- **Files**：`backend/`、`data/bars/`、`data/stocklab.db`
- **Acceptance**：指定股票 5 年日线落库可复查；记录 source+时间戳
- **Deps**：Phase 1；Tushare token（可选降级）

### T2.2 相对强弱引擎
- **Goal**：超额收益 / rolling beta / 相关性 / 波动率 / 量 z-score，落库
- **Files**：`backend/research/relative.py`
- **Acceptance**：`stock_relative_strength` tool 返回个股 vs 指数 vs 行业 20 日对比，数值与手工抽样核算一致
- **Deps**：T2.1

### T2.3 新闻/公告/事件时间线
- **Goal**：`stock_news`、公告查询、事件时间线落库
- **Deps**：T2.1

### T2.4 stock_research_snapshot
- **Goal**：按 ARCHITECTURE §6 契约实现聚合快照（anomalies 代码计算）
- **Acceptance**：对任意 A 股返回完整 JSON；anomalies 至少覆盖量异常/相对强度突变/波动突破三类
- **Deps**：T2.1–T2.3

### T2.5 Research Notebook
- **Goal**：Note 模板（观察/假设/证据/反证/预测/置信度/复盘日）、保存/列表/到期提醒；`save_research_note` tool
- **Files**：`data/research/`（markdown + SQLite 索引）
- **Acceptance**：AI 分析可一键存为 note；note 记录数据版本与截止日；到期出现在提醒中
- **Deps**：T2.4

**Phase 2 总验收**：问"这只股票最近为什么这样"→ AI 给出事实/异常/假设结构化回答并可存档。

---

## Phase 3 — Quant Lab

### T3.1 quant-bridge + event study
- **Goal**：Host→Python 桥；`run_event_study(条件, 前瞻窗口)` 返回样本数/平均超额/显著性
- **Acceptance**：自然语言假设（经 LLM 结构化）→ 历史事件研究 → LLM 解释，全链路可复现（参数落库）
- **Deps**：T2.1

### T3.2 回归 / 因子测试 / 简单回测 / walk-forward
- **Acceptance**：每个方法有单测 + 一个真实假设的端到端示例 note
- **Deps**：T3.1

### T3.3 Quant 页面
- **Goal**：底部 Quant tab：实验列表、参数、结果图表、关联 note
- **Deps**：T3.2

---

## Phase 4 — Intelligent Watch

### T4.1 规则引擎（表达式：指标比较 + 逻辑组合）
### T4.2 异常检测器（量/波动/相对强弱/Beta/资金流/新闻密度）
### T4.3 Research Hypothesis Trigger + 自动复盘提醒（与 Notebook 联动）
- **每任务 Acceptance**：构造触发样本 → 收到提醒 → 可跳转对应 note/图表

---

# 二、范围调整（2026-10-23，依据用户反馈）

> 用户反馈："这个项目目前加进去的东西有点多。量化相关的内容可以先停下来。"

因此**优先级重排**：

| 处理 | 内容 |
|---|---|
| 🧊 **冻结** | Phase 3 量化（Event Study 与 Quant UI **保留可用**，但不再扩展：不做回归 / 回测 / walk-forward / 因子测试）；Phase 5（状态向量 / Regime / ML / 组合分析） |
| ⏸ **推迟** | 事件时间线（公告/财报/除权）；snapshot 接入 pytdx / Tushare |
| 🆕 **新增（本阶段主线）** | **T5 通达信公式** · **T6 右栏 Chat** · **T7 按标的的对话线程** |
| ✅ **继续维护** | 行情与工作台、AI Tools、Research Notebook、行业维度、本地历史库、智能盯盘 |

---

# 三、当前主线（Phase 5–8）

## Phase 6 前置：布局骨架 ✅（已完成）

> 用户决策 D14：右栏宽度**由用户拖拽决定**。这解掉了「T5.5 图表区与 T6.3 Chat 都要改布局」的协调问题——先做布局骨架，两边各自往里填。

- [x] **三栏布局**：左（自选/搜索，236px 固定）| 中（图表 + 底部 tab，flex）| 分隔条 | 右（AI 助手，可调宽）
- [x] **可拖拽分隔条**：Pointer Events + `setPointerCapture`；双击复位；拖动中禁用文本选中
- [x] **键盘可达**：←/→ ±24px（Shift ×4）、Home/End 到最小/最大、回车复位；`role="separator"` + aria 值
- [x] **夹取规则**：默认 380 · 下限 260 · 上限 `min(900, 容器×55%)`（保证图表区 ≥45%）· 上限不低于下限 · 容器未知用 900
- [x] **持久化**：`localStorage['stock-lab:rightPane']` 存宽度与收起态（拖动中不写盘）
- [x] **窄窗口适配**：容器 < 880px 可收起为竖条，一键展开
- [x] **纯函数化**：`clampPaneWidth()` 可离线测试边界，已导出 `__test` 供测试调用
- [x] 右栏当前为占位（说明即将具备的能力），待 T6.3 填入真实 Chat
- **测试**：client 从 28 项增至 43 项（历史数字，当时新增 15 项覆盖夹取边界与交互契约；当前值见第五节 2026-10-29 复核 —— client.test.mjs **316 项**）

## Phase 5 — 通达信公式兼容（✅ 已完成）

### T5.1 TDX 词法/语法解析器 ✅（已完成）
- **Files**：`src/services/formula-service/tdx-parser.js`
- **已实现**：`A:=EXPR;` / `A:EXPR;` / `A:EXPR,COLORRED;`；算术、比较、逻辑、括号；一元 `- + !`；
  `{ }` 与 `//` 注释；**字符串字面量**（DRAWTEXT 的 `'底'`，不支持会导致整条公式解析失败）；
  **中文变量名**；大小写不敏感的函数名
- **容错**：末行缺分号、整篇按行写不带分号都能解析（通达信实际粘贴文本常见）
- **诊断**：括号未闭合、缺 `:=`/`:`、运算符右侧缺表达式、注释未闭合、无法识别字符，全部带行号
- **护城河**：超长文本上限（防粘贴巨文本）、**加密/二进制识别**（不可打印字节占比 >10% 即拒绝，并提示去"公式管理器"导出源码）

### T5.2 函数库与求值器 ✅（已完成）
- **Files**：`src/services/formula-service/tdx-functions.js`、`tdx-evaluate.js`
- **已实现 29 个可计算函数**：`MA EMA SMA REF HHV LLV SUM STD CROSS COUNT EVERY EXIST IF IFF
  BARSLAST BARSSINCE BARSCOUNT MAX MIN ABS SQRT POW LOG EXP SIGN ROUND INTPART CEILING FLOOR` + **7 个序列变量名**（`O/H/L/C/V/VOL/AMOUNT`；其中 `V` 与 `VOL` 同指成交量，共 **6 个序列**）
  - **口径**：`supportedFunctionNames().length === 29`（有测试固定）；序列变量名是 7 个（对应 6 个序列，`V`/`VOL` 同指成交量），与函数分开计——旧文写"支持 40+ 函数"是把两者混算后的错误数字；`SERIES_VARS` 见 `tdx-evaluate.js:18-25`
  - 注册表 `FUNCTIONS`（Map）共 **58** 个键 = **29 个函数 × 2**（大写名 + 小写别名；函数名大小写不敏感）；
    四类"不能用"的名字（未来函数 7 / 依赖数据 7 / 未实现 5 / 绘图指令 18，共 37）**不在**这张表里，各在独立集合（见 T5.3）
- **口径显式记录并有测试固定**：MA 前 N-1 根无效；EMA 首值取首根（alpha=2/(N+1)）；SMA 首值取 X；**STD 用总体标准差（÷N）**；CROSS 首根不可能为上穿
- **不静默近似**：口径未确认的平滑函数（MEMA/WMA/DMA/EXPMA）**不注册**，直接用会报"不支持"
- **稳健**：`REF` 越界为 null、除零为 null（不是 Infinity）、null 在逻辑上下文当 false

### T5.3 未来函数检测 ✅（已完成）
- **四类"不能用"的名字必须分开报**（把「缺数据」说成「未来函数」会误导用户；处置见 `tdx-evaluate.js:146-182`）：
  | 类别 | 数量 | 成员 | 处置（原文见代码） |
  |---|---|---|---|
  | 未来函数（会重画历史） | 7 | `ZIG PEAK PEAKBARS TROUGH TROUGHBARS BACKSET REFDATE` | 默认拒绝计算；诊断写明"用于判断信号结果不可信" |
  | 绘图指令 | 18 | `DRAWTEXT DRAWICON DRAWNUMBER DRAWLINE DRAWKLINE STICKLINE POLYLINE PARTLINE DRAWBAND DRAWRECTREL VERTLINE HORLINE DRAWGBK` + **5 个 `_FIX` 变体**（`DRAWTEXT_FIX DRAWICON_FIX DRAWNUMBER_FIX DRAWLINE_FIX DRAWRECTREL_FIX`） | 已忽略，但**输出线数值照算**，并如实列出被忽略的指令 |
  | 依赖数据 | 7 | `FINANCE FINANCE_EX DYNAINFO CAPITAL SELFDATA HYBLOCK INBLOCK` | 报"需要财务/实时快照数据，本引擎只提供 K 线序列"（**数据缺失，不是公式有问题**） |
  | 明确未实现 | 5 | `COST WINNER LWINNER PPART PWINNER` | 报"尚未实现（只靠 K 线可算，属实现缺口）" |
- 旧文把上表后三类与未来函数混在一起写成一个 12 个名字的清单，读起来像"它们都是未来函数"——**分类错了，处置也就对不上**，故按代码重列
- `analyze()` 返回 `requiresFutureOptIn`；`run()` **默认拒绝计算**，除非显式 `allowFutureFunctions`；
  `tdx_capabilities` 工具与 `/formula/capabilities` 路由把上述四类连同"可用函数清单"一起返回（不靠猜）

### T5.4 导入通道 ✅（已完成）
- **6 个 AI 工具**：`import_formula`（文本/文件）、`import_formula_dir`（目录批量）、`run_formula`、`list_formulas`、`delete_formula`、`tdx_capabilities`
- **6 条路由**：`/formula/{list,analyze,import,run,delete,capabilities}`
- `FormulaStore`（SQLite）：存**公式原文** + 诊断快照；同 name+symbol 视为更新；同名优先取绑定该标的的版本，否则回退通用公式
- 文件读取（`read-file.js`，工具与路由共用）：体积上限、**GBK 兜底解码**、加密扩展名拒绝并给可操作提示、目录扫描区分可导入/不可导入
- **选股信号提取的安全设计**：只有最后一条输出线**全为 0/1/null** 才当作选股条件；指标线（如均线）会明确说明"不能当选股条件"，避免把每个非零值都算成命中

### T5.5 主页面展示 ✅（已完成：主图 + 副图）
- **主图叠加**：数值落在价格区间内（留 10% 余量）的线画在蜡烛图上，**价格轴会把这些线一起纳入范围**，避免均线被裁掉
- **副图**：量纲不同的线（MACD 有负值 / RSI 0~100）画在成交量下方独立副图，**含零轴**（柱状需要）
- **柱状渲染**：通达信 `COLORSTICK / VOLSTICK / STICKLINE` 等属性 → 直方图，按正负着色
- **选股信号标记**：**纯 0/1 的条件线不画成曲线**（一条在 0~1 跳动的线糊在角落没有意义），而是在命中的 K 线上标 ▲，并在图例里给出命中次数
- **折线断开**：`null` 处不跨缺口连线（`polylinePath` 纯函数，有测试固定"两段独立折线"）
- **主题跟随**：线色**只用 DSH 主题 token**（无硬编码色值，切换明暗主题自动跟随）；通达信 `COLORRED/COLORGREEN/COLORYELLOW` 等属性如实映射到主题色
- **周期对齐**：公式在「图表当前显示的那批 K 线」上求值（`timeframe/adjust/count` 跟随图表），否则切周线/月线时刻线与柱体会错位。实测：同一 MACD 日线末值 +12.61、周线 -8.19
- **诚实标注**：未来函数导致的"拒绝计算"在图例里写明原因并可跳转到「指标公式」tab 看详情
- **2026-10-27 复核（代码依据，确认"已完成"）**：主图/副图分类与线色映射、折线断点分别由
  `src/client.js` 的 `classifyFormulaOutputs` / `formulaLineColor` / `polylinePath` 实现并导出到 `__test`（`:4485`）；
  **周期对齐**由求值 effect 的依赖数组固定（`:2838-2863`，依赖 `[appliedFormulas, current.symbol, tf, adjust, bars.length]`，
  且在**整个缓冲区**上求一次再按窗口切片——与 D18 的窗口模型一致）
- **测试**：client 从 43 项增至 65 项（历史数字，当时新增 22 项，含 9 项主图/副图分类的纯函数测试；当前值见第五节）

### T5.6 「指标公式」tab ✅（已完成）
- 公式列表（名字 / 归属标的 / 输出线 / 解析状态 / 未来函数与绘图指令告警）
- **界面内粘贴导入**：填名字 + 粘贴源码 → 导入并解析 → 成功则自动叠加到图上
- 「画到图上 / 已启用」开关；**已启用清单跨会话记住**（`localStorage`）
- 解析失败逐条列出错误；含未来函数的公式**说明原因与危害**（会重画历史、虚假高胜率），并指出"确实只想看图时的做法"
- **2026-10-27 复核（代码依据，确认"已完成"）**：tab 在底部 tab 列表里（`src/client.js:3544`：
  `['formula','指标公式']`），面板实现自 `:4139` 起；「已启用清单」用 `useLocal('stock-lab:appliedFormulas', [])`
  （`:2783`）**跨会话记住**；界面内粘贴导入调 `/formula/import`（`:2879`）；解析失败逐条列出、未来函数单独说明原因
- 当前标的的计算结果摘要（线数、区间、信号命中次数与最近命中日）

### T5.7 选股 ✅（2026-10-29 完成）

> 用户选的三件（主图 + 副图 + 选股）全部做完，Phase 5 闭环完成。

- **Goal**：把一条条件公式在标的池上批量求值，返回命中的标的
- **Files**：`src/services/screen-service/index.js`（引擎）、`src/datasource/eastmoney.js`（`getStockUniverse`）、
  `src/services/market-service/index.js`（标的池 + 本地库只读接口）、`src/index.js`（5 条路由）、
  `src/tools/formula-tools.js`（`screen_formula` 工具）、`src/client.js`（「指标公式」tab 内的选股面板）
- **开工前耗时评估（实测，500 根/标的）**：读盘 3.0 ms（冷）/ 0.4 ms（热）；求值 0.10–0.41 ms；
  **全链路 0.7–0.9 ms/标的 → 5,000 只约 4 秒**。结论：不需要重型任务队列，但必须分批 + 可取消
- **已实现**：
  - **标的池**：`local`（本地库已落库）/ `watchlist`（自选，客户端传 symbols）/ `market`（东财全 A 股 **5,563 只**，
    只评估本地有数据的）。缺数据**单独计数**并写进 `universe.note`，不静默跳过
  - **分批 + 让出事件循环**：每批 40 个后 `setImmediate`；进度可轮询、任务可取消（`/formula/screen/cancel`）
  - **结果缓存**：公式 + 参数 + 数据版本（文件大小+mtime 指纹）相同 → 复用；数据一变自动失效（`cached: true`）
  - **安全判定**：复用 `signalsFrom`——最后一条输出线必须是 0/1，指标公式直接失败并说明原因
  - **界面**：公式行「选股」→ 选池（本地/自选/全市场）+「只看最新一根」→ 进度条 + 停止 → 结果表
    （代码/名称/命中次数/最近命中日/收盘/涨跌）→ 点行切标的；缺数据与免责声明常驻
  - **AI 工具**：`screen_formula`（工具总数 30 → **31**）
- **Acceptance**：裸跑 `collector.py status` 有数据的标的都能被选出；缺数据数量必须如实显示；
  任务中途可取消且不留半成品；同一公式重复跑第二次命中 `cached`
- **测试**：`tests/screen-service.test.mjs` **11 项**（命中/未命中/缺数据、latestOnly、非条件公式拒绝、未来函数拒绝、
  缓存、取消、全市场池、自选池、空池、状态字段）；`tests/smoke-screen.mjs` **9 项真实冒烟**（真东财 5,563 只 + 真本地库）
- **Deps**：T5.2/T5.3（求值器与未来函数检测）、T2.1（本地库）、T2.2b（本地库接入 MarketService）

---

## Phase 6 — 右栏 Chat（新增，当前主线）

### T6.1 Chat 数据层 ✅（已完成）
- `src/services/chat-service/chat-store.js`（SQLite）：线程 + 消息
- **对话保存过程，笔记保存结论**：原始消息全存（用户要能回看"上个月到底怎么想的"），
  「喂给模型多少」是装配问题（T7.2），与存储分开——混在一起会要么丢历史、要么上下文爆炸
- 线程按标的组织 + 一条 `global` 研究主线（跨标的的问题不归属任何标的）
- 消息带 `toolCalls` / `meta` 结构化载荷；线程有 `summary` + `summarizedUpTo` 为 T7.2 预留
- 线程可关联 Research Note（`noteIds`）→ 回溯当时判断的入口
- **测试**：26 项（历史数字；当前 `tests/chat-store.test.mjs` 为 **32 项**）

### T6.2 LLM 桥 + 工具循环 ✅（已完成）
- `src/services/chat-service/llm-loop.js`：多轮工具循环，**依赖全部注入**，可完全离线测试
  - 分片参数按 `index` 拼接（缺 id/name 的半成品丢弃）
  - 非法 JSON 参数如实回灌让模型自己修（不猜）
  - 工具抛错 → 变成错误结果回灌，**不中断对话**
  - 轮次上限（默认 6）到顶给出可执行建议
  - 错误 / 中断 / 取消 / 事件回调异常 全部有明确处理
- `src/services/chat-service/index.js`：ChatService
  - **工具白名单**：只暴露本插件自有的 **31 个工具**（`src/tools/` 六个模块注册：index 9 + research 4 +
    watch 5 + quant 3 + formula 7 + **drawing 3**；公式 6→7 是加入了选股工具 `screen_formula`）。`ctx.tools.schemas()` 会把 agent 自有的
    read/write/bash 一并带出去——那些绝不该出现在聊天面板里
  - 系统提示词 = skill.md + 当前标的 + 面板硬约束（数字只能来自工具、不得改写统计量、
    区分事实与推断、不替用户下结论、附免责声明）
  - **给模型的工具结果截断（6000 字符），但存档保留完整内容**，并标注 `truncatedForModel`
  - **工具结果在发生的当下落库**（不是等整轮结束补写），否则回看顺序变成
    「答案 → 它用过的工具」，读起来是错的
- 9 条路由：`/chat/{info,threads,messages,send,cancel,run,delete-thread,ask,stream}`
  - `/chat/stream` 用 SSE 逐字推送；为此新增 `rawRoute`（原始 req/res 注册方式）
- **测试**：llm-loop 31 项 + chat-service 23 项（历史数字；当前分别为 **31 / 30 项**，另有 `chat-persistence.test.mjs` **16 项**）+ 真实链路冒烟 12 项

### T6.2 实测结论（打真实 LLM）✅
- 消息形状按 **DSH 类型声明**（`role:'tool'` + 顶层 `toolCallId`）**被 provider 接受**，
  不必退回 dsh-astock 的 `role:'user'` + `tool-result` 块写法（两条路都做成可替换，但不必切换）
- 端到端：问"茅台现在多少钱" → 模型调 `stock_quote` → 回灌 → 答「1335.00 元，+1.25%」，
  **自动带上数据来源、时间戳与免责声明**（skill 提示词生效）
- **多轮记忆生效**：第二轮问"刚才那只股票代码是什么"，模型**不再调工具**、直接从历史答出 600519
- 落库顺序正确：`user → tool → assistant`

### T6.3 右栏 Chat UI ✅（已完成）
- 右栏 = **当前标的会话的视图**：切标的自动切会话；没聊过就显示空状态（含 4 个可点击示例问题），
  **不预建**（懒创建）
- **SSE 逐字显示**（`makeSseParser` 缓冲切帧，能处理任意网络分包）
- **工具调用单独成块**：调了什么、参数、成功/失败、可展开看完整返回
- **停止按钮** → `/chat/cancel` + 本地中断；实测取消会被 provider 尊重（`模型调用被中断`）
- **切标的时不打断正在进行的回答**：它属于上一个标的，服务端照样落库，切回去能看到；
  界面如实提示"「SH600036」的回答仍在后台进行"
- 完成时**先载入权威内容再清流式临时文本**（顺序反了会让答案闪一下消失）
- 免责声明**常驻**在输入区下方（不是每条消息重复）；状态行如实显示驱动模型与可用工具数
- 清空记录需二次确认
- **测试**：client 74 → 97 项（历史数字，当时为 SSE 帧解析 12 项 + UI 契约 11 项；当前 client.test.mjs 为 **316 项**）；真实冒烟 `smoke-chat-ui.mjs` 15 项

### T6.4 与工作台状态联动 🟡（部分完成）
- 已完成：切换标的自动切换会话（右栏读的是当前标的的线程）
- 待做：把"当前标的事实底座"（K 线统计/异常）**预置进提示词**，减少首轮工具调用

### T6.5 二层的真实会话（工作区里可见）⬜
- 已完成**可行性实测**，结论见 ARCHITECTURE §12「与 DSH 真实工作区/会话的关系」
  - ✅ 插件能创建持久工作区与持久会话（`workspaceRegistry.create` + `agentLoop.create({cwd})`）
  - ✅ 会话活过插件重装（需 `agentLoop.resume` 拿回句柄）
  - ✅ `append('user/message', …, {surfaceOp:'append'})` 写入后**进入持久 projection**（界面读的就是它）
  - ❌ **运行期新建的会话不会立即出现在工作区列表**（索引启动时构建）→ 要等 DSH 重启
- ⬜ **当前接线状态（2026-10-27 实测，必须如实记录）**：
  `src/services/chat-service/session-map.js` 已把"标的 → 真实 DSH 会话"的**确定性映射**写好
  （`sessionIdForSymbol` / `symbolFromSessionId` / `isStockLabSession`），但**全仓 grep `session-map`
  只有 `tests/chat-persistence.test.mjs` 引用它，`src/` 下没有任何模块 import** ——
  即这条二层通道**只有映射函数 + 测试，尚未接线**（没有 `agentLoop.create` / `resume` / `append` 的调用点）。
  所以「某个标的 → 真实 DSH 会话」**属未实施**；上面的 ✅ 只是可行性实测结论，不等于已落地。
- 待做：把"某个标的的对话"落成真实会话（懒创建：首次发言才建）；`resume` 复用；`append` 同步；
  并将 `session-map.js` 接进 ChatService（当前它是**未被引用的模块**，容易误读为"已完成"）
- **限制必须写进 UI**：新建的真实会话要等 DSH 重启才在工作区列出，不能承诺"立刻可见"

---

## Phase 7 — 按标的的对话线程（🟡 1/3：T7.1 ✅，T7.2 / T7.3 ⬜）

### T7.1 线程与标的绑定 ✅
- **Goal**：每个标的（股票/ETF/指数）一条线程；另有「全局」线程处理跨标的问题
- **Acceptance**：切换标的 → 进入对应线程；线程列表可按最近活跃排序
- **Deps**：T6.1

### T7.2 摘要与上下文装配
- **Goal**：上下文 = 线程摘要 + 最近 N 轮；摘要由代码裁剪生成，不无限增长
- **Acceptance**：给定一条 100 轮的长线程，装配出的上下文不超过设定预算；老轮次被摘要替代且摘要可回看
- **Deps**：T7.1

### T7.3 线程 ↔ 研究笔记联动
- **Goal**：线程里可一键把当前判断存为 Research Note；线程页列出该标的的全部笔记与复盘状态
- **Acceptance**：线程中标注了假设的轮次可跳转到对应笔记；笔记列表显示"上次复盘结论"
- **Deps**：T7.2、现有 research-service

---

## Phase 8 — 看盘体验（D18 K 线交互 + D19 图表画线，2026-10-25 ~ 10-27）✅

> 依据用户决策：这个平台是**替代证券软件**的（证券软件的短板正是没有 AI），所以 K 线的操作习惯按证券软件来。
> 两条决策的完整设计说明在 ARCHITECTURE **§9.3（D18）** 与 **§9.4（D19）**；本节只记「做了什么 / 在哪 / 怎么验收」。

### T8.1 K 线可视窗口与交互 ✅（已完成，决策 D18）

- **Goal**：把"选根数看最新 N 根"换成**一张缓冲区 + 一个可视窗口**——缩放/平移只改窗口，不重新取数、不重算指标，滚轮与按键即时生效
- **Input**：T1.4 的手写 SVG K 线组件 + Host 的 `/kline` 路由
- **Output**：可视窗口模型（含"跟随最新"哨兵）、键鼠操作、点根钉住读数、横向框选放大、数据起点提示
- **Files**：`src/client.js`（本项唯一改动文件）
- **已实现（每条都可指到代码）**：
  - **缓冲区 `BARS_BUFFER = 800`**（`src/client.js:183`），与 `/kline` 的 count 上限一致（`:2928` 按它取数）
  - **可视窗口 `{count, end}`**：`CHART_VIEW`（`:339`）/ `clampView`（`:353`）/ `sliceRange`（`:381`）/ `zoomView`（`:399`）/ `panView`（`:415`）/ `jumpView`（`:422`），全部为纯函数、可离线测试
  - **`end < 0` = "跟随最新"哨兵**（`resolveView`，`:374-378`）：新交易日进来后画面不会停在旧位置
  - **指标在缓冲区上算、按窗口切片**（`sliceSeries`，`:388-391`）：只按窗口算会让左边缘的 MA 变成空值
  - **`CHART_GEO` 共用一份几何**（`:189`）：图表与交互层不各写一份，容器宽度变化也不会算偏
  - **滚轮以指针所在那根为锚**（`:1909` 传入 anchor、`:1922` 由指针反算下标）：鼠标指哪根，哪根不动
  - **键盘**：↑↓ 缩放 / ←→ 平移 / PageUp·PageDown 半屏翻页 / Home·End 到最早·最新（`:2102-2114`，可读提示见 `:2124`）
  - **"根数预设 60/120/250/500" 已移除**：原因与替代方案写在 `:174-177`，UI 侧说明见 `:3358`；缩放级别改由 `localStorage['stock-lab:chartCount']` 记住（`:346`）
  - **点某根 K 线钉住读数**（点选 `:3182`、放大模式的 `'pickbar'` `:2059`）：显示 开/高/低/收/量 + 相对前一根涨跌幅（`:3395-3407`），并在图上画竖线标出（`:2734-2737`）
  - **不选任何工具时拖动 = 按横向范围框选放大**（`:1945`、`:3204-3212`；价格轴自动定、纵向不参与）；它与「选择」模式的框选多选**必须分开**，理由见 ARCHITECTURE §9.14
  - **已到数据起点时明确提示**（`:3444-3446`：`已到数据起点（共 N 根，最早 <日期>）`）
  - **测试**：窗口纯函数与交互契约在 `tests/client.test.mjs`（当前 **316 项**）
- **历史深度（上游实测约束，详见 ARCHITECTURE §9.3）**：腾讯日线上限约 **800 根（≈3.2 年）**——我们的 800 与它一致，**不是我们卡住的**；
  请求 1500 根反而只返回 **641 根**（**静默降级、不报错**）；3000 根报 `param error`。
  更深历史的可行路径（周/月线、本地库累积、另接数据源）**均未实施**。
- **Acceptance**：缩放/平移即时且不触发重新取数；缩放到最早一根时有明确提示；容器宽度变化后指针锚定与点根读数仍正确
- **Deps**：T1.4（K 线组件）、T5.5（指标叠加——指标须在缓冲区上算）

### T8.2 图表画线 ✅（已完成，决策 D19）

- **Goal**：把"表达一个判断"落到图上——一条线可挂 `reason`（为什么画在这里），**人画的与 AI 画的都行**
- **Input**：T8.1 的可视窗口 + `CHART_GEO` 几何
- **Output**：4 种图形 + 吸附/预览/撤销/多选删除/写说明/测幅 + 落盘 + 3 个 AI 工具 + 4 条路由
- **Files**：`src/services/drawing-service/drawing-store.js`、`src/tools/drawing-tools.js`、`src/client.js`（绘制与交互）、`src/data-root.js`、`src/index.js`（路由）
- **已实现（每条都可指到代码）**：
  - **四种工具** `hline / trend / circle / marker`（`drawing-store.js:36` 的 `DRAWING_TYPES`；客户端 `src/client.js:52-56` 的 `DRAW_TOOLS`）
  - **趋势线默认射线**，可切 线段/直线（`drawing-store.js:48-49`：`LINE_EXT` + `DEFAULT_EXT='ray'`；`client.js:461` `extendLine` 做 slab 裁剪）
  - **圆 = 圆心 + 圆上一点**（`ANCHORS_REQUIRED` `drawing-store.js:39`；半径由两点在数据空间的位置决定，缩放时屏幕大小会随之变——这是数据空间锚定的必然结果）
  - **锚点 x 锚日期、y 锚价格，并记录画线时的 `adjust`**；不一致时**画虚线 + 提示**（`client.js` 的 `DRAW_ISSUE.ADJUST` `:433`、虚线渲染 `:2528`；`resolveDrawings` `:576` 用 `indexOfDate` `:443` 解析回下标）
  - **吸附到最近一根 K 线的 开/高/低/收**（`snapAnchor` `client.js:229`，四个价位都在候选内 `:238-246`——曾漏掉 `open`，表现为"一根 K 线只能吸 3 个点"）
  - **颜色存色名而非色值**（`drawing-store.js:58` `DRAWING_COLORS`；非法色名/色值明确拒绝 `:105-110`；客户端再映射到主题 token）
  - **幽灵提示（按下前）+ 预览线（按下后）**（`ghostFromPoint` `client.js:496`、`draftFromPoint` `:489`、渲染 `:2523-2558`）
  - **Ctrl+Z 撤销**（撤销栈 `client.js:2802`、`undoDrawing` `:3118`；"焦点被 `preventDefault` 干掉"的坑见 ARCHITECTURE §9.5）
  - **框选多选 + Delete 批量删除**（`onMarqueeDone` `:3196-3200`、Delete 分支 `:2091-2093`）
  - **选中后可写 label 与 reason**（编辑区 `:3463-3492`；`applySelect` `:3223`）
  - **测幅**（涨跌幅 / 价差 / 相隔根数，**临时显示、不落库**）：`resolveMeasure` `:556`、渲染 `:2619`；"锚下标会漂"的教训见 ARCHITECTURE §9.18
  - **存储 `数据根目录/drawings/<标的>.json`**（`drawing-store.js:5`、`data-root.js:94` 的 `drawingsDir()`）；文件损坏或条目非法时**如实报错、不静默修正**（`list()` `:137-159`）
  - **AI 可画线并带 `reason`**：`save_drawing` / `list_drawings` / `delete_drawing`（`drawing-tools.js:32 / :107 / :133`；工具描述里写明锚点必须来自真实数据、必须记 `adjust`）
  - **4 条路由**：`/drawings`、`/drawings/stats`、`/drawings/add`、`/drawings/remove`（`src/index.js:452-468`）
  - **测试**：`tests/drawing-store.test.mjs` **30 项**（含 §9.19 的 `data-root` 回归）
- **Acceptance**：换复权模式或缩放平移后，已画的线仍锚在同一天同一价位（锚日期、不锚下标）；复权不一致时虚线并说明原因；AI 画的线可被 `list_drawings` 读回且带 `reason`
- **Deps**：T8.1（窗口与 `CHART_GEO`）

---

# 四、冻结与推迟

### 🧊 冻结：Phase 3 量化扩展 + Phase 5 高级研究

量化验证（Event Study + Quant UI）**保留可用但不再扩展**。以下不再排期：

- 回归 / 因子测试 / 简单回测 / walk-forward
- 股票状态向量 X_t 持久化、regime detection、ML、PCA / 聚类
- 组合分析、风险暴露、多股票联动

**始终不做**：自动下单 / 实盘执行。

### ⏸ 推迟

- 事件时间线（公告 / 财报 / 除权）
- snapshot 接入 pytdx / Tushare

---

# 五、依赖、进度与验证记录

## 依赖总图

```text
已完成（Phase 0–4）：
T0.1 → T0.2 → T1.1 → T1.2 → T1.3 → T1.4 → T1.5
                    └──→ T2.1(落库) → T2.2b(本地库入MarketService) → T2.4b(snapshot 长窗口)
                    └──→ T2.5(Research Notebook) → T2.5b(UI)
                    └──→ T2.3(行业维度)
                    └──→ T3.1(Event Study) → T3.3(Quant UI)
                    └──→ T4.1–T4.4(Watch Engine) → T4.5(digest/提醒通道)

当前主线（Phase 5–8）：
T6.0(布局骨架 + 可调宽右栏) ✅
        ├──→ T5.1(词法/语法) ✅ → T5.2(求值器) ✅ → T5.3(未来函数检测) ✅ → T5.4(导入通道) ✅
        │                                              └──→ T5.5(主图+副图) ✅ → T5.6(指标公式 tab) ✅
        │                                                                          └──→ T5.7(选股) ✅
        └──→ T6.1(Chat 数据层) ✅ → T6.2(LLM 桥+工具循环) ✅ → T6.3(右栏 Chat UI) ✅ → T6.4(状态联动) 🟡
                                                              └──→ T6.5(真实会话/工作区可见) ⬜（映射函数已写，但 `src/` 无任何引用 → **未接线**）
                                                              └──→ T7.1(线程绑定标的) ✅ → T7.2(摘要/上下文装配) ⬜ → T7.3(线程↔笔记) ⬜

看盘体验（Phase 8，2026-10-25 ~ 10-27）：
T1.4(K线组件) ✅ ──→ T8.1(K 线可视窗口与交互) ✅ ──→ T8.2(图表画线) ✅
                     （D18：缓冲区 800 + 窗口 {count,end}）   （D19：4 种图形 + 吸附/撤销/测幅 + AI 可画）
```

已定决策（详见 ARCHITECTURE §15）：**D15 懒创建**（读路径绝不建线程/会话，只有真的发言才建）、
**D16 两层对话**（右栏即时问答 + 工作区可见的真实会话）、
**D18 K 线交互**（缓冲区 + 可视窗口，见 §9.3）、**D19 图表画线**（见 §9.4）。

## 当前状态

- [x] PLUGIN_REVIEW.md v1.0（源码版，2026-10-23；waste-market 因代码混淆排除，主 fork = dsh-astock）
- [x] ARCHITECTURE.md v0.1
- [x] ROADMAP.md v0.1 → **v0.4**（2026-10-27：新增 Phase 8、补 T6.5 未接线状态、按复跑数字更新验证记录）
- [x] T0.1 源码获取 ✅（用户手动提供五仓库）
- [x] T0.2 源码级评审 ✅（13 维度结论见 PLUGIN_REVIEW §1–§5）
- [~] T0.3 基线安装 —**跳过**（直接用自建骨架验证真实数据，见下）
- [x] **T1.1 插件骨架** ✅ `dsh-stock-lab/`（package.json + cordis.patch.yml + 完整 src 目录结构）
- [x] **T1.2 MarketService + 数据源适配器** ✅
  - symbol 规范化（沪/深/北/指数/ETF）19 项单测通过
  - 腾讯适配器：行情/K线/分时/搜索，**真实接口验证通过**
  - 新浪备源：日线 fallback
  - 东财适配器：涨跌家数/资金流/财务/公司概况/新闻，**真实接口验证通过**
  - TTL 缓存 + single-flight 4 项单测通过
  - 修复 4 个真实数据源 bug（见 README「已知的数据源坑」）
- [x] **T1.5（提前完成部分）AI Tools + Context** ✅
  - 8 个 Tools（含核心 `stock_research_snapshot`）9 项单测通过（当时值；现为 **31 个工具**、`tools.test.mjs` **11 项**）
  - StockContext provider
  - stock-lab skill（合规红线 + 研究方法论）
  - Host 入口 + 10 条 HTTP 路由 16 项契约测试通过（当时值；现为 **61 条路由**、`host.test.mjs` **25 项**）
  - 架构铁律自动校验（只有 market-service 可 import datasource）
- [x] **T1.3 工作台页面** ✅
  - `src/client.js`（484 行，当时值；现为 **4,495 行含空行 / 4,279 非空行**）：顶部指数栏、左侧自选股+搜索、K线（手写 SVG 蜡烛 + 成交量副图 + MA20）、行情明细、底部 新闻/财务/资金流 tabs
  - slot 注册：`main[key=stock-lab]` + `sidebar.panellist[id=stock-lab, order=70]`
  - 自选股与最后查看持久化（localStorage）
  - UI 状态自动上报 `/stock-lab/context`（Context-aware AI）
  - **已在真实 DSH GUI 中验证**：两个 slot 均 `active: true`
- [x] **T1.4 K线组件** ✅（手写 SVG，无第三方图表依赖；日/周/月 × 前/后/不复权 × **可视窗口（缓冲区 800 根）**，逐根十字读数）
  - 说明：原来的"根数预设 60/120/250/500"已被 **T8.1（D18）移除**——固定档位没有向左平移的能力
    （原因见 `src/client.js:174-181`，UI 文案见 `:3358-3359`，缓冲区常量 `BARS_BUFFER = 800` 见 `:183`）
- [x] **安装到 profile 并 GUI 验证** ✅ `application: applied`
  - 6 条数据路由实测返回 ok
  - `main[key=stock-lab]` 与 `sidebar.panellist[id=stock-lab]` 均 `active: true`
- [x] **AI Tools 真实调用验证** ✅（2026-10-23 本轮修复后）
  - 修补关键缺陷：插件 `inject` 缺 `tools`/`skills`，导致 8 个 AI Tools 此前**静默未注册**
  - 修复后 `Tool.listTools` 可见全部 8 个 `stock_*`（2026-10-23 当时值；现为 **31 个工具**，见 T6.2）；skill 目录出现 `stock-lab`
  - `stock_research_snapshot(600519)` 真实返回：价 1335、涨 1.25%、成交额 76.77 亿、换手 0.46%、PE 20.49、PB 6.64、总市值 16689 亿、20 日超额 +13.33pp、主力净流入 2.83 亿、2026H1 营收 922.8 亿、**2 条代码判定异常**（量能 2.93σ、相对强度）

- [x] **侧栏显示名改为「看盘助手」** ✅（2026-10-25）
  - 用户可见名由「股票研究」改为**「看盘助手」**：`src/client.js:4467` 的 `sidebar.panellist` slot `label: '看盘助手'`
  - **内部标识保持不变**（仍 `dsh-stock-lab` / `stock-lab`）——注释写在 `src/client.js:4465-4466`：改内部标识会波及
    路由（`/stock-lab/*`）、`localStorage` 键（`stock-lab:*`）与数据目录，换不来体验，反而可能丢数据
  - 回归测试：`tests/client.test.mjs` 断言 `label: '看盘助手'` 存在、`label: '股票研究'` 不存在
- [x] **D18 K 线交互 / D19 图表画线** ✅（2026-10-25 ~ 10-27，任务见第三节 **Phase 8**；设计说明见 ARCHITECTURE §9.3 / §9.4）
- [x] **本仓库首次纳入 git** ✅（2026-10-27）：首提交 `84364bd` 为现状快照，随后一笔为文档对齐
  （本次任务只改 `ROADMAP.md` 与 `ARCHITECTURE.md`；提交与推送由 Lead 负责）

- [x] **数据根目录解析修复：空库不再顶掉真库** ✅（2026-10-28）
  - 触发：校验时发现 `$DSH_HOME/stock-lab/data` 被**只读命令**建出了空 `meta.db`（schema 在、0 行），
    而旧判据只看"`meta.db` / `bars/` 是否存在"，于是这个空目录把包内 `data/`（5 标的 / 2,104 行）顶掉——
    症状是 `status` 报"尚无落库数据"、界面本地 K 线为空、**画线全部消失**（`drawings/` 跟着根目录走）
  - 修复三项：① "有数据"改判「`bars/<symbol>/` 下至少一个 `*.csv.gz` / `*.parquet`」；
    ② 只读路径不再建目录（`bars_path(create=False)`、`list_bars_meta()` 无库即返回 `[]`）；
    ③ Python `_home()` 补「包内 `data/`」兜底，与 Node `resolveDataRoot()` **完全同构**（此前 Python 少一档，命令行与运行期分叉）
  - 验收：裸跑 `python backend/collectors/collector.py status` → **5 标的 / 2,104 行**（修复前报"尚无落库数据"）；
    Node `resolveDataRoot()` 回到包内 `data/`；只读命令不再在 `$DSH_HOME` 下创建任何目录
  - 测试：JS 717 → **721**（local-storage 21 → 25，含空库/真库/缓存/跨语言同构）；
    Python 10 → **18**（解析优先级 / 空库不算数据 / 只读不建目录 / 0 字节库）
  - 设计记录：ARCHITECTURE §4 与 **§9.20**；踩坑记录见插件 README「已知的本地数据层坑」

- [ ] **下一步**：Phase 1 收尾——AI Chat 联动验证（在对话中问当前股票）、Phase 2 历史落库

---

## Phase 2 / Phase 3 进度（进行中）

### Phase 2 — AI Research

- [x] **T2.1 历史数据落库** ✅（2026-10-23 完成）
  - `backend/storage/storage.py`：抽象存储层，**有 pyarrow 用 Parquet、否则自动回退 csv.gz**，调用方无感
  - 分区布局 `data/bars/<symbol>/<tf>_<adjust>.<ext>` + SQLite 元信息库 `data/meta.db`
  - 增量合并（按 time 去重）、日期区间查询、`data_version()` 数据指纹（满足可复现原则）
  - `backend/collectors/collector.py`：**经 MarketService 的 HTTP 路由取数**（遵守架构铁律：Python 不自己直连行情源）
  - 实测：5 个标的、共 1904 行落库（2024-09 ~ 2026-10）
  - 踩坑：DSH 沙箱不允许在 `~/.dsh` 下新建顶层目录 → 支持 `DSH_STOCK_LAB_DATA` 重定向（默认指向包内 `data/`）
  - 测试：10 项（存储层）
- [x] **T2.5 Research Notebook** ✅（2026-10-23 完成）
  - `src/services/research-service/research-store.js`：SQLite 索引（`node:sqlite` 内置，零依赖）+ markdown 落盘
  - 数据落 `$DSH_HOME/stock-lab/research/{index.db, notes/<id>.md}`
  - 字段：观察 / 假设 / 证据 / 反证 / 预测 / 置信度 / 复盘日 / 数据版本 / 基准 / 来源 / 状态
  - 台账能力：创建、按股票/状态/到期筛选、到期待复盘列表、复盘（correct/partially/wrong/void）、统计、删除、重启后持久
  - 4 个 AI Tools：`save_research_note`、`list_research_notes`、`review_research_note`、`research_notebook_stats`
  - 7 条 HTTP 路由：`/research/{list,due,stats,get,create,review,delete}`
  - **端到端实测**：保存宁德时代一条完整假设 → markdown 正确落盘（1774 字节，含全部章节与免责声明）→ 列表/统计查询正常 → 未到期的不出现在 due 列表
  - 测试：18 项（存储层）+ 11 项（工具层）
- [ ] **T2.1 历史落库（Python sidecar + Parquet）** ← 需要 Python 环境与 Tushare token
- [ ] **T2.2 相对强弱引擎落库**
- [x] **T2.3 行业板块维度** ✅（2026-10-23 本轮完成，原 T2.4 的一部分）
  - 东财板块数据源：`getSectorList`（行业/概念/地域，496 个板块）、`getSectorQuote`、`getSectorMembers`、`getStockSector`（行业名反查板块代码）
  - MarketService 四个方法 + 缓存（15s/10s）
  - 新 AI Tool `sector_overview`：支持「查涨幅榜」「查指定板块」「查个股所属行业」三种用法
  - `stock_research_snapshot` 的 `sector` 字段补全：板块代码/涨跌/主力净流入/成分股家数/涨跌家数/中位涨幅/**个股 vs 板块当日超额**
  - 新增异常类型 `sectorRelative`（当日跑赢/跑输板块 ≥3pp）
  - 4 条 HTTP 路由：`/sectors`、`/sector`、`/sector/members`、`/stock-sector`
  - 实测：茅台 → 白酒Ⅱ(BK1277) +2.53%，20 只成分股 19 涨 0 跌，中位 +2.37%；金徽酒 +6.59% 领涨
  - 踩坑记录：东财对**板块指数**的 f104/f105/f106 返回 0/0/100（是板块自身涨跌平状态，不是成分股家数），已改为从成分股统计
- [x] **T2.5 Research Notebook UI** ✅（2026-10-23 本轮完成）
  - 工作台底部新增「研究笔记」tab：统计条、新建表单、笔记列表、内联复盘
  - 新建表单字段：观察 / 假设 / 证据（逐行）/ 反证（逐行，标注"必须尽力找"）/ 预测 / 置信度 / 复盘日
  - 内联复盘：四档结论按钮（完全正确/部分正确/判断错误/作废）+ 复盘正文
  - 底部同时新增「所属行业」tab：板块行情 + 成分股涨跌榜（判断个股是行业普跌还是独立行情）
- [x] **T2.2b 本地库接入 MarketService（数据可靠性）** ✅（2026-10-23 完成）
  - `src/data-root.js`：数据根目录解析（Node 侧）；**Python 侧 `storage.py._home()` 与它完全同构**，由跨语言契约测试守住（此前读写两方各按不同顺序回退，存在「写进 A / 读 B」的真实缺陷；2026-10-28 又修了"空库顶掉真库"，见当前状态）
  - `src/datasource/local.js`：Node 原生直读本地库（`node:zlib` 解 csv.gz、`node:sqlite` 读 meta.db），**不需要 Python 子进程**
  - 按列名取值（列顺序无关）、空值归一为 null、损坏文件返回 null 而不崩溃
  - `MarketService.getKline` 支持来源路由：`auto`（本地优先）/ `local`（只用本地，可复现）/ `live`
  - 新增 `getKlineInfo()` 返回 `provenance`（数据源、上游来源、采集时间、数据版本指纹、是否可复现）
  - `stock_kline` 增加 `source` 参数并返回溯源；`stock_relative_strength` 窗口 **80 → 500 根（两年）**，双端溯源
  - `save_research_note` **自动写入 dataVersion**：本地有该标的填实际指纹，没有则如实写「未落库，无法精确复现」
  - 新增路由 `/local/status`（含候选目录与解析结果）、`/local/version`
  - **跨语言契约测试**（`tests/local-storage.test.mjs`，20 项）：让 Python 真的写一次，Node 读回逐项比对；并比对两侧解析出的目录一致
- [x] **T2.4b snapshot 接入本地历史** ✅（2026-10-23 完成）
  - `stock_research_snapshot` 的 K 线窗口 **120 → 500 根（约两年）**，本地库有数据时自动优先
  - 新增字段：`return120d`、`realized60d`、`relativePerformance.d120`、数据区间 `rangeStart/rangeEnd`、`meta.barsUsed`
  - `meta.provenance` 同时给出个股与基准的溯源（数据源 / 数据版本指纹 / 是否可复现）
  - 实测（宁德时代）：500 根、120 日超额 **-32.51pp**、波动率较前一期放大 91%、当日跑赢电池板块 4.23pp，共检出 **5 条异常**
- [ ] T2.3b 新闻/公告事件时间线

### Phase 3 — Quant Lab（🧊 已冻结：保留可用，不再扩展）

- [x] **T3.1 quant-bridge + Event Study** ✅（2026-10-23 完成）
  - `src/services/quant-bridge/index.js`：Node → Python 子进程桥（参数校验 + 结果透传 + 超时 + 可读报错 + spawn 同步异常兜底）
  - `backend/quant/event_study.py`：5 种内置条件、样本量/平均与中位超额/t 统计量/胜率/显著性、**强制因果免责**
  - 无未来函数：事件判定只用当日及之前数据，末尾 horizon 根不作为事件（有测试守着）
  - 3 个 AI Tools：`run_event_study`、`collect_history`、`local_data_status`
  - 4 条路由：`/quant/event-study`、`/quant/collect`、`/quant/status`、`/quant/python`（含解释器诊断）
  - **端到端实测**：茅台放量后 5 日 → 52 样本、平均超额 +0.59%、中位 -0.81%、t=0.96、胜率 44.2%、不显著
  - Python 解释器探测：宿主进程里 `DSH_HOME` 未设置且 PATH 无 python，靠 `~/.dsh` 回退找到（已加诊断路由）
  - 测试：9 项（事件研究）+ 4 项（桥）
- [ ] T3.2 回归 / 因子测试 / 简单回测 / walk-forward
- [x] **T3.3 Quant 页面（UI）** ✅（2026-10-23 完成）
  - 工作台新增「量化验证」tab
  - 条件选择（5 种，与后端 CONDITIONS 一致，有测试锁定一致性）
  - 参数编辑器（按条件动态显示 n / mult / pct / fast / slow）+ 观察天数
  - 结果展示：**样本量、平均与中位超额、标准差、t 统计量、胜率、最好/最差** + 显著性徽标
  - 强制展示 4 条因果免责
  - 缺数据时给出「采集历史数据」按钮；缺 Python 时给出探测顺序说明与重检按钮
  - **一键存为研究笔记**：观察与证据自动填入，假设与预测留白（"那是研究者的工作"），完成「验证 → 记录」闭环
  - 实测：UI 同款请求格式（查询串 + JSON 参数）→ 52 样本、t=0.964、不显著；存笔记链路 HTTP 200 且 UTF-8 正确

---

## Phase 4 — Intelligent Watch（进行中）

- [x] **T4.1 规则引擎** ✅（2026-10-23 完成）
  - `src/services/watch-service/watch-store.js`：规则 + 触发记录持久化（SQLite，含冷却字段与累计次数）
  - `src/services/watch-service/evaluator.js`：**9 种条件**的纯函数判定（价格/涨跌幅/量能/换手/波动/相对强弱/资金流/行业背离/假设到期），每种都返回判定依据 `metrics`
  - `src/services/watch-service/index.js`：按条件**按需**拉取上下文（只取该条件真正需要的，避免无谓请求）、冷却抑制、`dryRun` 预览、`onTrigger` 回调
  - 4 个 AI Tools：`create_watch_rule`、`list_watch_rules`、`evaluate_watch_rules`、`list_watch_triggers`
  - 8 条路由：`/watch/{kinds,rules,create,toggle,delete,evaluate,triggers,ack}`
  - **周期评估**：Host 每 5 分钟自动评估（`DSH_STOCK_LAB_WATCH_MINUTES`），**仅交易时段**运行；`timer` 不可用时降级并写日志
- [x] **T4.2 异常检测器** ✅（与 T4.1 合并实现：量能/波动/相对强弱/资金流/行业背离）
- [x] **T4.3 假设失效/复盘提醒** ✅ 与 Research Notebook 联动
  - `hypothesis_review_due` 条件：创建时必须关联存在的笔记（校验 noteId），自动取笔记的 symbol
  - 到复盘日触发时**把预测原文带进提醒**，引导对照实际走势判定
  - 创建时校验：笔记不存在 / 未传 noteId 都会明确报错
- [x] **T4.4 盯盘 UI** ✅
  - 「智能盯盘」tab：条件选择（9 种，与后端 WATCH_KINDS 一致性有测试锁定）、动态参数、方向/比较符
  - 「假设到复盘日」提供笔记下拉选择（无笔记时引导先去创建）
  - 记录「研究意图」字段（为什么设这条规则）
  - 规则列表：参数/关联笔记/启停/删除/触发次数/最近触发时间
  - 触发记录：严重度分级（重要/关注/提示）+ 依据数值 + 关联笔记引导 + 确认按钮
- [x] **T4.5 提醒通道** ✅（2026-10-23 完成）
  - **架构调研结论**：DSH 的插件作用域**无法向会话推送消息**（`session.announce` 只是变更信号；`agents.announce` 是会话启动事件）——这与 dsh-astock 记录的「插件不可执行宿主工具、不可达 agent 层」一致
  - 因此按架构允许的方式实现：插件产出「待看清单」，会话级提醒交给 DSH 自带调度器
  - 新增 `watch_digest` 工具：按严重度分组的简报，**每条带依据数值**，到期研究假设单列并要求复盘；返回 `counts` 与 `instruction`（要求 AI 带数值、引导复盘，而不是堆 JSON）
  - 新增 `/watch/pending` 路由：只回未确认触发 + 到期笔记 + 统计 + 是否交易时段
  - `skill.md` 写入「主动提醒的正确做法」：教 AI 在用户说「每天帮我盯着」时用 `schedule_create` 把提醒真正建起来（含交易日 15:30 的示例），而不是只说"你可以自己去看"
  - 实测：`watch_digest` 返回 2 条未确认触发（1 重要 1 提示），数值依据完整（-13.96pp / 1335）

### 已完成的可交付验证（**2026-10-27 复核**）

> 复跑环境：Node **v24.19.0**；Python **3.12.14**（DSH 运行时自带，路径 `~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/`，
> 探测顺序见 `src/services/quant-bridge/index.js:32-38`）。
> 17 套 `tests/*.test.mjs` 均为离线测试，各自把数据写进隔离目录（系统临时目录或项目内 `.test-data/`，两者都已排除在版本库外）。

```text
JS（node tests/<name>.test.mjs）：
  market-service.test.mjs      →  19 passed（symbol 规范化 + 缓存 + 适配器契约）
  tools.test.mjs               →  11 passed（AI Tools 契约）
  host.test.mjs                →  25 passed（契约 + 架构铁律 + 降级 + 选股路由可调用）
  client.test.mjs              → 316 passed（bundle 契约 + 渲染 + K线窗口/画线/公式（含选股面板）/量化/盯盘/笔记 UI）
  research.test.mjs            →  18 passed（研究库）
  research-tools.test.mjs      →  14 passed（研究工具）
  quant-bridge.test.mjs        →   7 passed（Node→Python 桥 + 真实执行）
  watch.test.mjs               →  39 passed（盯盘求值 + 存储 + 冷却 + digest）
  local-storage.test.mjs       →  25 passed（本地库读写 + 跨语言契约 + 数据根同构/空库回归）
  tdx.test.mjs                 →  61 passed（词法/语法/求值/未来函数）
  formula-store.test.mjs       →  43 passed（公式存储 + 导入通道）
  screen-service.test.mjs      →  11 passed（公式选股：命中/缺数据/取消/缓存/标的池 + 缓存随数据失效）
  llm-loop.test.mjs            →  31 passed（多轮工具循环）
  chat-store.test.mjs          →  32 passed（线程/消息存储）
  chat-service.test.mjs        →  30 passed（ChatService + 工具白名单）
  chat-persistence.test.mjs    →  16 passed（会话映射 + 落库顺序）
  drawing-store.test.mjs       →  30 passed（画线存储 + 锚点规范 + data-root 回归）
  ── 17 套小计 728
  validate-resources.mjs       →  13 passed（展示资源 + 清单一致性）
  ── JS 合计 **741**

Python（python backend/tests/<name>.py）：
  test_storage.py              →  18 passed
  test_event_study.py          →   9 passed
  ── 小计 27

合计 JS 741 + Python 27 = **768 项全通过**
```

**历史数字**：2026-10-23 的记录为「JS 189 + Python 19 = 208 项」；各任务条目里出现的
client 20 / 28 / 43 / 65 / 74 → 97 均为**当时的逐阶段演进值**（已在相应条目标注"历史数字"），
T6.1 / T6.2 条目里的 26 / 23 / 12 同理；
当前 `client.test.mjs` 单项已达 **316 项**。**未逐条标注的 T1/T2/T4 阶段单测数量也都是当时值**——
本节复跑数字是唯一当前口径。

> ⚠️ **可复现性注意事项：Python 缺失时总数会变小，而且不报错。**
> `quant-bridge` 与 `local-storage` 中共有 **6 个子测试需要真实 Python 解释器**（探测顺序见上）。
> 探测不到时它们**自动跳过、测试仍然全绿**，表现为 quant-bridge 4 项（真实 7）、local-storage 22 项（真实 25），
> 合计退化为 **735 项**（741 − 6）。因此引用"全通过"时必须同时给出运行环境与 Python 是否可用，
> 否则数字对不上——这也正是本轮从 712 修正为 736（后又增至 768）的原因。

**真实冒烟（需要网络 / 真实 GUI，单独跑，不并入上面的自动计数）**：
`smoke-live.mjs`（腾讯行情）、`smoke-live2.mjs`（东财）、`smoke-tdx.mjs`（公式真实链路）、
`smoke-screen.mjs`（公式选股：真东财 5,563 只标的池 + 真本地库，9 项检查；2026-10-29 实跑 9/9）、
`smoke-chat.mjs`（真实 LLM 会话）、`smoke-chat-ui.mjs`（右栏 UI，15 项）。历史记录见各自文件。

实测数据样例（2026-10-23 收盘后）：茅台 1335.00 (+1.25%)、沪深300 4105.33、两市成交额 19563 亿、涨跌家数 1853/437/67、茅台主力净流入 2.83 亿、PE 18.74、2026H1 营收 922.8 亿。
