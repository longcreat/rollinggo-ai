// 生成委派：工具（行程内对话）与表单入口共用同一份实现。
// 对齐 openmuse 的 delegate_task：只负责把后台任务建起来并立即返回 jobId，不等待生成完成。
import type { TaskId } from '@earendil-works/pi-durable';
import {
  GENERATION_TIMEOUT_MINUTES,
  briefToGenerateForm,
  requiredBriefFields,
  uid,
  type PlanningBriefData,
} from '@tripweaver/shared';
import { createLiveRun, emitLive, getActiveLiveRunForUser } from '../../generation/liveRun';
import {
  beginGenerationTask,
  finalizeGenerationTask,
  findActiveRunningTask,
  getGenerationTask,
  getLatestGenerationTask,
  getTaskByRequestId,
  setGenerationDurableTaskId,
} from '../../generation/taskStore';
import { generationStatusView, type LiveGenerationStatus } from '../../generation/statusView';
import type { GenerationTaskInput } from '../../generation/generationTask';
import type { GenerationTaskRef } from '../../generation/provenance';

export interface DelegateGenerationInput {
  userId: string;
  conversationId: string;
  brief: PlanningBriefData;
  /** 表单入口的幂等键：同一请求重试返回同一个任务，而不是再建一个。 */
  requestId?: string;
  /** 已有行程的重新生成：挂到同一版本链的下一版，而不是新建 root。 */
  targetTripId?: string;
  /** 已有任务时的策略：工具内报错；表单入口复用已在跑的任务。 */
  onRunning: 'error' | 'adopt';
  createTask: (input: GenerationTaskInput) => Promise<TaskId | void>;
}

/**
 * 主 Agent / 详情对话读任务状态：实时层优先（带阶段与步骤），否则读持久任务行（重启后仍可答）。
 */
export async function readGenerationStatus(userId: string, startedJobId?: string) {
  const active = getActiveLiveRunForUser(userId);
  if (active && (!startedJobId || active.jobId === startedJobId)) {
    const snapshot = active.projection.channel.snapshot;
    const live: LiveGenerationStatus = {
      jobId: active.jobId,
      status: active.status,
      tripId: active.tripId,
      phase: snapshot.state.control.phase,
      steps: snapshot.state.taskGraph
        .filter((node) => node.status === 'done' || node.status === 'running')
        .slice(-8)
        .map((node) => `${node.label}:${node.status}`),
    };
    return generationStatusView({ live });
  }
  const task = startedJobId
    ? await getGenerationTask(userId, startedJobId)
    : await getLatestGenerationTask(userId);
  return generationStatusView({ task, now: Date.now(), staleAfterMs: GENERATION_TIMEOUT_MINUTES * 60_000 });
}

/** 任务存储依赖（测试可注入假实现，避免单测依赖 PG）。 */
export interface DelegateStore {
  beginGenerationTask: typeof beginGenerationTask;
  finalizeGenerationTask: typeof finalizeGenerationTask;
  findActiveRunningTask: typeof findActiveRunningTask;
  getTaskByRequestId: typeof getTaskByRequestId;
  setGenerationDurableTaskId: typeof setGenerationDurableTaskId;
}

const defaultStore: DelegateStore = {
  beginGenerationTask,
  finalizeGenerationTask,
  findActiveRunningTask,
  getTaskByRequestId,
  setGenerationDurableTaskId,
};

export async function delegateGeneration(
  input: DelegateGenerationInput,
  store: DelegateStore = defaultStore,
): Promise<{ jobId?: string; error?: string }> {
  if (input.requestId) {
    const existing = await store.getTaskByRequestId(input.userId, input.requestId);
    if (existing) {
      return existing.status === 'error'
        ? { error: existing.error ?? '生成任务失败' }
        : { jobId: existing.jobId };
    }
  }
  const missing = requiredBriefFields(input.brief);
  if (missing.length) return { error: `生成还缺少：${missing.join('、')}。先补齐这些条件再生成。` };
  const running = await store.findActiveRunningTask(input.userId, GENERATION_TIMEOUT_MINUTES * 60_000);
  if (running) {
    return input.onRunning === 'adopt'
      ? { jobId: running.jobId }
      : { error: '已有一份行程正在生成，等它结束后再试。' };
  }

  const form = briefToGenerateForm(input.brief);
  const ref: GenerationTaskRef = {
    jobId: uid(),
    userId: input.userId,
    createdAt: Date.now(),
    provenance: input.targetTripId
      ? { conversationId: input.conversationId, kind: 'revision', targetTripId: input.targetTripId }
      : { conversationId: input.conversationId, kind: 'generation' },
  };
  const taskInput: GenerationTaskInput = {
    jobId: ref.jobId,
    userId: ref.userId,
    form,
    provenance: ref.provenance,
    createdAt: ref.createdAt,
  };
  // 立即建实时层：工具返回 jobId 后前端马上订阅，也不能落在「持久行在跑但没有直播」的空窗。
  const run = createLiveRun(ref);
  try {
    await store.beginGenerationTask(ref, form, input.requestId);
    const taskId = await input.createTask(taskInput);
    if (taskId) await store.setGenerationDurableTaskId(ref.userId, ref.jobId, String(taskId));
    return { jobId: ref.jobId };
  } catch (error) {
    const message = error instanceof Error ? error.message : '生成任务没有启动';
    emitLive(run, { type: 'job_error', message });
    await store.finalizeGenerationTask(ref, 'error', null, {
      destination: form.destination,
      days: form.days,
      error: message,
    }).catch(() => {});
    return { error: message };
  }
}
