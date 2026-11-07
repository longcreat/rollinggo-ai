// Agent 工具能力策略（参考 work/harness 下 openclaw / dsh / opencode 的做法）：
// 主 Agent 拿全量工具；子 Agent 在**创建会话时**就只装配只读白名单，运行期不再靠拒绝。
//
// 这里用「工具名 → 能力」的单一事实源：新增写工具/交互工具时必须同步分类，
// 否则子代理配置校验会直接失败，避免悄悄把写能力带进子会话。
import type { ToolRegistration } from '@earendil-works/pi-durable';

/** 子代理唯一允许的工具集合：只读、无交互、无派生。 */
export const SUBAGENT_READ_ONLY_TOOL_NAMES = [
  'get_trip',
  'get_day',
  'search_places',
  'web_search',
  'get_weather',
] as const;

const readOnly = new Set<string>(SUBAGENT_READ_ONLY_TOOL_NAMES);

export type AgentToolRole = 'main' | 'subagent';

export function isReadOnlyTool(name: string): boolean {
  return readOnly.has(name);
}

/** 子代理配置校验：出现任何非只读工具立即失败，而不是静默过滤。 */
export function assertSubagentToolNames(names: readonly string[]): void {
  const forbidden = names.filter((name) => !isReadOnlyTool(name));
  if (forbidden.length) {
    throw new Error(`子代理只能使用只读工具，收到：${forbidden.join('、')}`);
  }
}

/**
 * 按角色选择工具：主 Agent 全量；子 Agent 只保留只读白名单。
 * 主 Agent 的写工具/交互工具永远不出现在子会话里（构造期收敛，参考 openclaw 的 finalizeAgentTools）。
 */
export function toolsForRole(tools: readonly ToolRegistration[], role: AgentToolRole): ToolRegistration[] {
  if (role === 'main') return [...tools];
  return tools.filter((tool) => isReadOnlyTool(tool.name));
}
