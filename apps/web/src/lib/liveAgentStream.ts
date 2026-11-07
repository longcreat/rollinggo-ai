// 直播播报模型：把生成时间线翻译成「阶段 → 一句话动作」，供 Agent 面板逐行渲染。
//
// 复用 lib/generationTimeline 的事件归并与 lib/generationToolCopy 的用户文案，
// 这里只做展示剪裁（阶段中文名、进行中/完成文案），不重复计时逻辑。
import type { ResearchPoi } from '@tripweaver/shared';
import type { PhaseBlock, TimelineModel } from './generationTimeline';
import { toolCopy } from './generationToolCopy';

const PHASE_LABEL: Record<PhaseBlock['phase'], string> = {
  research: '查找地点与资料',
  plan: '规划每日行程',
  review: '整理文案与建议',
};

export interface LiveLine {
  id: string;
  kind: 'thought' | 'tool';
  text: string;
  running: boolean;
  error: boolean;
}

export interface LivePhase {
  key: string;
  label: string;
  done: boolean;
  lines: LiveLine[];
}

export interface LiveStream {
  phases: LivePhase[];
  candidates: ResearchPoi[];
  /** 最近一条进行中的动作，用于顶部一句话状态 */
  active: LiveLine | null;
  terminal: TimelineModel['terminal'];
}

function toolLine(item: Extract<PhaseBlock['items'][number], { kind: 'tool' }>): LiveLine {
  const copy = toolCopy(item.tool);
  return {
    id: item.key,
    kind: 'tool',
    text: item.running ? `正在${copy}…` : item.isError ? `${copy}未完成` : `${copy}完成`,
    running: item.running,
    error: item.isError,
  };
}

function thoughtLine(item: Extract<PhaseBlock['items'][number], { kind: 'thought' }>, phaseKey: string): LiveLine {
  const text = item.text.trim().replace(/\s+/g, ' ');
  return {
    id: `${phaseKey}-${item.key}`,
    kind: 'thought',
    text: text.length > 160 ? `${text.slice(0, 160)}…` : text,
    running: false,
    error: false,
  };
}

/** 只保留最后的阶段与动作，避免长任务把面板刷爆；全文仍可在刷新后重放。 */
export function buildLiveStream(model: TimelineModel, maxLinesPerPhase = 8, maxCandidates = 12): LiveStream {
  const phases: LivePhase[] = model.phases.map((phase) => {
    const lines: LiveLine[] = [];
    for (const item of phase.items) {
      if (item.kind === 'tool') lines.push(toolLine(item));
      else if (item.kind === 'thought' && item.text.trim()) lines.push(thoughtLine(item, phase.key));
    }
    return {
      key: phase.key,
      label: PHASE_LABEL[phase.phase],
      done: phase.done,
      lines: lines.slice(-maxLinesPerPhase),
    };
  });
  const active = phases.flatMap((phase) => phase.lines).filter((line) => line.running).at(-1) ?? null;
  return {
    phases,
    candidates: model.candidates.slice(-maxCandidates),
    active,
    terminal: model.terminal,
  };
}
