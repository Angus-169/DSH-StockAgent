# DSH Stock Lab

> 集成在 DeepSeek Harness 内部的中国 A 股智能研究平台
> 侧栏显示名：**看盘助手**（插件标识仍是 `dsh-stock-lab`——改内部标识会波及路由、localStorage 键与数据目录）
> AI 原生 · 研究 / 盯盘 / 量化三者兼顾 · 当前阶段不做自动下单

**⚠️ 免责声明**：本项目仅用于技术学习与量化研究，**不构成任何投资建议**。所有数据来自第三方公开接口，可能存在错误、延迟或缺失。历史统计不预示未来表现。任何据此做出的投资决策由使用者自行判断并承担全部后果。

---

## 目录

- [这是什么](#这是什么)
- [这**不是**什么](#这不是什么)
- [核心差异：从"发生了什么"到"为什么"](#核心差异从发生了什么到为什么)
- [快速上手](#快速上手)
- [界面结构](#界面结构)
- [K 线交互（D18）](#k-线交互d18)
- [图表画线（D19）](#图表画线d19)
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

一个装在 DSH（DeepSeek Harness）里的**AI 原生 A 股研究工作台**，由五部分构成：

| 模块 | 作用 |
|---|---|
| **行情终端** | 工作台页面：指数栏、自选股、K 线、行业、财务、资金流、新闻 |
| **AI 研究助手** | 31 个结构化工具 + 上下文感知，让 LLM 能拿到真实数据回答问题 |
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

这个闭环**每一步都有实现，且都用真实数据跑通过**。

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

1. 打开 DSH Web UI，**左侧栏底部点「看盘助手」图标**（早期版本叫「股票研究」，已改名，测试钉住了这个标签）
2. 顶部看大盘，左侧搜索股票加入自选
3. 中央看 K 线（滚轮以指针位置为锚缩放，可画线/测幅），底部切 8 个 tab
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
│ 搜索      │  名称 价格 涨跌 ST/停牌标记    │  右栏：当前标的的  │
│ 自选股    │  日/周/月 · 复权 · 根数        │  AI 对话（SSE 逐字）│
│ （可增删）│  手写 SVG 蜡烛 + MA20 + 成交量  │  · 工具调用单独成列 │
│          │  窗口缩放/平移 · 画线 · 测幅    │  · 切标的自动切会话 │
│          │  开盘 最高 最低 昨收 换手 PE   │                  │
├──────────┴──────────────────────────────┴──────────────────┤
│ 新闻 │ 财务 │ 资金流 │ 所属行业 │ 指标公式 │ 量化验证 │ 智能盯盘 │ 研究笔记 │
└────────────────────────────────────────────────────────────┘
```

各个底部 tab：

| Tab | 内容 |
|---|---|
| **新闻** | 个股相关财经新闻与公告标题（东财站内搜索） |
| **财务** | 最近 12 期：营收/净利及同比、ROE、毛利率、负债率、EPS |
| **资金流** | 今日与近 5 日主力净流入、超大单/大单/中单/小单分解 |
| **所属行业** | 板块行情 + 成分股涨跌榜 → 判断"行业普跌"还是"个股独立行情" |
| **指标公式** | 导入/粘贴 TDX 公式 → 主图叠加或副图 → 命中 K 线标 ▲；指标线会明说"不能当选股条件"；**公式选股**：本地库/自选/全市场批量筛选，实时进度可取消，结果可点开 |
| **量化验证** | 选事件条件与参数 → 跑 Event Study → 样本量/超额/胜率/t 值/显著性 → 一键存笔记 |
| **智能盯盘** | 建规则（9 种条件）· 立即评估 · 触发记录（严重度分级 + 依据数值 + 确认） |
| **研究笔记** | 统计条 + 新建表单 + 列表 + 内联复盘（四档结论） |

## K 线交互（D18）

**定位先说清**：这个平台是奔着**替代证券软件**去的——证券软件的短板正是没有 AI。所以操作习惯按证券软件来，而不是按"网页图表"来。

### 可视窗口模型（取代"根数预设"）

一张缓冲区 + 一个窗口 `{ count, end }`：

- 缓冲区固定取 `BARS_BUFFER = 800` 根（与 `/kline` 的 count 上限、腾讯的上游上限一致，见下）
- **缩放/平移只改窗口**，不重新取数、不重算指标 → 滚轮与按键是即时的
- `end < 0` 是"跟随最新"的**哨兵**，不是普通下标

三条"看起来正常但其实是错的"：

1. **指标在缓冲区上算、按窗口切片**。只按窗口算，左边缘的 MA 会是空值
2. **`end < 0` 必须当哨兵处理**，否则新交易日进来后画面停在旧位置
3. **`CHART_GEO` 共用一份几何常量**。SVG 固定 viewBox 再缩放，指针坐标必须换算；两处各写一份，容器一变宽就偏

### 历史深度：实测的上游限制

| 请求 | 腾讯实际返回 |
|---|---|
| 800 根 | 801 根（≈3.2 年）← 上限 |
| 1500 根 | **641 根**（请求更多反而更少） |
| 3000 根 | `param error` |

**日线上限约 800 根是上游限制**，不是我们卡住的（我们的 800 与它一致）。⚠️ 超限时上游**静默返回更少数据而不是报错**——这种静默降级要记住，别盲目调大 count。

更深历史有三条可行路径，**都还没实施**：周线/月线（同样 800 根 ≈15 年，长期结构今天就能看）、本地库随时间累积（不受单次接口上限约束）、另接更深的数据源（此前推迟的 pytdx/Tushare 属此类）。

### 交互

| 操作 | 行为 |
|---|---|
| 滚轮 | **以指针所在位置为锚**缩放（不是以屏幕中心缩放） |
| ↑ / ↓ | 缩放（`+` / `-` 同效） |
| ← / → | 平移（步长 = 窗口的 5%） |
| PageUp / PageDown | 翻页（步长 = 窗口的一个 `pageRatio`） |
| Home / End | 跳到最早 / 跟随最新 |
| 点某根 K 线 | **钉住该根读数**（不随鼠标移动而变） |
| 不选工具时拖动 | **框选放大**（拖出区间 → 放大到该区间） |
| 测幅 | 拖出两点 → 涨跌幅、价差、相隔根数（**临时显示、不落库**，工具失活即清除） |

缩放不重新取数，所以缩到某处会停住——这时界面会明说「已到数据起点（共 N 根，最早 YYYY-MM-DD）」，而不是默默不动。根因见 ARCHITECTURE §9.3 附注：`MarketService` 的 `auto` 来源判定比较的是"本地是否比它**自称**的行数少"，所以你请求超过本地已有量时会安静地只给本地的量。

> 设计取舍的完整推导在 `ARCHITECTURE.md` §9.3；任务与验收标准在 `ROADMAP.md` **T8.1**（Phase 8 看盘体验）。

## 图表画线（D19）

**画线不只是"看图方便"**：一条线可以挂 `label` 与 `reason`（为什么画在这里），所以它天然是 Research Note 的补充。而且**AI 可以画**——`save_drawing` / `list_drawings` / `delete_drawing` 三个工具让模型能直接把一个判断画到图上。这是"证券软件 + AI"最直接的结合点。

### 图形与锚点

| 工具 | 说明 |
|---|---|
| `hline` 水平线 | 按下拖动，吸附到最近 K 线的高/低点 |
| `trend` 趋势线 | 两点连成；默认**射线**，画好后可切成线段/直线（由 `ext` 字段表达） |
| `circle` 圆 | **先点圆心、再拖出半径**（锚点是"圆心 + 圆上一点"，不是包围框）→ 渲染出来是真正的圆，不会因横纵比例不同变成随缩放变化的椭圆 |
| `marker` 标记 | 在某一天上做标记（吸附到最近 K 线） |

锚点是 `{ date, price }`，并记录画线时的 `adjust`（复权模式）。三个坑，**都属于"看起来正常但其实是错的"**：

| 坑 | 为什么错 | 对策 |
|---|---|---|
| 用 K 线序号存 x | 序号随根数变化、被新数据推移 → 线跑到别处 | 存日期；绘制时解析成当前窗口下标 |
| 不记复权模式 | 前复权基准随除权整体平移 → 线与蜡烛错位 | 记 `adjust`；不一致时**画虚线 + 明确提示** |
| 直接用鼠标坐标 | SVG 固定 viewBox 再缩放 → 容器宽 ≠ 900 时算偏 | 共用 `CHART_GEO`（与缩放同一份） |

复权不一致时**照画但标注**（画虚线并说明原因），而不是隐藏：不画会让人以为线丢了，画实线会让人以为它还对得上。

### 交互

- **吸附必须有**：手画的线永远对不准 K 线高低点。锚点先吸到最近的 K 线，再把价格吸到那根的**开/高/低/收**四个价位里最近的一个——这里曾经**漏掉 `open`**，表现为"一根 K 线只能吸 3 个点"（`snapAnchor` 的注释至今还写着三个价位，代码已经是四个）。按住 Ctrl 可临时绕过吸附，想画"半路价位"时用得上
- **只有画线模式才接管指针**：没选工具时保持原有逐根十字读数，不拦截
- **选中**：「选择」模式点线（点到线距离，容差 6px）；Delete 删除、Esc 取消选中（Esc 是逐级退出：画线/测幅 → 选择模式 → 取消选中）
- **写说明**：选中后出现输入框，可写标签与"为什么画在这里"——**人画的线也能带判断依据**，否则它只是条线
- **Ctrl+Z 撤销**：画线是**高频易错**操作，"选中→找到线→点删除"三步太绕，会让人不敢随手画。换标的时清空撤销栈（跨标的撤销会张冠李戴）
- **颜色存"色名"不存色值**：`{"color":"red"}`。色值一旦写死，**明暗主题切换后可能看不清**（浅色主题下合适的深蓝，在深色主题上几乎不可见）；存色名由客户端映射到主题 token。非法色名（含 `#ff0000` 这类色值）明确拒绝
- **幽灵提示 + 预览线**：按下前移鼠标就显示"会吸附到哪、松手会得到什么线"，按下后虚线实时跟随——不用先点下去试

### 存储

`数据根目录/drawings/<标的>.json`，**每标的一个文件**。不放 localStorage，因为画线是研究产物，要能备份、diff、手工查看、被 AI 读写。**不合法就报错，不静默修正**；文件损坏如实报告（返回 `warnings`）。

两个踩过的"静默失效"值得记一下（详见 ARCHITECTURE §9.5）：

| 现象 | 根因 |
|---|---|
| 拖动时**预览线不跟随** | 图表画水平线读 `s.price`，草稿只带 `points` → `yP(undefined)` = NaN、线不可见。幽灵线能显示，只因那条路径恰好设了 `price` |
| **Ctrl+Z 不生效**（Delete 却能用） | `onPointerDown` 的 `e.preventDefault()` **阻止了浏览器把焦点交给容器**；键盘事件只在容器有焦点时到达 |

> 设计取舍的完整推导在 `ARCHITECTURE.md` §9.4；任务与验收在 `ROADMAP.md` **T8.2**。两个静默失效与「渲染字段透传」的教训在 §9.5、§9.7。

## 能力清单

### 31 个 AI 工具

| 类别 | 工具 |
|---|---|
| 行情（9） | `stock_quote` · `stock_kline` · `market_overview` · `stock_relative_strength` · `stock_financials` · `stock_money_flow` · `stock_news` · `sector_overview` · **`stock_research_snapshot`**（核心聚合） |
| 研究（4） | `save_research_note` · `list_research_notes` · `review_research_note` · `research_notebook_stats` |
| 量化（3） | `run_event_study` · `collect_history` · `local_data_status` |
| 盯盘（5） | `create_watch_rule` · `list_watch_rules` · `evaluate_watch_rules` · `list_watch_triggers` · `watch_digest` |
| 通达信公式（7） | `import_formula` · `import_formula_dir` · `run_formula` · `list_formulas` · `delete_formula` · `tdx_capabilities` · **`screen_formula`**（公式选股） |
| 图表标注（3） | `save_drawing` · `list_drawings` · `delete_drawing`（AI 可直接在图上画线并写 `reason`） |

### 通达信（TDX）公式引擎

在对话里粘贴公式、或指定公式文件即可导入并计算。**已实现 29 个可计算函数 + 7 个序列变量名**（`ABS` / `MA` / `REF` / `HHV` / `SMA` / `CROSS` / `IF` 等；序列为 `O H L C V VOL AMOUNT`——**7 个名字映射到 6 个序列，`V` 与 `VOL` 同指成交量**），支持中文变量名与 `:=` / `:` 语句。

**这是兼容子集，不是完整通达信**——三个诚实边界：

1. **加密公式文件（`.tne`）无法解析**：格式限制，不是权限问题。会让用户去「公式管理器」导出源码
2. **未来函数（`ZIG/PEAK/BACKSET` 等 7 个）检测并默认拒绝计算**：它们会重画历史，用来判断信号会得到虚假高胜率
3. **绘图指令（`DRAWTEXT` 等 18 个）被忽略但如实列出**：数值照算，不假装画出来了

口径未确认的平滑函数（`MEMA/WMA/DMA`）**不注册**——宁可报"不支持"，也不给"看起来像"的结果。

另有 **7 个依赖运行时数据的函数**（`FINANCE` / `FINANCE_EX` / `DYNAINFO` / `CAPITAL` / `SELFDATA` / `HYBLOCK` / `INBLOCK`）与 **5 个明确未实现的函数**（`COST` / `WINNER` / `LWINNER` / `PPART` / `PWINNER`）：前者拿不到财务与实时盘口（**不是**未来函数），后者是**实现缺口**（只靠 K 线可算但还没做）——两类都只做**诊断报告**，不算"已支持"。

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
│   工作台页面 · 8 个底部 tab · 只调 /stock-lab/* 路由   │
└───────────────────────┬──────────────────────────────┘
                        │ 禁止直连任何行情 API
┌───────────────────────▼──────────────────────────────┐
│                 Host 插件层（Node.js）                │
│  AI Tools 31 个 ──→ MarketService ──→ datasource/*    │
│  StockContext · Research · Watch · Quant 桥 · Formula │
│  Drawing（画线存储）· Chat（自建 LLM 工具循环）        │
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
├── ARCHITECTURE.md         分层架构、MarketService 契约、统一 schema、D18/D19 决策记录
├── ROADMAP.md              Phase 0–8 拆解 + 验收标准 + 当前进度
├── research/               被评审的 5 个插件源码（只读参考，不参与构建）
│
└── dsh-stock-lab/          实际交付的插件
    ├── package.json            bundle 清单
    ├── cordis.patch.yml        插入 DSH 层栈
    ├── skill.md                合规红线 + 研究方法论 + 盯盘用法（随插件分发）
    ├── README.md               插件实现细节（数据源坑、DSH 机制坑、测试清单）
    ├── src/
    │   ├── index.js            Host 入口：61 条路由 + 工具注册装配
    │   ├── client.js           Client bundle：工作台页面与全部 UI
    │   ├── data-root.js        数据根目录解析（Node 侧；与 Python storage.py._home() 同构）
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
    │   │   ├── screen-service/     公式选股引擎（分批求值 + 进度可取消 + 结果缓存）
    │   │   ├── drawing-service/    图表画线存储（每标的一个 JSON）
    │   │   ├── chat-service/       右栏对话（数据层 + 自建 LLM 工具循环）
    │   │   └── quant-bridge/       Node → Python 子进程桥
    │   ├── tools/              AI 工具（index / quant / research / watch / formula / drawing）
    │   └── context/            UI 状态 → LLM 上下文注入
    ├── backend/                Python
    │   ├── storage/            存储层（Parquet 优先，回退 csv.gz）
    │   ├── collectors/         历史数据采集（经 MarketService 取数）
    │   ├── quant/              Event Study
    │   └── tests/
    ├── tests/                  JS 测试（17 套离线 + 6 套真实冒烟）
    │   └── drawing-store.test.mjs   画线存储（非法条目不静默修正）
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
| 行业板块 | 东财 `clist`（板块数量随市场变化，不写死） | — |
| 新闻 | 东财站内搜索 | — |

**如上表变动的唯一影响面是 `src/datasource/`**——UI、Tools、Agent 都不受影响。

## 测试与验证

```bash
cd dsh-stock-lab

# Node 侧 · 17 套离线测试 + 1 套资源校验
node tests/client.test.mjs            # 316 项  bundle 契约 + 渲染 + K线/画线/指标公式 UI
node tests/tdx.test.mjs               #  61 项  通达信解析 / 求值语义 / 未来函数 / 选股信号安全性
node tests/formula-store.test.mjs     #  43 项  公式库 + 公式工具
node tests/screen-service.test.mjs    #  11 项  公式选股引擎（命中/缺数据/取消/缓存/标的池）
node tests/watch.test.mjs             #  39 项  盯盘求值 / 冷却 / digest
node tests/chat-store.test.mjs        #  32 项  Chat 数据层（线程 / 消息 / 落库顺序）
node tests/llm-loop.test.mjs          #  31 项  自建工具循环
node tests/drawing-store.test.mjs     #  30 项  画线存储（非法条目不静默修正）
node tests/chat-service.test.mjs      #  30 项  Chat 服务装配
node tests/host.test.mjs              #  25 项  装配契约 + 架构铁律 + 降级 + 选股路由可调用
node tests/local-storage.test.mjs     #  25 项  本地库读写 + **跨语言契约 + 数据根同构**（3 项需 Python）
node tests/market-service.test.mjs    #  19 项  代码规范化 / 缓存 / single-flight
node tests/research.test.mjs          #  18 项  研究台账生命周期
node tests/chat-persistence.test.mjs  #  16 项  持久化 + 会话映射
node tests/research-tools.test.mjs    #  14 项  研究工具 + 数据版本自动记录
node tests/tools.test.mjs             #  11 项  工具计算逻辑 / 异常检测 / 溯源
node tests/quant-bridge.test.mjs      #   7 项  Node→Python 桥（3 项需 Python）
node tests/validate-resources.mjs     #  13 项  展示资源（locale / icon）与清单一致性

# 6 套真实冒烟（打真实网络 / 真实 LLM，需起 dsh web；不计入上面的自动计数）
node tests/smoke-live.mjs             # 真实网络（腾讯）+ 字段合理性断言
node tests/smoke-live2.mjs            # 真实网络（东财）
node tests/smoke-tdx.mjs              # TDX 引擎在真实 K 线上的冒烟
node tests/smoke-screen.mjs           # 公式选股：真东财标的池（5,563 只）+ 真本地库（9 项检查）
node tests/smoke-chat.mjs             # 右栏 Chat 真实链路（SSE 分段 / 多轮记忆 / 工具白名单）
node tests/smoke-chat-ui.mjs          # 右栏 UI 的真实调用路径

# Python 侧
python backend/tests/test_storage.py       # 18 项  存储层 + 数据根解析
python backend/tests/test_event_study.py   #  9 项  事件研究
```

**合计 741 项 JS 离线测试 + 27 项 Python = 768 项，2026-10-29 实测全部通过。**

⚠️ **这个总数取决于 Python 是否可见**：`quant-bridge` 与 `local-storage` 里有 6 项子测试要真的起 Python 解释器，**探测不到时它们会被自动跳过**，总数退化为 **735 项**（quant-bridge 7→4、local-storage 25→22）。插件按 `DSH_STOCK_LAB_PYTHON` → 包内 `.python-path` → `DSH_PYTHON` → **DSH 自带运行时**（`~/.dsh/dsh-runtimes/.../python.exe`）→ PATH 上的 `python` 依次找（见 `quant-bridge/index.js`）。坑在于：**宿主进程通常不把 python 放进 PATH**，所以第 4 步才是实际生效的那一步——这也是"同一份代码在两台机器上跑出不同测试数"的原因，值得记下来。

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
| **Phase 3** Quant Lab | 🧊 冻结（保留可用） | Event Study✅ Quant UI✅ ／ 回归·回测·walk-forward 不再排期 |
| **Phase 4** Intelligent Watch | ✅ 基本完成 | 9 条件✅ 异常检测✅ 假设提醒✅ UI✅ 提醒通道✅ |
| **Phase 5** 通达信公式 | ✅ 完成 | 解析/求值/未来函数检测/导入通道✅ 主图叠加✅ 副图✅「指标公式」tab✅ **T5.7 公式选股✅**（本地库/自选/全市场 + 进度可取消 + 结果表 + AI 工具） |
| **Phase 6** 右栏 Chat | 🟡 主干完成 | T6.1 数据层✅ T6.2 LLM 桥 + 自建工具循环✅（含真实 LLM 冒烟）T6.3 右栏 UI✅ ／ T6.4 状态联动🟡（已能随标的切会话，只差"事实底座预置进提示词"）**T6.5 二层真实会话 ⬜** |
| **Phase 7** 按标的对话线程 | 🟡 1/3 | T7.1 线程与标的绑定✅（落在这个插件自己的 chat-store 里）／ T7.2 摘要与上下文装配⬜ T7.3 线程↔笔记联动⬜ |
| **Phase 8** 看盘体验（D18/D19） | ✅ 完成 | T8.1 K 线可视窗口与交互✅（缓冲区 800 + 窗口 `{count,end}`、指针锚定缩放、键鼠、点根钉住读数、横向框选放大、数据起点提示）／ T8.2 图表画线✅（4 种图形 + 吸附/预览/Ctrl+Z/多选删除/写说明/测幅 + 落盘 + 3 个 AI 工具 + 4 条路由） |
| ~~Phase 3 量化扩展~~ | 🧊 冻结 | 回归/回测/walk-forward 不做 |
| ~~Phase 5 高级研究~~ | 🧊 冻结 | 状态向量/Regime/ML/组合 不做 |

**一处必须说清、否则容易被误读为"已完成"的地方**：`src/services/chat-service/session-map.js` 已经把"标的 → 真实 DSH 会话"的确定性映射写好（含测试），但**全仓 grep 只有测试引用它，`src/` 下没有任何模块 import**——这条二层通道**只有映射函数，尚未接线**，即「某个标的 → 真实 DSH 会话」属**未实施**（T6.5）。Phase 6 那三个 ✅ 指的是插件自己的右栏 Chat，不是这一层。

**完成度自评**：代码层面约 75%。

**UI 已由用户在真实 DSH GUI 中多轮实测并逐项反馈迭代**（发送按钮配色与内嵌位置、用户气泡右对齐、工具调用折成一行摘要、输入框上边缘可拖高、画线拖动预览与选色板、测幅、圆的半径点、Esc 行为等），其中多项是反馈后修掉的。**剩余的不确定性是明/暗两种主题下的观感**——theme token 的实际取值只有用户能确认（见 ARCHITECTURE §9.1），这不是接口级测试能替代的。

### 规模

| 类型 | 规模（**非空行口径**） |
|---|---|
| 设计文档 | 约 1,463 行（3 份：PLUGIN_REVIEW 137 + ARCHITECTURE 752 + ROADMAP 574；含空行约 1,876 行）。**这个数随文档更新就变**——改动这三份文档后请一并复核它，别让它像本轮那样过期 |
| JS 源码 | 12,010 行 / 34 文件 |
| Python 后端 | 975 行 / 5 文件 |
| 测试 | 6,908 行 / 25 文件 |
| **合计**（不含设计文档） | **约 19,900 行** |

口径说明：**不含空行**（即过滤掉 `trim() === ''` 的行）。同一批文件按"含空行"算是 12,828 / 7,262 / 1,166 行，两个口径差别不小，写进文档时别混用。

## 设计文档索引

| 文档 | 内容 |
|---|---|
| [`PLUGIN_REVIEW.md`](PLUGIN_REVIEW.md) | Phase 0 调研：5 个候选插件的结构 / 数据源 / 可复用模块 / 风险，以及 fork 决策与理由 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 分层架构、MarketService 契约、统一数据 schema、UI Context 设计、工具设计、设计决策记录（§9 含 K 线交互 D18、画线 D19 的取舍推导） |
| [`ROADMAP.md`](ROADMAP.md) | Phase 0–8 的完整任务拆解（Goal / Input / Output / Files / Acceptance / Deps）+ 逐项进度（D18/D19 记为 Phase 8 的 T8.1/T8.2） |
| [`dsh-stock-lab/README.md`](dsh-stock-lab/README.md) | 插件实现细节：数据源字段坑、DSH 插件机制坑、测试清单、安装与验证方法 |

## 已知的坑

开发过程中踩到并修复的**真实缺陷**（完整记录在插件 README）：

| 类型 | 例子 |
|---|---|
| **数据源字段** | 腾讯按位置取值：误把成交量当成交额（差 13 倍）、误把成交额当换手率（变成 76 万）；东财 PE/PB 放大 100 倍；东财财务字段是 `REPORTDATE` 不是 `REPORT_DATE` |
| **DSH 插件机制** | `inject` 缺 `tools`/`skills` → **AI 工具静默不注册**（界面正常但 AI 完全不可用）；`ctx.set()` 需要 `declare provide` |
| **跨语言契约** | 读写两方数据目录解析不一致 → **写进 A 却读 B**，数据在却报"无数据" |
| **空库顶掉真库** | "有数据"曾按「`meta.db`/`bars/` 存在」判断；只读命令 `collector.py status` 顺手建出**空 meta.db**，于是空目录把包内真库顶掉——界面本地 K 线为空、**画线全部消失**。已改为"有真实 `*.csv.gz`/`*.parquet` 才算数据"，并让只读路径不再建目录（2026-10-28） |
| **统计边界** | 成交量 z-score 在历史标准差为 0 时（一字板）会算出无穷大，原实现返回 null 导致"极端异常"被静默吞掉 |
| **画线的静默失效** | 拖动预览不跟随（画水平线读 `s.price`，草稿只带 `points` → NaN）；Ctrl+Z 不生效（`preventDefault()` 连带阻止了焦点交接）；`resolveDrawings` 只透传 label/reason，**丢掉 `color` 与 `ext`** → 改颜色不变色、趋势线预览是射线画出来却是线段 |
| **测试数随环境变** | 有 6 项子测试依赖 Python 解释器，探不到就自动跳过（741↔735）。"测试少了"未必是代码坏了，先查 Python 路径 |

---

## 许可与合规

- 代码：MIT
- 数据：来自第三方公开接口，请遵守各数据源的服务条款
- **禁止**用于内幕交易、市场操纵等违法用途
- 本项目**不提供投资建议**，不代客理财，不做自动下单