# ROADMAP — DSH Stock Lab 分阶段任务路线图

> 版本 v0.3 · 2026-10-23
> 每个任务包含：Goal / Input / Output / Files / Acceptance（验收标准）/ Deps（依赖）。
> 阶段严格串行；完成验收后才进入下一阶段。
>
> **文档结构**：一、原始阶段计划（Phase 0–4，已完成） → 二、范围调整 → 三、当前主线（Phase 5–7） → 四、冻结与推迟 → 五、进度与验证记录

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

# 三、当前主线（Phase 5–7）

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
- **测试**：client 从 28 项增至 43 项（新增 15 项覆盖夹取边界与交互契约）

## Phase 5 — 通达信公式兼容（新增，当前主线）

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
- **已实现 40+ 函数**：`MA EMA SMA REF HHV LLV SUM STD CROSS COUNT EVERY EXIST IF IFF
  BARSLAST BARSSINCE BARSCOUNT MAX MIN ABS SQRT POW LOG EXP SIGN ROUND INTPART CEILING FLOOR` + 行情序列 `O H L C V VOL AMOUNT`
- **口径显式记录并有测试固定**：MA 前 N-1 根无效；EMA 首值取首根（alpha=2/(N+1)）；SMA 首值取 X；**STD 用总体标准差（÷N）**；CROSS 首根不可能为上穿
- **不静默近似**：口径未确认的平滑函数（MEMA/WMA/DMA/EXPMA）**不注册**，直接用会报"不支持"
- **稳健**：`REF` 越界为 null、除零为 null（不是 Infinity）、null 在逻辑上下文当 false

### T5.3 未来函数检测 ✅（已完成）
- `ZIG PEAK PEAKBARS TROUGH TROUGHBARS BACKSET REFDATE DYNAINFO FINANCE COST WINNER SELFDATA` 全部识别
- `analyze()` 返回 `requiresFutureOptIn`；`run()` **默认拒绝计算**，除非显式 `allowFutureFunctions`
- 绘图指令（`DRAWTEXT DRAWICON DRAWLINE STICKLINE POLYLINE` 等）单独列出为"已忽略"，不阻断输出线数值

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
- **测试**：client 从 43 项增至 65 项（新增 22 项，含 9 项主图/副图分类的纯函数测试）

### T5.6 「指标公式」tab ✅（已完成）
- 公式列表（名字 / 归属标的 / 输出线 / 解析状态 / 未来函数与绘图指令告警）
- **界面内粘贴导入**：填名字 + 粘贴源码 → 导入并解析 → 成功则自动叠加到图上
- 「画到图上 / 已启用」开关；**已启用清单跨会话记住**（`localStorage`）
- 解析失败逐条列出错误；含未来函数的公式**说明原因与危害**（会重画历史、虚假高胜率），并指出"确实只想看图时的做法"
- 当前标的的计算结果摘要（线数、区间、信号命中次数与最近命中日）

- [ ] **T5.7 选股**（用户选了"主图+副图+选股"，前两项已完成，此项待做）
  - 需要：全市场标的池（东财 clist 可取）+ 批量求值（本地库 5000 标的 × 500 根，须分批与缓存）+ 结果页
  - 信号提取接口已就绪（`signalsFrom`，含"非 0/1 条件线拒绝当信号"的安全判定）
  - **开工前需评估耗时**：全市场 × 500 根的计算量不小，应给出进度与可中断设计，而不是让它卡住界面

---

## Phase 6 — 右栏 Chat（新增，当前主线）

### T6.1 Chat 数据层 ✅（已完成）
- `src/services/chat-service/chat-store.js`（SQLite）：线程 + 消息
- **对话保存过程，笔记保存结论**：原始消息全存（用户要能回看"上个月到底怎么想的"），
  「喂给模型多少」是装配问题（T7.2），与存储分开——混在一起会要么丢历史、要么上下文爆炸
- 线程按标的组织 + 一条 `global` 研究主线（跨标的的问题不归属任何标的）
- 消息带 `toolCalls` / `meta` 结构化载荷；线程有 `summary` + `summarizedUpTo` 为 T7.2 预留
- 线程可关联 Research Note（`noteIds`）→ 回溯当时判断的入口
- **测试**：26 项

### T6.2 LLM 桥 + 工具循环 ✅（已完成）
- `src/services/chat-service/llm-loop.js`：多轮工具循环，**依赖全部注入**，可完全离线测试
  - 分片参数按 `index` 拼接（缺 id/name 的半成品丢弃）
  - 非法 JSON 参数如实回灌让模型自己修（不猜）
  - 工具抛错 → 变成错误结果回灌，**不中断对话**
  - 轮次上限（默认 6）到顶给出可执行建议
  - 错误 / 中断 / 取消 / 事件回调异常 全部有明确处理
- `src/services/chat-service/index.js`：ChatService
  - **工具白名单**：只暴露本插件 27 个工具。`ctx.tools.schemas()` 会把 agent 自有的
    read/write/bash 一并带出去——那些绝不该出现在聊天面板里
  - 系统提示词 = skill.md + 当前标的 + 面板硬约束（数字只能来自工具、不得改写统计量、
    区分事实与推断、不替用户下结论、附免责声明）
  - **给模型的工具结果截断（6000 字符），但存档保留完整内容**，并标注 `truncatedForModel`
  - **工具结果在发生的当下落库**（不是等整轮结束补写），否则回看顺序变成
    「答案 → 它用过的工具」，读起来是错的
- 9 条路由：`/chat/{info,threads,messages,send,cancel,run,delete-thread,ask,stream}`
  - `/chat/stream` 用 SSE 逐字推送；为此新增 `rawRoute`（原始 req/res 注册方式）
- **测试**：llm-loop 31 项 + chat-service 23 项 + 真实链路冒烟 12 项

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
- **测试**：client 74 → 97 项（SSE 帧解析 12 项 + UI 契约 11 项）；真实冒烟 `smoke-chat-ui.mjs` 15 项

### T6.4 与工作台状态联动 🟡（部分完成）
- 已完成：切换标的自动切换会话（右栏读的是当前标的的线程）
- 待做：把"当前标的事实底座"（K 线统计/异常）**预置进提示词**，减少首轮工具调用

### T6.5 二层的真实会话（工作区里可见）⬜
- 已完成**可行性实测**，结论见 ARCHITECTURE §12「与 DSH 真实工作区/会话的关系」
  - ✅ 插件能创建持久工作区与持久会话（`workspaceRegistry.create` + `agentLoop.create({cwd})`）
  - ✅ 会话活过插件重装（需 `agentLoop.resume` 拿回句柄）
  - ✅ `append('user/message', …, {surfaceOp:'append'})` 写入后**进入持久 projection**（界面读的就是它）
  - ❌ **运行期新建的会话不会立即出现在工作区列表**（索引启动时构建）→ 要等 DSH 重启
- 待做：把"某个标的的对话"落成真实会话（懒创建：首次发言才建）；`resume` 复用；`append` 同步
- **限制必须写进 UI**：新建的真实会话要等 DSH 重启才在工作区列出，不能承诺"立刻可见"

---

## Phase 7 — 按标的的对话线程（新增，需先确认设计）

### T7.1 线程与标的绑定
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

当前主线（Phase 5–7）：
T6.0(布局骨架 + 可调宽右栏) ✅
        ├──→ T5.1(词法/语法) ✅ → T5.2(求值器) ✅ → T5.3(未来函数检测) ✅ → T5.4(导入通道) ✅
        │                                              └──→ T5.5(主图+副图) ✅ → T5.6(指标公式 tab) ✅
        │                                                                          └──→ T5.7(选股) ⬜
        └──→ T6.1(Chat 数据层) ✅ → T6.2(LLM 桥+工具循环) ✅ → T6.3(右栏 Chat UI) ✅ → T6.4(状态联动) 🟡
                                                              └──→ T6.5(真实会话/工作区可见) ⬜
                                                              └──→ T7.1(线程绑定标的) ✅ → T7.2(摘要/上下文装配) ⬜ → T7.3(线程↔笔记) ⬜
```

已定决策（详见 ARCHITECTURE §15）：**D15 懒创建**（读路径绝不建线程/会话，只有真的发言才建）、
**D16 两层对话**（右栏即时问答 + 工作区可见的真实会话）。

## 当前状态

- [x] PLUGIN_REVIEW.md v1.0（源码版，2026-10-23；waste-market 因代码混淆排除，主 fork = dsh-astock）
- [x] ARCHITECTURE.md v0.1
- [x] ROADMAP.md v0.1
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
  - 8 个 Tools（含核心 `stock_research_snapshot`）9 项单测通过
  - StockContext provider
  - stock-lab skill（合规红线 + 研究方法论）
  - Host 入口 + 10 条 HTTP 路由 16 项契约测试通过
  - 架构铁律自动校验（只有 market-service 可 import datasource）
- [x] **T1.3 工作台页面** ✅
  - `src/client.js`（484 行）：顶部指数栏、左侧自选股+搜索、K线（手写 SVG 蜡烛 + 成交量副图 + MA20）、行情明细、底部 新闻/财务/资金流 tabs
  - slot 注册：`main[key=stock-lab]` + `sidebar.panellist[id=stock-lab, order=70]`
  - 自选股与最后查看持久化（localStorage）
  - UI 状态自动上报 `/stock-lab/context`（Context-aware AI）
  - **已在真实 DSH GUI 中验证**：两个 slot 均 `active: true`
- [x] **T1.4 K线组件** ✅（手写 SVG，无第三方图表依赖；日/周/月 × 前/后/不复权 × 60–500 根，逐根十字读数）
- [x] **安装到 profile 并 GUI 验证** ✅ `application: applied`
  - 6 条数据路由实测返回 ok
  - `main[key=stock-lab]` 与 `sidebar.panellist[id=stock-lab]` 均 `active: true`
- [x] **AI Tools 真实调用验证** ✅（2026-10-23 本轮修复后）
  - 修补关键缺陷：插件 `inject` 缺 `tools`/`skills`，导致 8 个 AI Tools 此前**静默未注册**
  - 修复后 `Tool.listTools` 可见全部 8 个 `stock_*`；skill 目录出现 `stock-lab`
  - `stock_research_snapshot(600519)` 真实返回：价 1335、涨 1.25%、成交额 76.77 亿、换手 0.46%、PE 20.49、PB 6.64、总市值 16689 亿、20 日超额 +13.33pp、主力净流入 2.83 亿、2026H1 营收 922.8 亿、**2 条代码判定异常**（量能 2.93σ、相对强度）

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
  - `src/data-root.js`：数据根目录的**唯一定义**（此前读写两方各按不同顺序回退，存在「写进 A / 读 B」的真实缺陷）
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

### 已完成的可交付验证

```
JS：
  node tests/market-service.test.mjs   → 19 passed（离线）
  node tests/tools.test.mjs            → 10 passed（离线）
  node tests/host.test.mjs             → 20 passed（契约 + 架构铁律 + 降级）
  node tests/client.test.mjs           → 28 passed（bundle 契约 + 渲染 + 量化/盯盘/笔记 UI）
  node tests/research.test.mjs         → 18 passed（研究库）
  node tests/research-tools.test.mjs   → 11 passed（研究工具）
  node tests/quant-bridge.test.mjs     →  7 passed（Node→Python 桥 + 真实执行）
  node tests/watch.test.mjs            → 39 passed（盯盘求值 + 存储 + 冷却 + digest）
  node tests/local-storage.test.mjs    → 20 passed（本地库读写 + 跨语言契约）
  node tests/validate-resources.mjs    → 13 passed（展示资源 + 清单一致性）
  node tests/smoke-live.mjs            → 真实行情全通（腾讯）+ 字段断言
  node tests/smoke-live2.mjs           → 真实数据全通（东财）

Python：
  python backend/tests/test_storage.py      → 10 passed
  python backend/tests/test_event_study.py  →  9 passed

合计 JS 189 + Python 19 = 208 项
```

实测数据样例（2026-10-23 收盘后）：茅台 1335.00 (+1.25%)、沪深300 4105.33、两市成交额 19563 亿、涨跌家数 1853/437/67、茅台主力净流入 2.83 亿、PE 18.74、2026H1 营收 922.8 亿。
