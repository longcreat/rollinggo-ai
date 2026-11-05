// 详情对话的路由判定：哪些消息交给 P1 只读 Agent。
// 抽成纯函数是为了让 eval 能直接断言分流，不必起 HTTP、数据库和模型。
export interface AgentRouteInput {
  /** 灰度开关（AGENT_DETAIL_CHAT === '1'） */
  enabled: boolean;
  /** 建议按钮 / 快捷追问：只读咨询，但走原来的建议链路，不进 Agent */
  isSuggestion: boolean;
  /** 美食卡片请求：走确定性检索，不进 Agent */
  food: boolean;
  /** 理解层要求先追问澄清 */
  clarification?: boolean;
  /** understandMessage 的意图；null/undefined 表示没有理解结果 */
  intent?: string | null;
}

export function shouldUseAgent(input: AgentRouteInput): boolean {
  if (!input.enabled || input.isSuggestion || input.food || input.clarification) return false;
  return input.intent === undefined || input.intent === null
    || input.intent === 'travel_qa' || input.intent === 'unclear';
}
