/** 在线查询专用：一次短请求、成功向量缓存；离线回填仍使用原批处理客户端。 */
export interface QueryEmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  dims: number;
}

export function createQueryEmbedder(config: QueryEmbeddingConfig, options: {
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
} = {}) {
  const cache = new Map<string, { vector: number[]; expiresAt: number }>();
  const now = options.now ?? Date.now;
  return async (text: string, signal?: AbortSignal): Promise<number[] | null> => {
    const key = text.trim().replace(/\s+/g, ' ');
    if (!key || signal?.aborted || !config.baseUrl || !config.apiKey || !config.model || config.dims !== 1024) return null;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.vector;
    cache.delete(key);
    try {
      const deadline = AbortSignal.timeout(options.timeoutMs ?? 2500);
      const res = await (options.fetch ?? fetch)(`${config.baseUrl.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, input: [key] }),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
      if (!res.ok) return null;
      const body = await res.json() as { data?: { embedding?: unknown }[] };
      const vector = body.data?.[0]?.embedding;
      if (signal?.aborted || !Array.isArray(vector) || vector.length !== 1024
        || !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) return null;
      if (cache.size >= 256) cache.delete(cache.keys().next().value!);
      cache.set(key, { vector, expiresAt: now() + 10 * 60_000 });
      return vector;
    } catch { return null; }
  };
}
