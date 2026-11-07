// 生成任务骨架：runner 成功后 completed；取消映射 aborted；上下文丢失/异常如实 failed。
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, MemoryStorage, createRegistry, defineExtension } from '@earendil-works/pi-durable';
import { GenerationTask, registerGenerationRunner, unregisterGenerationRunner } from '../generation/generationTask';

async function withHarness(run: (root: Awaited<ReturnType<Harness['root']>>, harness: Harness) => Promise<void>) {
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'generation-task', tasks: [GenerationTask] }));
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, BACKGROUND_CONTEXT);
  try {
    await run(await harness.root(BACKGROUND_CONTEXT), harness);
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
  }
}

function create(root: Awaited<ReturnType<Harness['root']>>, jobId: string) {
  return root.commit(
    (tx) => tx.createTask(GenerationTask, { jobId }, { ownership: { kind: 'conversation' } }),
    BACKGROUND_CONTEXT,
  );
}

describe('生成 durable 任务', () => {
  after(() => {
    for (const id of ['ok', 'cancelled', 'missing', 'throwing']) unregisterGenerationRunner(id);
  });

  it('runner 成功 → completed 且带 tripId', async () => {
    await withHarness(async (root, harness) => {
      registerGenerationRunner('ok', async () => ({ status: 'done', tripId: 'trip-1' }));
      const settled = await harness.waitForTask(await create(root, 'ok'), BACKGROUND_CONTEXT);
      assert.equal(settled.state.outcome?.status, 'completed');
      assert.deepEqual(settled.state.outcome?.result, { tripId: 'trip-1' });
    });
  });

  it('用户取消 → aborted', async () => {
    await withHarness(async (root, harness) => {
      registerGenerationRunner('cancelled', async () => ({ status: 'cancelled', tripId: null }));
      const settled = await harness.waitForTask(await create(root, 'cancelled'), BACKGROUND_CONTEXT);
      assert.equal(settled.state.outcome?.status, 'aborted');
    });
  });

  it('运行上下文丢失（进程重启）→ 如实 failed，不假装成功', async () => {
    await withHarness(async (root, harness) => {
      const settled = await harness.waitForTask(await create(root, 'missing'), BACKGROUND_CONTEXT);
      assert.equal(settled.state.outcome?.status, 'failed');
    });
  });

  it('runner 抛错 → failed 并记录消息', async () => {
    await withHarness(async (root, harness) => {
      registerGenerationRunner('throwing', async () => { throw new Error('模型不可用'); });
      const settled = await harness.waitForTask(await create(root, 'throwing'), BACKGROUND_CONTEXT);
      assert.equal(settled.state.outcome?.status, 'failed');
      if (settled.state.outcome?.status !== 'failed') return;
      assert.equal(settled.state.outcome.error.message, '模型不可用');
    });
  });
});