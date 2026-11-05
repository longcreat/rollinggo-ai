// 工具定义助手：保留 parameters schema 的泛型推断，让 execute 的 params 拿到静态类型
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { TSchema } from 'typebox';

export function defineTool<T extends TSchema>(tool: AgentTool<T>): AgentTool {
  return tool as unknown as AgentTool;
}
