import type { Snapshot } from './contracts';
import { evaluationInput } from './input';

export interface SemanticVerdict { caseId: string; verdict: 'aligned' | 'mixed' | 'misaligned' | 'unverifiable'; reason: string; activityIds: string[] }
export function validateVerdicts(value: unknown, snapshots: Snapshot[]): SemanticVerdict[] {
  if (!Array.isArray(value) || value.length !== snapshots.length) throw new Error('语义审阅没有覆盖全部输入场景');
  const seen = new Set<string>();
  return value.map((row: unknown) => {
    if (!row || typeof row !== 'object') throw new Error('语义审阅格式错误');
    const r = row as Record<string, unknown>;
    const snapshot = snapshots.find((s) => s.caseId === r.caseId);
    if (!snapshot || seen.has(snapshot.caseId)) throw new Error('语义审阅用例 ID 无效或重复');
    seen.add(snapshot.caseId);
    const ids = new Set(snapshot.trip.days.flatMap((d) => d.activities.map((a) => a.id)));
    if (!['aligned','mixed','misaligned','unverifiable'].includes(String(r.verdict)) || typeof r.reason !== 'string' || !r.reason.trim()
      || !Array.isArray(r.activityIds) || r.activityIds.some((id) => typeof id !== 'string' || !ids.has(id))) throw new Error('语义审阅结论或证据引用无效');
    if (r.verdict !== 'unverifiable' && !r.activityIds.length) throw new Error('可判定结论必须引用当前行程活动');
    // 同组对照时模型可能在正文串用另一例的 ID；正文和结构化引用都必须校验。
    const inlineIds = r.reason.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? [];
    if (inlineIds.some((id) => !ids.has(id))) throw new Error('审阅正文引用了其他场景或不存在的活动 ID');
    const shortIds = (r.reason.match(/\b[0-9a-f]{8}\b/gi) ?? []).filter((id) => /[a-f]/i.test(id));
    if (shortIds.some((id) => ![...ids].some((full) => full.startsWith(id)))) throw new Error('审阅正文的活动 ID 缩写不属于当前场景');
    return { caseId: snapshot.caseId, verdict: r.verdict as SemanticVerdict['verdict'], reason: r.reason, activityIds: r.activityIds as string[] };
  });
}
export function reviewInput(snapshots: Snapshot[]) {
  return snapshots.map((s) => ({ caseId: s.caseId, form: evaluationInput(s.form),
    days: s.trip.days.map((d) => ({ day: d.dayIndex, activities: d.activities.map((a) => ({ id: a.id, name: a.name, category: a.category, description: a.description })),
      legs: d.legs?.map((l) => ({ from: l.fromActivityId, to: l.toActivityId, minutes: l.durationMin })) })),
    candidates: s.research?.candidates.map((p) => ({ name: p.name, category: p.category })) }));
}
