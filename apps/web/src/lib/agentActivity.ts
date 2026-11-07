// 处理过程时间线的纯函数：旧 summary 回退与步骤 upsert。
import type { AgentStep } from '@tripweaver/shared';

export type AgentActivityState = 'running' | 'stopped' | 'error' | 'completed';

/** 旧消息只有 summary 字符串；连续重复合并，并过滤历史里混入的保存提示。 */
export function stepsFromSummary(summary: readonly string[] | undefined): AgentStep[] {
  if (!summary?.length) return [];
  const steps: AgentStep[] = [];
  for (const raw of summary) {
    if (!raw || /^已保存为 v|^本轮问答已保存/.test(raw)) continue;
    const label = raw.replace(/^正在/, '').replace(/…$/, '').replace(/完成$/, '').trim();
    if (!label) continue;
    if (steps.at(-1)?.label === label) continue;
    steps.push({
      id: `legacy-${steps.length}`,
      name: label,
      label: label.slice(0, 40),
      status: 'done',
    });
  }
  return steps;
}

export function upsertAgentStep(steps: readonly AgentStep[], next: AgentStep): AgentStep[] {
  const index = steps.findIndex((step) => step.id === next.id);
  if (index < 0) return [...steps, next];
  const copy = [...steps];
  copy[index] = next;
  return copy;
}
