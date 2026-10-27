/**
 * data-root.js — 本地数据根目录与后端路径的**唯一**解析来源
 *
 * 为什么需要这个模块：
 *   本地库的**写入方是 Python**（backend/storage/storage.py），**读取方是 Node**
 *   （src/datasource/local.js）。两边若各自按不同顺序回退，就会出现
 *   "写进了 A 目录、却去 B 目录读"的情况——数据明明在，却显示"本地无数据"。
 *   所以根目录只能有一处定义，写入方通过环境变量收到同一个值。
 *
 * 解析顺序：
 *   1. DSH_STOCK_LAB_DATA        —— 显式指定（最高优先级，即使目录还不存在也照用）
 *   2. DSH_STOCK_LAB_HOME/data
 *   3. $DSH_HOME/stock-lab/data
 *   4. ~/.dsh/stock-lab/data
 *   5. <包根>/data               —— 默认；开发时数据落在插件目录内，便于备份与删除
 *
 * 2–4 与 Python storage.py 的 `_home()` 保持一致；5 是 Node 侧的默认，
 * 且 quant-bridge 会把它作为 DSH_STOCK_LAB_DATA 传给 Python 子进程，
 * 因此两侧始终指向同一目录。
 */

import { existsSync } from 'node:fs'
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

/** 某个候选目录里是否已经有数据（meta.db 或 bars/ 存在） */
function hasData(dir) {
  return existsSync(join(dir, 'meta.db')) || existsSync(join(dir, 'bars'))
}

/**
 * 解析实际使用的数据根目录。
 *
 * 顺序：
 *   1. `DSH_STOCK_LAB_DATA`    —— 显式指定，**即使目录还不存在也照用**
 *   2. `DSH_STOCK_LAB_HOME`    —— 显式指定，同样照用（不再检查有没有数据）
 *   3. 隐式候选里第一个**已有数据**的（$DSH_HOME/stock-lab/data → 包内 data）
 *   4. 都没有则取包内 data
 *
 * ⚠️ 第 2 条为什么不走"有没有数据"的判断：
 *   曾经 `DSH_STOCK_LAB_HOME` 只作为一个候选、且要等目录里出现 meta.db/bars 才被选中。
 *   后果很隐蔽：临时目录刚建好、还没有 bars 时，解析会**静默回退到包内 data**——
 *   于是测试把数据写进了插件的真实数据目录。
 *   对一个专门用来防"写 A 读 B"的模块来说，这条回退本身就是同一类缺陷。
 */
export function resolveDataRoot() {
  if (process.env.DSH_STOCK_LAB_DATA) return process.env.DSH_STOCK_LAB_DATA
  if (process.env.DSH_STOCK_LAB_HOME) return join(process.env.DSH_STOCK_LAB_HOME, 'data')
  const candidates = dataRootCandidates()
  for (const c of candidates) {
    if (hasData(c)) return c
  }
  return candidates[candidates.length - 1]
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
 *   画线是**研究产物**——它是"我在这个位置做了一个判断"的记录，不该只活在某个浏览器里
 *   （换机器 / 清缓存就没了），而且要能跟着数据一起备份、diff、被 AI 读写。
 * 每个标的一个 JSON 文件，便于手工查看与版本管理。
 */
export function drawingsDir(root = resolveDataRoot()) {
  return join(root, 'drawings')
}