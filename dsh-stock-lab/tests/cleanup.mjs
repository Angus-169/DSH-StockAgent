/**
 * cleanup.mjs — 测试临时目录清理（共享）
 *
 * 为什么不能写成 `try { rmSync(dir) } catch { }`：
 * Windows 上只要还有 SQLite 连接没关，文件就被占用、删除会失败，
 * 而空 catch 会把失败**静默吞掉**。真实后果：临时目录越积越多（曾累积到 55 个），
 * 而测试输出一切正常，完全看不出问题。
 *
 * 所以这里重试几次，并且**失败要出声**——把"隐性问题"变成可见输出。
 */
import { rmSync } from 'node:fs'

export function cleanupTempDir(dir) {
  for (let i = 0; i < 3; i++) {
    try { rmSync(dir, { recursive: true, force: true }); return true }
    catch { /* 可能仍被占用，稍后重试 */ }
  }
  console.warn('  ⚠️ 临时目录未清理（文件可能仍被占用）：' + dir)
  return false
}