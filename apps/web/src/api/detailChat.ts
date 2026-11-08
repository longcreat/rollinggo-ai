import { Value } from '@sinclair/typebox/value';
import { ChatStreamEventSchema, SendMessageResultSchema, TripOperationResultSchema, type AgentQuestionAnswer, type ChatStreamEvent, type DetailChatRequest, type PendingQuestionView, type PlanningTurnRequest, type SendMessageResult, type AddFoodRequest, type TripOperationRequest, type TripRewindRequest } from '@tripweaver/shared';
import { api, ApiError, requestStream } from './client';

/** POST SSE 支持跨 chunk 的 UTF-8 与帧边界；校验、按序去重、EOF 必须有终态。 */
async function readChatStream(response: Response, requestId: string, onEvent: (event: ChatStreamEvent) => void): Promise<SendMessageResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sequence = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      if (buffer.length > 256_000) throw new Error('回答数据过大');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const event: unknown = JSON.parse(data);
        if (!Value.Check(ChatStreamEventSchema, event) || event.requestId !== requestId) throw new Error('回答数据格式无效');
        if (event.sequence <= sequence) continue;
        if (event.sequence !== sequence + 1) throw new Error('回答数据不完整');
        sequence = event.sequence;
        onEvent(event);
        if (event.type === 'done') return event.result;
        if (event.type === 'error') throw new ApiError(409, event.error, null, event.code);
      }
      if (done) throw new Error('回答中断，已保留收到的内容');
    }
  } catch (error) {
    if (error instanceof TypeError) throw new ApiError(0, '回答中断，请检查网络后重试', null, 'network_error');
    throw error;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function streamChat(id: string, input: DetailChatRequest, signal: AbortSignal, onEvent: (event: ChatStreamEvent) => void): Promise<SendMessageResult> {
  // HITL 问题默认等待 120s，回答后模型还要继续生成；给整轮留足 5 分钟。
  const response = await requestStream(`/api/conversations/${id}/messages/stream`, input, { signal, timeoutMs: 300_000 });
  try {
    return await readChatStream(response, input.requestId, onEvent);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  }
}

/** 主 Agent 统一流式会话（行前与行中统一走 /messages/stream）。 */
export const streamPlanning = streamChat;
export async function recoverChat(id: string, requestId: string) {
  const data = await api.get<{ result: unknown }>(`/api/conversations/${id}/operations/${requestId}`);
  return Value.Check(SendMessageResultSchema, data.result) ? data.result : null;
}
export async function stopChat(id: string, requestId: string) {
  await api.post(`/api/conversations/${id}/operations/${requestId}/stop`);
}
/** HITL：回答 Agent 暂停时提出的问题；答案会回到同一回合的工具结果。 */
export async function answerQuestion(id: string, questionId: string, answers: AgentQuestionAnswer[]) {
  await api.post(`/api/conversations/${id}/questions/${questionId}/answer`, { answers });
}
/** HITL：刷新后拉回等待中的问题。 */
export async function pendingQuestion(id: string): Promise<PendingQuestionView | null> {
  const data = await api.get<{ question: PendingQuestionView | null }>(`/api/conversations/${id}/questions/pending`);
  return data.question;
}
export async function addFood(id: string, input: AddFoodRequest) {
  const data = await api.post<unknown>(`/api/conversations/${id}/food`, input);
  if (!Value.Check(TripOperationResultSchema, data)) throw new Error('添加结果无效');
  return data;
}
export async function restoreVersion(id: string, input: TripOperationRequest) {
  const data = await api.post<unknown>(`/api/trips/${id}/restore`, input);
  if (!Value.Check(TripOperationResultSchema, data)) throw new Error('恢复结果无效');
  return data;
}
/** 真正回退：删除 target 之后的版本，target 重新成为当前版本。 */
export async function rewindVersion(id: string, input: TripRewindRequest) {
  const data = await api.post<unknown>(`/api/trips/${id}/rewind`, input);
  if (!Value.Check(TripOperationResultSchema, data)) throw new Error('回退结果无效');
  return data;
}
