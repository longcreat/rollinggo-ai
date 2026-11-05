// LLM 请求上下文快照（09-20）：生成流水线每次 API 请求的完整上下文落库（llm_request_logs）。
// 增强路径原则：记录失败只 console.warn，永不阻断生成（对齐 error-handling spec）。
// 快照天然不含 API key —— key 走 Agent 的 getApiKey 回调，不进 context。
import { eq } from 'drizzle-orm';
import { uid, type GenerationPhase } from '@tripweaver/shared';
import { db } from '../db/client';
import { llmRequestLogs } from '../db/schema';

export interface LlmRequestLogScope {
  jobId: string;
  userId: string;
  phase: GenerationPhase;
  round: number;
}

export interface LlmResponseSummary {
  stopReason?: string;
  usage?: { input: number; output: number };
  errorMessage?: string;
  text?: string;
}

export interface LlmRequestRecorder {
  /** 请求发出前落快照；返回行 id 供响应回写，失败返回 null（后续跳过回写） */
  recordRequest(input: {
    turn: number;
    model: string;
    systemPrompt: string;
    messages: unknown;
    tools: unknown;
  }): Promise<string | null>;
  /** 该 turn 的 assistant message_end 时回写响应摘要 */
  recordResponse(rowId: string, summary: LlmResponseSummary): Promise<void>;
}

export function createLlmRequestRecorder(scope: LlmRequestLogScope): LlmRequestRecorder {
  return {
    async recordRequest({ turn, model, systemPrompt, messages, tools }) {
      try {
        const id = uid();
        await db.insert(llmRequestLogs).values({
          id,
          jobId: scope.jobId,
          userId: scope.userId,
          phase: scope.phase,
          round: scope.round,
          turn,
          model,
          systemPrompt,
          messages,
          tools,
          createdAt: new Date(),
        });
        return id;
      } catch (err) {
        console.warn(`[llm-log] 请求快照落库失败（已跳过）：${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
    async recordResponse(rowId, summary) {
      try {
        await db.update(llmRequestLogs).set({ response: summary }).where(eq(llmRequestLogs.id, rowId));
      } catch (err) {
        console.warn(`[llm-log] 响应摘要回写失败（已跳过）：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
