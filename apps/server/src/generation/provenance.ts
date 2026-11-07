// 生成任务的来源标注与最小任务引用（不再有内存 Job 对象）。
import type { GenerationKind } from '@tripweaver/shared';

export interface GenerationProvenance {
  conversationId?: string;
  kind: GenerationKind;
  targetTripId?: string;
}

/** 一次生成的稳定身份：任务行、投影、日志都用它，不携带任何状态。 */
export interface GenerationTaskRef {
  jobId: string;
  userId: string;
  createdAt: number;
  provenance: GenerationProvenance;
}
