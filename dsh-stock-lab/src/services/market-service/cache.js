/**
 * cache.js — MarketService 内存缓存（TTL + 单飞合并）
 *
 * - 盘中行情 TTL 短（秒级），历史/财务 TTL 长
 * - 同一 key 的并发请求合并为一次上游调用（single-flight）
 */
export class TtlCache {
  constructor(now = () => Date.now()) {
    this.now = now
    this.map = new Map() // key -> { value, expiresAt, promise }
  }

  /**
   * @param key 缓存键
   * @param ttlMs 有效期
   * @param loader 未命中时调用
   */
  async get(key, ttlMs, loader) {
    const hit = this.map.get(key)
    const t = this.now()
    if (hit && hit.value !== undefined && hit.expiresAt > t) return hit.value
    if (hit && hit.promise) return hit.promise
    const promise = (async () => {
      try {
        const value = await loader()
        this.map.set(key, { value, expiresAt: this.now() + ttlMs })
        return value
      } catch (e) {
        // 失败不写缓存，并清掉 promise 让下次重试
        this.map.delete(key)
        throw e
      }
    })()
    this.map.set(key, { promise, expiresAt: t + ttlMs })
    return promise
  }

  invalidate(prefix) {
    for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k)
  }

  clear() { this.map.clear() }
}
