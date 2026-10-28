/**
 * data-root.js — 本地数据根目录与后端路径的**唯一**解析来源
 *
 * 为什么需要这个模块：
 *   本地库的**写入方是 Python**（backend/storage/storage.py），**读取方是 Node**
 *   （src/datasource/local.js）。两边若各自按不同顺序回退，就会出现
 *   "写进了 A 目录、却去 B 目录读"的情况——数据明明在，却显示"本地无数据"。
 *   所以两边的解析规则必须**完全同构**（不是"看起来差不多"）：本文件与
 *   `backend/storage/storage.py` 的 `_home()` 是同一套规则的两份实现，
 *   由 `tests/local-storage.test.mjs` 的跨语言契约测试守住。
 *
 * 解析顺序（Node 与 Python 必须一致）：
 *   1. DSH_STOCK_LAB_DATA        —— 显式指定（最高优先级，即使目录还不存在也照用）
 *   2. DSH_STOCK_LAB_HOME/data   —— 显式指定，同样照用（不探测有没有数据）
 *   3. $DSH_HOME/stock-lab/data  —— 隐式候选：第一个**真的有 K 线数据**的
 *   4. <包根>/data               —— 都没有数据时取它（开发期默认，便于备份与删除）
 *
 * ⚠️ "有数据"的判据是**有真实 K 线文件**（bars/<symbol>/ 下至少一个 *.csv.gz / *.parquet），
 *   不是"meta.db 或 bars/ 目录存在"。踩过的坑：只读命令（collector.py status）曾顺手把
 *   空 meta.db 建出来，于是这个空目录被当成"有数据"，把真正的库整个顶掉——
 *   表现是"数据明明在，界面却显示无数据/画线消失"。空库不算数据。
 */

import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))

/** 包根目录（含 package.json / backend / src） */
export const pkgRoot = join(here, '..')

/** Python 后端目录 */
export const backendDir = process.env.DSH_STOCK_LAB_BACKEND || join(pkgRoot, 'backend')

/** 候选目录（按优先级） */
export function dataRootCandidates() {
  const out = []
  if (process.env.DSH_STOCK_LAB_DATA) out.push(process.env.DSH_STOCK_LAB_DATA)
  if (process.env.DSH_STOCK_LAB_HOME) out.push(join(process.env.DSH_STOCK_LAB_HOME, 'data'))
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  out.push(join(dshHome, 'stock-lab', 'data'))
  out.push(join(pkgRoot, 'data'))
  return [...new Set(out)]
}

/** 本地库数据文件后缀（与 Python storage.py 的 `_DATA_SUFFIXES` 保持一致） */
const DATA_SUFFIXES = ['.csv.gz', '.parquet']

/**
 * ⚠️ 判定"有数据"时把 `.parquet` 也算上，是为了与 Python 侧**解析到同一个根目录**（否则两侧会分叉）。
 * 但 Node 读不了 Parquet（没有 pyarrow 等价物，见 `src/datasource/local.js` 顶部注释）——
 * 若某个库里**只有** `.parquet`，解析会选中它、而 K 线读取端会返回空。这是已知的格式限制，
 * 不是解析错误；当前环境没有 pyarrow，实际永远是 csv.gz。
 */

/** 最多扫描多少个 symbol 目录（防止海量空目录把解析拖慢；找到第一个就返回） */
const SCAN_LIMIT = 200

/**
 * 某个候选目录里是否**真的有** K 线数据。
 *
 * 判据：`bars/<symbol>/` 下至少有一个 `*.csv.gz` / `*.parquet`。
 * 刻意**不**把「meta.db 存在」或「bars/ 目录存在」当成有数据——
 * 空库（schema 建好但 0 行、或只有空目录）会把真正的数据目录顶掉。
 */
function hasData(dir) {
  const bars = join(dir, 'bars')
  let names
  try {
    names = readdirSync(bars)
  } catch {
    return false
  }
  for (const name of names.slice(0, SCAN_LIMIT)) {
    const sub = join(bars, name)
    let files
    try {
      if (!statSync(sub).isDirectory()) continue
      files = readdirSync(sub)
    } catch {
      continue
    }
    for (const f of files) {
      if (!DATA_SUFFIXES.some((suffix) => f.endsWith(suffix))) continue
      // 必须是真的**文件**（同名目录不算）——与 Python `_has_data()` 的 `f.is_file()` 对齐
      try {
        if (statSync(join(sub, f)).isFile()) return true
      } catch {
        /* 读不到就跳过，不因为单个条目坏掉而误判 */
      }
    }
  }
  return false
}

/** 解析结果缓存：local.js 每次读盘都会调 resolveDataRoot()，不能每次都扫目录。 */
const RESOLVE_TTL_MS = 10_000
let _cachedRoot = null
let _cachedKey = null
let _cachedAt = 0

function envKey() {
  return [
    process.env.DSH_STOCK_LAB_DATA || '',
    process.env.DSH_STOCK_LAB_HOME || '',
    process.env.DSH_HOME || '',
  ].join('|')
}

/**
 * 清空解析缓存。
 * 只给测试用：同一进程里改了目录内容（例如刚采集完）又想立刻重新解析时调用。
 * 生产路径不需要它——TTL 到期会自动重算，环境变量变化也会立刻失效。
 */
export function __resetDataRootCache() {
  _cachedRoot = null
  _cachedKey = null
  _cachedAt = 0
}

/**
 * 解析实际使用的数据根目录。
 *
 * 顺序：
 *   1. `DSH_STOCK_LAB_DATA`    —— 显式指定，**即使目录还不存在也照用**
 *   2. `DSH_STOCK_LAB_HOME`    —— 显式指定，同样照用（不再检查有没有数据）
 *   3. 隐式候选里第一个**真的有 K 线数据**的（$DSH_HOME/stock-lab/data → 包内 data）
 *   4. 都没有则取包内 data
 *
 * ⚠️ 第 2 条为什么不走"有没有数据"的判断：
 *   曾经 `DSH_STOCK_LAB_HOME` 只作为一个候选、且要等目录里出现 meta.db/bars 才被选中。
 *   后果很隐蔽：临时目录刚建好、还没有 bars 时，解析会**静默回退到包内 data**——
 *   于是测试把数据写进了插件的真实数据目录。
 *   对一个专门用来防"写 A 读 B"的模块来说，这条回退本身就是同一类缺陷。
 */
export function resolveDataRoot() {
  const key = envKey()
  const now = Date.now()
  if (_cachedRoot !== null && _cachedKey === key && now - _cachedAt < RESOLVE_TTL_MS) {
    return _cachedRoot
  }

  let root
  if (process.env.DSH_STOCK_LAB_DATA) {
    root = process.env.DSH_STOCK_LAB_DATA
  } else if (process.env.DSH_STOCK_LAB_HOME) {
    root = join(process.env.DSH_STOCK_LAB_HOME, 'data')
  } else {
    const candidates = dataRootCandidates()
    root = candidates[candidates.length - 1]
    for (const c of candidates) {
      if (hasData(c)) { root = c; break }
    }
  }

  _cachedRoot = root
  _cachedKey = key
  _cachedAt = now
  return root
}

/** bars 分区目录 */
export function barsDir(root = resolveDataRoot()) {
  return join(root, 'bars')
}

/** meta.db 路径 */
export function metaDbPath(root = resolveDataRoot()) {
  return join(root, 'meta.db')
}

/**
 * 手工画线（图表标注）目录。
 *
 * 为什么放在数据根目录、而不是 localStorage：
 * 画线是**研究产物**——它是"我在这个位置做了一个判断"的记录，不该只活在某个浏览器里
 * （换机器 / 清缓存就没了），而且要能跟着数据一起备份、diff、被 AI 读写。
 * 每个标的一个 JSON 文件，便于手工查看与版本管理。
 */
export function drawingsDir(root = resolveDataRoot()) {
  return join(root, 'drawings')
}
