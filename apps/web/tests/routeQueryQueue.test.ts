import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RouteQueryQueue } from '../src/lib/routeQueryQueue.ts';

test('user choice takes priority; unmounted queued routes never start; one request at a time', async () => {
  const queue = new RouteQueryQueue();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const signal = new AbortController().signal;
  const first = queue.enqueue('active', signal, async () => { order.push('active'); await gate; });
  await Promise.resolve();
  const background = queue.enqueue('background', signal, async () => { order.push('background'); });
  const cancelled = new AbortController();
  const skipped = queue.enqueue('cancelled', cancelled.signal, async () => { order.push('WRONG'); }).catch((e) => e.name);
  const selected = queue.enqueue('selected', signal, async () => { order.push('selected'); });
  cancelled.abort();
  queue.promote('selected');
  assert.deepEqual(order, ['active']);
  release();
  await Promise.all([first, background, selected]);
  assert.equal(await skipped, 'AbortError');
  assert.deepEqual(order, ['active', 'selected', 'background']);
});

test('a failed query does not poison subsequent route requests', async () => {
  const queue = new RouteQueryQueue();
  const signal = new AbortController().signal;
  const failed = queue.enqueue('bad', signal, async () => { throw new Error('offline'); });
  const next = queue.enqueue('next', signal, async () => 42);
  await assert.rejects(failed, /offline/);
  assert.equal(await next, 42);
});
