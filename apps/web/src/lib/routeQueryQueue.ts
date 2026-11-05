type Job = { key: string; run: () => Promise<unknown>; signal: AbortSignal; resolve: (value: unknown) => void; reject: (error: unknown) => void };

/** One active request across all cards; foreground selections jump pending prefetch work.
 * Cancel queued work on unmount. Let an already sent request finish so the server's
 * per-user concurrency gate is released before the next request is sent. */
export class RouteQueryQueue {
  private jobs: Job[] = [];
  private running = false;

  enqueue<T>(key: string, signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: Job = { key, signal, run, resolve: (value) => resolve(value as T), reject };
      if (signal.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
      this.jobs.push(job);
      queueMicrotask(() => { void this.drain(); });
    });
  }

  promote(key: string): void {
    const index = this.jobs.findIndex((job) => job.key === key);
    if (index > 0) this.jobs.unshift(...this.jobs.splice(index, 1));
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs.shift()!;
        if (job.signal.aborted) { job.reject(new DOMException('Cancelled', 'AbortError')); continue; }
        try { job.resolve(await job.run()); } catch (error) { job.reject(error); }
      }
    } finally { this.running = false; }
  }
}
