// 表单入口的恢复判定：已有运行任务 → 直接接管；参数一致 → 复用会话与 requestId 重发（服务端幂等）；
// 否则视为全新提交。抽成纯函数，便于单测。
const KEY = 'tw.planningEntry';

export interface PlanningEntry {
  conversationId: string;
  requestId: string;
  /** 提交时的查询串快照：参数变了就不能复用旧会话。 */
  params: string;
}

export type PlanningEntryAction = 'adopt' | 'resume' | 'fresh';

export function resolvePlanningEntry(input: {
  stored: PlanningEntry | null;
  params: string;
  runningJobId: string | null;
}): PlanningEntryAction {
  if (input.runningJobId) return 'adopt';
  if (input.stored && input.stored.params === input.params) return 'resume';
  return 'fresh';
}

export function readPlanningEntry(): PlanningEntry | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PlanningEntry>;
    if (typeof parsed.conversationId !== 'string' || typeof parsed.requestId !== 'string' || typeof parsed.params !== 'string') return null;
    return { conversationId: parsed.conversationId, requestId: parsed.requestId, params: parsed.params };
  } catch {
    return null;
  }
}

export function writePlanningEntry(entry: PlanningEntry): void {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(KEY, JSON.stringify(entry));
}

export function clearPlanningEntry(): void {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(KEY);
}
