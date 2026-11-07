// Human-in-the-Loop 问题注册表：Agent 工具在 execute 中暂停，等待用户通过独立接口回答。
//
// 参考 dsh 的 timed ask_user / openclaw 的 phase machine：
// - 同一会话同时只允许一个问题批次（openclaw：a question is already pending）；
// - 问题有超时（默认 120s），超时后工具返回 pending 并结束本轮；
// - 用户回答后 Promise 在同一次 Agent run 内 resolve，模型拿到真实 tool result 继续；
// - 问题注册在进程内（单实例部署与现有 detail turn 锁一致）；GET pending 供刷新后恢复。
import { uid, type AgentQuestion, type AgentQuestionAnswer, type PendingQuestionView } from '@tripweaver/shared';

export type QuestionExpiryReason = 'timeout' | 'cancelled';

/** 默认 120s；HITL_QUESTION_TIMEOUT_MS 可覆盖（1s–10min），便于本地/运维调参。 */
export const QUESTION_TIMEOUT_MS = (() => {
  const value = Number.parseInt(process.env.HITL_QUESTION_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(value) && value >= 1_000 ? Math.min(value, 10 * 60_000) : 120_000;
})();

interface PendingQuestionEntry {
  view: PendingQuestionView;
  userId: string;
  conversationId: string;
  requestId: string;
  resolve: (answers: AgentQuestionAnswer[] | null) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
  onAnswered: (questionId: string, answers: AgentQuestionAnswer[]) => void;
  onExpired: (questionId: string, reason: QuestionExpiryReason) => void;
}

const pending = new Map<string, PendingQuestionEntry>();

function byConversation(conversationId: string): PendingQuestionEntry | undefined {
  return [...pending.values()].find((entry) => entry.conversationId === conversationId);
}

function cleanup(entry: PendingQuestionEntry): void {
  clearTimeout(entry.timer);
  if (pending.get(entry.view.id) === entry) pending.delete(entry.view.id);
}

function settle(entry: PendingQuestionEntry, answers: AgentQuestionAnswer[] | null): void {
  if (entry.settled) return;
  entry.settled = true;
  cleanup(entry);
  entry.resolve(answers);
}

export interface HitlSession {
  ask(questions: AgentQuestion[], timeoutMs?: number): Promise<AgentQuestionAnswer[] | null>;
  hasPending(): boolean;
  cancel(): void;
}

export function createHitlSession(options: {
  userId: string;
  conversationId: string;
  requestId: string;
  signal: AbortSignal;
  onQuestion: (view: PendingQuestionView) => void;
  onAnswered: (questionId: string, answers: AgentQuestionAnswer[]) => void;
  onExpired: (questionId: string, reason: QuestionExpiryReason) => void;
}): HitlSession {
  let currentId: string | null = null;
  const cancel = () => {
    const entry = currentId ? pending.get(currentId) : undefined;
    if (!entry) return;
    currentId = null;
    options.onExpired(entry.view.id, 'cancelled');
    settle(entry, null);
  };
  options.signal.addEventListener('abort', cancel, { once: true });

  return {
    async ask(questions, timeoutMs = QUESTION_TIMEOUT_MS) {
      if (options.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const existing = byConversation(options.conversationId);
      if (existing) {
        throw Object.assign(new Error('已有待回答的问题，请先完成当前问题'), { statusCode: 409 });
      }
      const now = Date.now();
      const id = uid();
      currentId = id;
      const view: PendingQuestionView = {
        id,
        requestId: options.requestId,
        questions,
        createdAt: now,
        expiresAt: now + timeoutMs,
      };
      return await new Promise<AgentQuestionAnswer[] | null>((resolve) => {
        const entry: PendingQuestionEntry = {
          view,
          userId: options.userId,
          conversationId: options.conversationId,
          requestId: options.requestId,
          resolve,
          settled: false,
          timer: setTimeout(() => {
            if (entry.settled) return;
            if (currentId === id) currentId = null;
            options.onExpired(id, 'timeout');
            settle(entry, null);
          }, timeoutMs),
          onAnswered: options.onAnswered,
          onExpired: options.onExpired,
        };
        pending.set(id, entry);
        try {
          options.onQuestion(view);
        } catch {
          // SSE 已断开时问题仍保留，用户可通过 GET pending 恢复并回答。
        }
      });
    },
    hasPending() {
      return Boolean(byConversation(options.conversationId));
    },
    cancel,
  };
}

/** 用户回答：校验归属、题目 id 与选项，然后在原 Agent run 内 resolve。 */
export function answerPendingQuestion(input: {
  userId: string;
  conversationId: string;
  questionId: string;
  answers: AgentQuestionAnswer[];
}): { ok: true } | { ok: false; statusCode: number; message: string } {
  const entry = pending.get(input.questionId);
  if (!entry || entry.userId !== input.userId || entry.conversationId !== input.conversationId) {
    return { ok: false, statusCode: 404, message: '待回答问题不存在或已过期' };
  }
  if (entry.settled) return { ok: false, statusCode: 409, message: '该问题已回答或已过期' };
  if (Date.now() >= entry.view.expiresAt) {
    entry.onExpired(entry.view.id, 'timeout');
    settle(entry, null);
    return { ok: false, statusCode: 409, message: '问题已超时，请重新提问' };
  }
  const byId = new Map(input.answers.map((answer) => [answer.id, answer]));
  if (byId.size !== entry.view.questions.length) {
    return { ok: false, statusCode: 400, message: '回答数量与问题不一致' };
  }
  const normalized: AgentQuestionAnswer[] = [];
  for (const question of entry.view.questions) {
    const answer = byId.get(question.id);
    if (!answer) return { ok: false, statusCode: 400, message: `缺少问题「${question.question}」的回答` };
    const allowed = new Set(question.options.map((option) => option.label));
    if (answer.selected.some((value) => !allowed.has(value))) {
      return { ok: false, statusCode: 400, message: `问题「${question.question}」包含无效选项` };
    }
    if (!question.multiSelect && answer.selected.length > 1) {
      return { ok: false, statusCode: 400, message: `问题「${question.question}」只能选择一个选项` };
    }
    normalized.push({
      id: question.id,
      selected: [...answer.selected],
      ...(answer.custom?.trim() ? { custom: answer.custom.trim().slice(0, 300) } : {}),
    });
  }
  settle(entry, normalized);
  entry.onAnswered(entry.view.id, normalized);
  return { ok: true };
}

export function pendingQuestion(userId: string, conversationId: string): PendingQuestionView | null {
  const entry = byConversation(conversationId);
  return entry && entry.userId === userId && !entry.settled ? entry.view : null;
}

export function hasPendingQuestion(conversationId: string): boolean {
  return Boolean(byConversation(conversationId));
}

/** 回合结束/停止时兜底清理；用户已提交的 answer 不受影响。 */
export function cancelPendingQuestions(conversationId: string): void {
  for (const entry of [...pending.values()]) {
    if (entry.conversationId === conversationId) {
      entry.onExpired(entry.view.id, 'cancelled');
      settle(entry, null);
    }
  }
}

/**
 * 硬超时闸门（详情对话 5min 防模型挂死）：到点时若还有待回答的 HITL 问题则顺延 ——
 * 直接 abort 会把「用户已提交的答案」砍成 502。问题自身有超时兜底（QUESTION_TIMEOUT_MS），
 * settle（回答/超时）后下一次检查恢复判定。返回 clear 供回合结束清理。
 */
export function startHardTimeout(
  limitMs: number,
  hasPending: () => boolean,
  onTimeout: () => void,
): { clear(): void } {
  const deadline = Date.now() + limitMs;
  // 到点之后每 1s 复查，而不是再等一整个 limitMs：原实现跳过一 tick 后要再等一整段，
  // 实测能把 5min 硬超时拖到 ~10min。待答问题 settle 后最迟 1s 内触发。
  const timer = setInterval(() => {
    if (Date.now() < deadline) return;
    if (hasPending()) return;
    clearInterval(timer);
    onTimeout();
  }, Math.min(1_000, limitMs));
  return { clear: () => clearInterval(timer) };
}
