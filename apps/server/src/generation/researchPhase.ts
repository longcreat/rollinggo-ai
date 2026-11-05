import type { GenerateForm } from '@tripweaver/shared';
import { runPhaseAgent, type RunAgentOptions } from './agents/runner';
import { buildResearchTools, type ResearchOutcome, type ResearchToolDeps } from './tools/researchTools';
import { formBrief, researchSystemPrompt } from './prompts';
import { renderRetrievedPlaces } from './researchContext';
import { isFoodFocused } from './mealPlanning';

type ResearchPhaseInput = Omit<RunAgentOptions, 'systemPrompt' | 'userPrompt' | 'tools'>
  & Omit<ResearchToolDeps, 'outcome' | 'destination' | 'foodSearch'>
  & { form: GenerateForm; context?: string };

/** 生成与对话追加共用调研工具、来源规则、提交协议；调用方负责排程和事务。 */
export async function runResearchPhase(input: ResearchPhaseInput) {
  const research: ResearchOutcome = { summary: '', pool: [], locations: new Map() };
  const places = input.verifiedPlaces ?? [];
  const foodSearch = isFoodFocused(input.form.preferences);
  const result = await runPhaseAgent({
    model: input.model, apiKey: input.apiKey, signal: input.signal, sink: input.sink,
    maxTurns: input.maxTurns ?? 16, recorder: input.recorder,
    completion: {
      isComplete: () => Boolean(research.summary) && research.pool.length > 0,
      reminder: '调研尚未成功提交。正文或 JSON 代码块不会写入候选池。请保留已有检索结果，通过真正的 submit_research 工具调用提交 candidates；已 add_candidate 入池的地点不用重复添加。根据工具反馈修正无效参数，提交成功后结束。不要再输出候选 JSON 正文。',
      errorMessage: '调研未成功调用 submit_research 提交候选，已停止生成；请重试或检查模型的工具调用能力',
    },
    systemPrompt: researchSystemPrompt({ searchWebMax: input.searchWebMax, pace: input.form.pace, foodSearch }),
    tools: buildResearchTools({ ...input, destination: input.form.destination, outcome: research, foodSearch }),
    userPrompt: `${formBrief(input.form)}\n\n${places.length
      ? `系统已预取以下已验证候选（只是备选，不必全部入选）。足够时直接一次 submit_research，candidates 只填 placeId 和 intro；名称、类别、预约与来源自动复用。只做地点筛选和短简介，不编排日程。只有缺地点或复杂偏好尚未满足时才补查。语义相似不能证明无障碍、无拥挤等硬条件。\n${renderRetrievedPlaces(places)}`
      : '系统预取未命中，请按知识库与外部来源降级流程调研。'}${input.context ? `\n\n追加调研范围：${input.context}` : ''}`,
  });
  return { research, result };
}
