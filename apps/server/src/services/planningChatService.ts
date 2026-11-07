// 行前对话：表单入口的准入层（会话归属、幂等、已有行程则拒绝），然后交给主 Agent 的行前回合。
import { Value } from '@sinclair/typebox/value';
import { SendMessageResultSchema, type PlanningTurnRequest, type SendMessageResult } from '@tripweaver/shared';
import { getConversationDetail, latestConversationTrip } from './conversationService';
import { operationFingerprint, readOperation } from './detailOperationService';
import type { LlmConfig } from './settingsService';
import { runPlanningAnswer } from '../chat/agent/planningTurn';
import type { DetailChatEmit } from '../chat/agent/turn';

export async function preparePlanningChat(userId: string, conversationId: string, input: PlanningTurnRequest) {
  const fingerprint = operationFingerprint('planning', [conversationId, input]);
  const saved = await readOperation(userId, input.requestId, fingerprint);
  if (saved && Value.Check(SendMessageResultSchema, saved)) return { saved: saved as SendMessageResult, fingerprint };
  const detail = await getConversationDetail(userId, conversationId);
  if (!detail) throw Object.assign(new Error('会话不存在'), { statusCode: 404 });
  const trip = await latestConversationTrip(userId, conversationId);
  if (trip) {
    throw Object.assign(new Error('会话已有行程，请进行程内对话'), { statusCode: 409, code: 'trip_exists' });
  }
  return { detail, fingerprint };
}

export async function runPlanningChat(
  userId: string,
  conversationId: string,
  input: PlanningTurnRequest,
  cfg: LlmConfig,
  signal: AbortSignal,
  emit: DetailChatEmit,
): Promise<SendMessageResult> {
  signal.throwIfAborted();
  const prepared = await preparePlanningChat(userId, conversationId, input);
  if ('saved' in prepared) return prepared.saved as unknown as SendMessageResult;
  return runPlanningAnswer({
    userId,
    conversationId,
    detail: prepared.detail,
    input,
    cfg,
    fingerprint: prepared.fingerprint,
    signal,
    emit,
  });
}
