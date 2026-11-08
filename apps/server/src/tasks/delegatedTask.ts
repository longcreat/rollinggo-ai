// 通用子 Agent 任务契约：后台委派（delegate_task）与前台子代理（spawn_subagents）
// 共用同一套任务身份、终态结果与产物，任务卡、完成回流和 durable task 都读这一份。
export const DELEGATED_TASK_KINDS = ['trip_generation'] as const;
export type DelegatedTaskKind = (typeof DELEGATED_TASK_KINDS)[number];

export const DEFAULT_DELEGATED_TASK_KIND: DelegatedTaskKind = 'trip_generation';

export const DELEGATED_TASK_LABELS: Record<DelegatedTaskKind, string> = {
  trip_generation: '行程生成',
};

export function isDelegatedTaskKind(value: string | undefined): value is DelegatedTaskKind {
  return (DELEGATED_TASK_KINDS as readonly string[]).includes(value ?? '');
}

export interface DelegatedTaskRef {
  /** 业务任务 id（当前生成任务等于 jobId）；消息附件与任务页都用它。 */
  id: string;
  kind: DelegatedTaskKind;
  /** 发起任务的主 Agent 回合 id（requestId），完成回流与审计据此对齐。 */
  parentTurnId?: string;
  /** pi-durable 任务 id：重启恢复、取消命中都靠它。 */
  durableTaskId?: string;
}

export type DelegatedTaskTerminalStatus = 'completed' | 'failed' | 'aborted';

export interface DelegatedTaskArtifacts {
  tripId?: string;
  title?: string;
  days?: number;
  [key: string]: string | number | boolean | null | undefined;
}

/** 任务结束后统一交回的结果：前台工具结果与后台通知都走这一份。 */
export interface DelegatedTaskResult {
  id: string;
  kind: DelegatedTaskKind;
  status: DelegatedTaskTerminalStatus;
  summary?: string;
  notes?: string[];
  error?: string;
  artifacts?: DelegatedTaskArtifacts;
}

/** 交给模型的纯事实行：不拼话术，让模型组织最终回答。 */
export function taskResultLines(result: DelegatedTaskResult): string[] {
  const artifacts = result.artifacts ?? {};
  const headline = [artifacts.title, artifacts.days ? `${artifacts.days} 天` : undefined].filter(Boolean).join(' · ');
  return [
    `任务类型：${DELEGATED_TASK_LABELS[result.kind]}`,
    `状态：${result.status}`,
    ...(headline ? [`结果：${headline}`] : []),
    ...(result.summary ? [`摘要：${result.summary.slice(0, 400)}`] : []),
    ...(result.notes?.length ? [`提醒：${result.notes.slice(0, 3).join('；')}`] : []),
    ...(result.error ? [`失败原因：${result.error}`] : []),
  ];
}
