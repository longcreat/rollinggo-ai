// Planner Agent：把「定天 / 选点 / 排序 / 定时」交给模型，但所有距离与时长来自工具。
//
// 与 research 阶段的边界：research 只产出候选池与简介；这里决定每天去哪、按什么顺序、
// 几点到几点，并在提交前用 validate_plan 自检。失败处理沿用 runPhaseAgent 的 completion 语义。
import type { GenerateForm } from '@tripweaver/shared';
import { runPhaseAgent, type RunAgentOptions, type RunAgentResult } from '../agents/runner';
import type { DraftTrip } from '../draft';
import { buildPlannerToolsWithStatus, type PlannerArea, type PlannerDeps, type PlannerSeed } from './tools';
import { plannerSystemPrompt, plannerUserPrompt } from './prompt';

export interface PlannerPhaseInput extends Omit<RunAgentOptions, 'systemPrompt' | 'userPrompt' | 'tools' | 'completion'> {
  form: GenerateForm;
  draft: DraftTrip;
  areas: readonly PlannerArea[];
  searchArea: PlannerDeps['searchArea'];
  webSearch: PlannerDeps['webSearch'];
  onDayPlanned?: PlannerDeps['onDayPlanned'];
}

export async function runPlannerAgent(input: PlannerPhaseInput): Promise<{ result: RunAgentResult; submitted: boolean }> {
  const status = buildPlannerToolsWithStatus({
    form: input.form, draft: input.draft, areas: input.areas,
    searchArea: input.searchArea, webSearch: input.webSearch, signal: input.signal,
    ...(input.onDayPlanned ? { onDayPlanned: input.onDayPlanned } : {}),
  });
  const result = await runPhaseAgent({
    model: input.model,
    apiKey: input.apiKey,
    signal: input.signal,
    sink: input.sink,
    maxTurns: input.maxTurns ?? 24,
    recorder: input.recorder,
    tools: status.tools,
    systemPrompt: plannerSystemPrompt(input.form),
    userPrompt: plannerUserPrompt(input.form),
    completion: {
      isComplete: () => status.isSubmitted(),
      reminder: '规划尚未提交。请用 plan_day 补齐每天的活动，确认 validate_plan 没有硬性违规后调用 submit_plan。',
      errorMessage: '规划未提交：模型没有完成逐日排点；请重试',
    },
  });
  return { result, submitted: status.isSubmitted() };
}

/** 从调研候选 + 知识库坐标构造片区种子（无效坐标直接丢弃）。 */
export function plannerSeeds(input: {
  candidates: readonly { id?: string; name: string; intro?: string; category?: string; openTime?: string; canonicalPlaceId?: string }[];
  pointOf(name: string, id?: string): { lat: number; lng: number } | undefined;
}): PlannerSeed[] {
  const seeds: PlannerSeed[] = [];
  const seen = new Set<string>();
  for (const candidate of input.candidates) {
    const name = candidate.name.trim();
    if (!name || seen.has(name)) continue;
    const point = input.pointOf(name, candidate.id);
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng) || (point.lat === 0 && point.lng === 0)) continue;
    seen.add(name);
    seeds.push({
      name, lat: point.lat, lng: point.lng,
      category: 'attraction',
      ...(candidate.intro ? { intro: candidate.intro } : {}),
      ...(candidate.openTime ? { openTime: candidate.openTime } : {}),
      ...(candidate.canonicalPlaceId ? { canonicalPlaceId: candidate.canonicalPlaceId } : {}),
    });
  }
  return seeds;
}
