// 串行执行队列：全局 1 并发 + 最小调用间隔（Nominatim / 高德 / Web 搜索共用）
export function createSerialQueue(minIntervalMs: number) {
  let tail: Promise<unknown> = Promise.resolve();
  let lastDoneAt = 0;

  return function run<T>(fn: () => Promise<T>): Promise<T> {
    const next = tail.then(async () => {
      const wait = lastDoneAt + minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await fn();
      } finally {
        lastDoneAt = Date.now();
      }
    });
    tail = next.catch(() => {});   // 失败不阻塞后续任务
    return next;
  };
}
