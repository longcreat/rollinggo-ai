// 生成委派：工具（行程内对话）与表单入口共用同一份实现。
// 对齐 openmuse 的 delegate_task：只负责把后台任务建起来并立即返回 jobId，不等待生成完成。
import { GENERATION_TIMEOUT_MINUTES, briefToGenerateForm, requiredBriefFields, type PlanningBriefData } from '@tripweaver/shared';
import { beginGenerationTask, finalizeGenerationTask, getLatestGenerationTask, getTaskByRequestId } from '../../generation/taskStore';
import { cancelJob, createJob, getJob, getRunningJobId } from '../../generation/jobManager';
import { generationStatusView, type LiveGenerationStatus } from '../../generation/statusView';
import type { GenerationTaskInput } from '../../generation/generationTask';

export interface DelegateGenerationInput {
  userId: string;
  conversationId: string;
  brief: PlanningBriefData;
  /** 表单入口的幂等键：同一请求重试返回同一个任务，而不是再建一个。 */
  requestId?: string;
  /** 已有任务时的策略：工具内报错；表单入口复用已在跑的任务。 */
  onRunning: 'error' | 'adopt';
  createTask: (input: GenerationTaskInput) => Promise<void>;
}

/**
 * 主 Agent 读任务状态：内存中的运行任务优先（有阶段/步骤），否则读持久任务行（重启后仍可答）。
 * 详情对话与行前回合共用。
 */
export async function readGenerationStatus(userId: string, startedJobId?: string) {
  const activeId = getRunningJobId(userId);
  const job = (activeId ? getJob(activeId, userId) : null)
    ?? (startedJobId ? getJob(startedJobId, userId) : null);
  if (job) {
    const snapshot = job.projection.channel.snapshot;
    const live: LiveGenerationStatus = {
      jobId: job.id,
      status: job.status,
      tripId: job.tripId,
      ...(job.destination ? { destination: job.destination } : {}),
      ...(job.days !== undefined ? { days: job.days } : {}),
      phase: snapshot.state.control.phase,
      steps: snapshot.state.taskGraph
        .filter((node) => node.status === 'done' || node.status === 'running')
        .slice(-8)
        .map((node) => `${node.label}:${node.status}`),
    };
    return generationStatusView({ live });
  }
  const task = await getLatestGenerationTask(userId);
  return generationStatusView({ task, now: Date.now(), staleAfterMs: GENERATION_TIMEOUT_MINUTES * 60_000 });
}

/** 任务存储依赖（测试可注入假实现，避免单测依赖 PG）。 */
export interface DelegateStore {
  beginGenerationTask: typeof beginGenerationTask;
  finalizeGenerationTask: typeof finalizeGenerationTask;
  getTaskByRequestId: typeof getTaskByRequestId;
}

const defaultStore: DelegateStore = { beginGenerationTask, finalizeGenerationTask, getTaskByRequestId };

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
  const running = getRunningJobId(input.userId);
  if (running) {
    return input.onRunning === 'adopt'
      ? { jobId: running }
      : { error: '已有一份行程正在生成，等它结束后再试。' };
  }

  const form = briefToGenerateForm(input.brief);
  const job = createJob(input.userId, { conversationId: input.conversationId, kind: 'generation' });
  const taskInput: GenerationTaskInput = {
    jobId: job.id,
    userId: input.userId,
    form,
    provenance: job.provenance,
  };
  try {
    await store.beginGenerationTask(job, form, input.requestId);
    await input.createTask(taskInput);
    return { jobId: job.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : '生成任务没有启动';
    cancelJob(job);
    await store.finalizeGenerationTask(job, 'error', null, { error: message }).catch(() => {});
    return { error: message };
  }
}
