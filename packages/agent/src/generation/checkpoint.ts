// 生成任务的 checkpoint：只放可 JSON 序列化的数据（durable task state）。
//
// 当前只有一个边界：调研完成后保存「候选池 + 坐标旁路 + 知识库事实」。
// 进程崩溃后重跑任务时复用该 checkpoint，跳过最耗时的 LLM 调研；规划/校准/落库仍在同一 phase 内重跑。
import type { DataSourceKind, ResearchPoi } from '@tripweaver/shared';
import type { ResearchLocation } from './placeLookup';
import type { PlaceFacts } from './scheduling/placeFacts';

export interface ResearchCheckpoint {
  summary: string;
  pool: ResearchPoi[];
  /** Map 的序列化形式（key = 地点名/id，value = 坐标旁路）。 */
  locations: [string, ResearchLocation][];
  placeFacts: [string, PlaceFacts][];
  enabledSources: DataSourceKind[];
}

export function serializeResearch(input: {
  summary: string;
  pool: ResearchPoi[];
  locations: ReadonlyMap<string, ResearchLocation>;
  placeFacts: ReadonlyMap<string, PlaceFacts>;
  enabledSources: DataSourceKind[];
}): ResearchCheckpoint {
  return {
    summary: input.summary,
    pool: input.pool,
    locations: [...input.locations],
    placeFacts: [...input.placeFacts],
    enabledSources: input.enabledSources,
  };
}