/**
 * session-map.js — 标的 ↔ 真实 DSH 会话 的确定性映射
 *
 * 为什么必须是**确定性**的（不能随机生成 id、也不能只存在内存里）：
 *
 *   用户的真实问题是："今天聊过的股票，两周后再打开，还能接上之前的对话吗？"
 *   两周之间 DSH 很可能重启过，插件也重装过——内存里什么都没了。
 *   因此**会话 id 必须能由标的代码直接推导出来**，才能靠 `agentLoop.resume` 找回来。
 *
 * 例：`SH600519` → `session-stocklab-sh600519`
 *
 * 反过来也提供解析函数，便于"这个会话是哪个标的的"这类回溯。
 *
 * ⚠️ 这份映射一旦发布就是**持久化格式**：改变规则会让旧会话再也找不回来。
 *    所以有测试把它钉死。
 */

import { normalize } from '../market-service/symbols.js'

/** 会话 id 前缀（同时用于识别"这是 Stock Lab 创建的会话"） */
export const SESSION_PREFIX = 'session-stocklab-'

/** 全局研究主线（不对应具体标的）的会话 id 后缀 */
export const GLOBAL_SUFFIX = 'global'

/**
 * 由标的推导会话 id。同一标的永远得到同一个 id。
 * @param symbol 任意可被 normalize 识别的写法（600519 / sh600519 / 600519.SH …）
 * @returns 确定性会话 id；全局线程传 null/空/global
 */
export function sessionIdForSymbol(symbol) {
  const raw = String(symbol ?? '').trim()
  if (raw === '' || raw.toLowerCase() === GLOBAL_SUFFIX) return SESSION_PREFIX + GLOBAL_SUFFIX
  let canonical
  try {
    canonical = normalize(raw).symbol
  } catch {
    // 无法识别的写法：退化为大写原文，保证"不崩且仍确定"
    canonical = raw.toUpperCase()
  }
  return SESSION_PREFIX + canonical.toLowerCase()
}

/**
 * 从会话 id 反推标的（用于回溯"这是哪只股票的会话"）。
 * 不是本插件创建的会话返回 null。
 */
export function symbolFromSessionId(sessionId) {
  const s = String(sessionId ?? '')
  if (!s.startsWith(SESSION_PREFIX)) return null
  const tail = s.slice(SESSION_PREFIX.length)
  if (tail === GLOBAL_SUFFIX) return null            // 全局线程不归属标的
  // 生成时统一小写，这里统一大写还原：sh600519 → SH600519；idx000300 → IDX000300
  return tail.toUpperCase()
}

/** 这个会话 id 是否由本插件创建 */
export function isStockLabSession(sessionId) {
  return String(sessionId ?? '').startsWith(SESSION_PREFIX)
}