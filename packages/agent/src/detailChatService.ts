// 行程详情对话：详情页只有一套运行时——完整读写 Agent（harness）。
//
// 旧的理解层 / 确定性检索 / editOps / 只读降级链路已移除；这些能力现在都是主 Agent 的工具
// （search_places / web_search / search_food / add_activity / update_brief / delegate_task…）。
// 这里只保留准入：幂等、会话与行程绑定、乐观锁、额度，然后交给 runAgentAnswer。
import { Value } from '@sinclair/typebox/value';
import { SendMessageResultSchema, type DetailChatRequest, type SendMessageResult, type Trip } from '@rollinggo-trip/shared';
import { findConversationForTrip, getConversationDetail } from '@rollinggo-trip/services/conversationService';
import { assertLatestTrip, getTrip } from '@rollinggo-trip/services/tripService';
import { operationFingerprint, readOperation } from '@rollinggo-trip/services/detailOperationService';
import { runAgentAnswer, type DetailChatEmit } from './chat/agent/turn';
import type { LlmConfig } from '@rollinggo-trip/core/settingsService';

export async function prepareDetailChat(userId: string, conversationId: string, input: DetailChatRequest) {
  const fingerprint = operationFingerprint('chat', [conversationId, input]);
  const saved = await readOperation(userId, input.requestId, fingerprint);
  if (saved && Value.Check(SendMessageResultSchema, saved)) return { saved, fingerprint };
  const detail = await getConversationDetail(userId, conversationId);
  if (!detail) {
    throw Object.assign(new Error('会话不存在'), { statusCode: 404 });
  }

  let trip: Trip | null = null;
  const targetTripId = input.tripId ?? detail.latestTrip?.id;
  if (targetTripId) {
    if (await findConversationForTrip(userId, targetTripId) !== conversationId) {
      throw Object.assign(new Error('行程与会话不匹配'), { statusCode: 404 });
    }
    if (input.tripId) {
      await assertLatestTrip(userId, input.tripId, input.updatedAt);
    }
    trip = await getTrip(userId, targetTripId);
    if (!trip && input.tripId) {
      throw Object.assign(new Error('行程不存在'), { statusCode: 404 });
    }
    if (trip && input.dayId && !trip.days.some((day) => day.id === input.dayId)) {
      throw Object.assign(new Error('所选日期已变更'), { statusCode: 409 });
    }
  }
  // 对话额度不限量（测试环境）：原 429 闸门已移除，恢复点见 chatQuotaService.chatHasQuota 注释。
  return { detail, trip, fingerprint };
}

export async function runDetailChat(
  userId: string,
  conversationId: string,
  input: DetailChatRequest,
  cfg: LlmConfig,
  signal: AbortSignal,
  emit: DetailChatEmit,
): Promise<SendMessageResult> {
  signal.throwIfAborted();
  const prepared = await prepareDetailChat(userId, conversationId, input);
  if (prepared.saved) return prepared.saved;
  const { detail, trip, fingerprint } = prepared;
  return runAgentAnswer({ userId, conversationId, detail, trip, input, cfg, fingerprint, signal, emit });
}
