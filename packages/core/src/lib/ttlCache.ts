// 极简 TTL 缓存：Map 插入序即 LRU 近似，超容量剔除最旧条目
export class TtlCache<V> {
  private map = new Map<string, { v: V; exp: number }>();

  constructor(
    private ttlMs: number,
    private maxSize = 200,
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.v;
  }

  set(key: string, v: V, ttlMs = this.ttlMs): void {
    if (this.map.size >= this.maxSize && !this.map.has(key)) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { v, exp: Date.now() + ttlMs });
  }
}
