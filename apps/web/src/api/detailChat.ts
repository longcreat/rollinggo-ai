import { Value } from '@sinclair/typebox/value';
import { ChatStreamEventSchema, SendMessageResultSchema, TripOperationResultSchema, type ChatStreamEvent, type DetailChatRequest, type SendMessageResult, type AddFoodRequest, type TripOperationRequest } from '@tripweaver/shared';
import { api, ApiError, requestStream } from './client';

/** POST SSE 支持跨 chunk 的 UTF-8 与帧边界；校验、按序去重、EOF 必须有终态。 */
export async function streamChat(id: string, input: DetailChatRequest, signal: AbortSignal, onEvent: (event: ChatStreamEvent) => void): Promise<SendMessageResult> {
  const response = await requestStream(`/api/conversations/${id}/messages/stream`, input, { signal, timeoutMs: 180_000 });
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
        if (!Value.Check(ChatStreamEventSchema, event) || event.requestId !== input.requestId) throw new Error('回答数据格式无效');
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
    if (signal.aborted) throw signal.reason;
    if (error instanceof TypeError) throw new ApiError(0, '回答中断，请检查网络后重试', null, 'network_error');
    throw error;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function recoverChat(id: string, requestId: string) {
  const data = await api.get<{ result: unknown }>(`/api/conversations/${id}/operations/${requestId}`);
  return Value.Check(SendMessageResultSchema, data.result) ? data.result : null;
}
export async function stopChat(id: string, requestId: string) {
  await api.post(`/api/conversations/${id}/operations/${requestId}/stop`);
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
