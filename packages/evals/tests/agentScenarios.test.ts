// 把 Agent 确定性场景接进 eval:test（零 token、不连库），保证分流/工具契约/并发/停止不被改坏。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDeterministic } from '../agent/run';

test('Agent 确定性场景：分流、工具契约、不截断、并发与停止', async () => {
  const results = await runDeterministic();
  const failed = results.filter((result) => !result.ok).map((result) => `${result.id}: ${result.detail}`);
  assert.deepEqual(failed, []);
  assert.ok(results.length >= 6, `场景数不足：${results.length}`);
});
