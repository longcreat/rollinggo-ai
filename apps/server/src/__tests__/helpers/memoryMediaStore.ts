// 单测用内存实现。语义与对象存储一致（覆盖写入、缺失返回 null），并复用生产的 key 校验，
// 这样调用方拼出 `../` 这类非法 key 时测试会失败，而不是悄悄写进某处。
import { normalizeMediaKey, type MediaStore } from '../../lib/mediaStore';

export interface MemoryMediaStore extends MediaStore {
  keys(): string[];
}

export function createMemoryMediaStore(): MemoryMediaStore {
  const objects = new Map<string, Buffer>();
  const require_ = (key: string): string => {
    const clean = normalizeMediaKey(key);
    if (!clean) throw new Error(`媒体 key 非法：${key}`);
    return clean;
  };
  const keysUnder = (prefix: string): string[] => {
    const clean = require_(prefix);
    return [...objects.keys()].filter(key => key.startsWith(`${clean}/`));
  };
  return {
    async put(key, bytes) { objects.set(require_(key), Buffer.from(bytes)); },
    async get(key) { return objects.get(require_(key)) ?? null; },
    async delete(key) { objects.delete(require_(key)); },
    async exists(key) { return objects.has(require_(key)); },
    async list(prefix) {
      return keysUnder(prefix).sort().map(key => ({ key, size: objects.get(key)!.length }));
    },
    keys: () => [...objects.keys()],
  };
}
