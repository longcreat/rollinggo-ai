// 幂等：提交与成功通知同事务落库，重跑时直接复用已提交 tripId，绝不生成第二个版本。
import assert from 'node:assert/strict';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { uid, type GenerateForm } from '@tripweaver/shared';
import { db } from '../db/client';
import { generationNotifications } from '../db/schema';
import { rehydrateJob } from '../generation/jobManager';
import { runGeneration } from '../generation/orchestrator';
import type { LlmConfig } from '../services/settingsService';

test('已提交过的任务重跑直接复用 tripId，不生成新版本', async () => {
  const userId = `dedupe-${Date.now()}`;
  const jobId = `job-${userId}`;
  await db.insert(generationNotifications).values({
    id: uid(), userId, jobId, kind: 'success', tripId: 'trip-existing',
    destination: '成都', days: 1, title: '已生成', message: 'ok', jobCreatedAt: new Date(), createdAt: new Date(),
  });

  const job = rehydrateJob(jobId, userId, { kind: 'generation' });
  const form: GenerateForm = {
    destination: '成都', days: 1, startDate: '2026-11-10', budgetLevel: '舒适', totalBudget: 0,
    preferences: [], partySize: 2, extraNotes: '',
  };
  // 走到重跑分支就不再调用模型；给一个不可达端点即可证明没有发起调研。
  const cfg: LlmConfig = { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'm', byok: false };

  try {
    // 命中幂等分支前不会触碰 durable 宿主，传占位即可。
    await runGeneration(job, form, cfg, undefined, {
      agent: { harness: {} as never, registry: {} as never, context: {} as never },
    });
    assert.equal(job.status, 'done');
    assert.equal(job.tripId, 'trip-existing');
  } finally {
    await db.delete(generationNotifications).where(eq(generationNotifications.jobId, jobId));
  }
});