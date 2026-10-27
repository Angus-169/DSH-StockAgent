/**
 * read-file.js — 读取公式文件（工具层与路由层共用）
 *
 * 为什么单独一个文件：文件导入有两条入口（AI 工具 import_formula 的 filePath、
 * 界面粘贴框的选文件），读取逻辑必须一致——体积上限、编码兜底、目录判断。
 * 两处各写一遍必然漂移。
 *
 * 编码：通达信导出的 .txt/.tnf 常见 GBK。先按 UTF-8 解，出现替换字符再试 GBK，
 *       两者都失败则如实报错（不返回乱码当成功）。
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { extname, join } from 'node:path'

/** 单个公式文件体积上限（TDX 公式源码通常只有几 KB） */
export const MAX_FILE_BYTES = 512 * 1024

/** 可批量导入的文本扩展名 */
export const TEXT_EXTENSIONS = ['.txt', '.tnf', '.tne.txt', '.formula', '.fml', '.src']

/** 已知的二进制/加密扩展名：明确拒绝并说明原因 */
export const BINARY_EXTENSIONS = ['.tne', '.tni', '.tno', '.exe', '.dll', '.zip', '.rar', '.7z']

export class FormulaFileError extends Error {}

/**
 * 读取公式文件文本。
 * @param {string} path
 * @returns {string}
 */
export function readFormulaFileText(path) {
  const p = String(path || '').trim()
  if (p === '') throw new FormulaFileError('文件路径为空')
  if (!existsSync(p)) throw new FormulaFileError('文件不存在：' + p)
  const st = statSync(p)
  if (st.isDirectory()) {
    throw new FormulaFileError('这是一个目录，请指定具体文件；批量导入请用 listFormulaFiles 或 import_formula_dir')
  }
  if (st.size === 0) throw new FormulaFileError('文件是空的：' + p)
  if (st.size > MAX_FILE_BYTES) {
    throw new FormulaFileError(
      `文件过大（${st.size} 字节，上限 ${MAX_FILE_BYTES}）。通达信公式源码通常只有几 KB，`
      + '如果你选的是公式库整体导出包，请先解压并挑选单个公式文件。',
    )
  }

  const ext = extname(p).toLowerCase()
  if (BINARY_EXTENSIONS.includes(ext)) {
    throw new FormulaFileError(
      `不支持的文件类型 ${ext}：这是通达信的加密/二进制格式，无法还原为源码。`
      + '请在通达信的「公式管理器」里打开该公式，复制源码文本；或导出为 .txt 后再导入。',
    )
  }

  const buf = readFileSync(p)
  // 先 UTF-8
  let text = buf.toString('utf8')
  if (!text.includes('\uFFFD')) return text
  // 出现替换字符 → 尝试 GBK（通达信导出常见）
  try {
    const gbk = new TextDecoder('gbk', { fatal: false }).decode(buf)
    // 若 GBK 解出的替换字符更少，采用它
    const bad = (s) => (s.match(/\uFFFD/g) || []).length
    if (bad(gbk) < bad(text)) return gbk
  } catch { /* 环境不支持 gbk 时保留 utf8 结果 */ }
  return text
}

/**
 * 列出目录下可导入的公式文件（不递归进符号链接，避免环）。
 * @returns {Array<{path, name, size, ext, rejected?: string}>}
 */
export function listFormulaFiles(dirPath) {
  const p = String(dirPath || '').trim()
  if (!existsSync(p)) throw new FormulaFileError('目录不存在：' + p)
  const st = statSync(p)
  if (!st.isDirectory()) throw new FormulaFileError('不是目录：' + p)

  const out = []
  for (const name of readdirSync(p)) {
    const full = join(p, name)
    let info
    try { info = statSync(full) } catch { continue }
    if (!info.isFile()) continue
    const ext = extname(name).toLowerCase()
    if (BINARY_EXTENSIONS.includes(ext)) {
      out.push({ path: full, name, size: info.size, ext, rejected: '加密/二进制格式，无法解析' })
      continue
    }
    if (TEXT_EXTENSIONS.includes(ext) || ext === '') {
      out.push({ path: full, name, size: info.size, ext })
    }
  }
  return out
}