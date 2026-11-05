// 详情对话的路由判定：哪些消息交给 Agent。
// 抽成纯函数是为了让 eval 能直接断言分流，不必起 HTTP、数据库和模型。
export interface AgentRouteInput {
  /** 灰度开关（AGENT_DETAIL_CHAT === '1'） */
  enabled: boolean;
  /** 写工具是否开启（AGENT_WRITE_TOOLS !== '0'）：开启后「改行程」也交给 Agent */
  writes?: boolean;
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
  // 没有理解结果时直接进 Agent：它自己会先读行程再判断，
  // 比先跑一次意图理解更快（P1-b 之后理解层只作为可选快路径）。
  if (input.intent === undefined || input.intent === null) return true;
  if (input.intent === 'travel_qa' || input.intent === 'unclear') return true;
  // 修改意图：只有写工具开启时才接管；关闭时仍走确定性编辑链（P1 的只读边界）。
  if (input.intent === 'modify_itinerary') return input.writes === true;
  // update_brief / confirm 仍走原链路：它们要先更新 brief 再决定是否触发生成。
  return false;
}
