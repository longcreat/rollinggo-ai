import type { FrozenData } from './frozenKnowledge';
import type { Snapshot } from './contracts';

type Place = FrozenData['places'][number];
const key = (city: string, name: string) => `${city}\0${name.trim()}`;
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
function aliases(p: Place): string[] {
  const identity = p.payload?.identity;
  const members = identity && typeof identity === 'object' ? (identity as Record<string, unknown>).memberNames : [];
  return [...new Set([p.name, ...strings(p.payload?.aliases), ...strings(members)])];
}
export function placeCoverage(data: FrozenData, snapshots: Snapshot[], excludedCities = ['云南']) {
  const rows = data.places.map((p) => ({ id: p.id, city: p.city, name: p.name, category: p.category, source: p.source,
    exclusion: excludedCities.includes(p.city) ? '用户排除城市' : !p.verified ? '未审核' : p.payload?.canonicalRedirectTo ? '重定向历史实体'
      : ['住宿', 'hotel'].includes(p.category) ? '住宿不作为景点候选' : null,
    candidateCases: [] as string[], selectedCases: [] as string[] }));
  const byId = new Map(rows.map((p) => [p.id, p]));
  const index = new Map<string, Set<string>>();
  for (const p of data.places) {
    if (!p.verified || p.payload?.canonicalRedirectTo) continue;
    for (const name of aliases(p)) { const k = key(p.city, name); const ids = index.get(k) ?? new Set<string>(); ids.add(p.id); index.set(k, ids); }
  }
  const unresolved: Array<{ caseId: string; phase: string; name: string; reason: string }> = [];
  const match = (city: string, name: string, caseId: string, phase: string) => {
    const ids = [...(index.get(key(city, name)) ?? [])];
    if (ids.length === 1) return ids[0]!;
    unresolved.push({ caseId, phase, name, reason: ids.length ? '同城名称/别名有歧义' : '无唯一名称/显式别名对应，或为合成餐区' });
    return null;
  };
  const cases = snapshots.map((s) => {
    const candidateIds = new Map<string, string>();
    const selected = new Set<string>();
    for (const p of s.research?.candidates ?? []) {
      const id = match(s.form.destination, p.name, s.caseId, 'candidate');
      if (!id) continue;
      candidateIds.set(p.id, id);
      const list = byId.get(id)!.candidateCases; if (!list.includes(s.caseId)) list.push(s.caseId);
    }
    const activities = s.trip.days.flatMap((d) => d.activities);
    for (const a of activities) {
      const name = a.name.replace(/^(?:早餐|午餐|晚餐)[｜|：:]\s*/, '');
      const id = candidateIds.get(a.id) ?? match(s.form.destination, name, s.caseId, 'selected');
      if (!id) continue;
      selected.add(id);
      const list = byId.get(id)!.selectedCases; if (!list.includes(s.caseId)) list.push(s.caseId);
    }
    return { caseId: s.caseId, city: s.form.destination, days: s.form.days, preferences: s.form.preferences, notes: s.form.extraNotes,
      candidateCount: s.research?.candidates.length ?? null, matchedCandidateIds: [...new Set(candidateIds.values())],
      selectedIds: [...selected], activityCount: activities.length,
      foodCount: activities.filter((a) => a.category === '美食').length,
      areaMealCount: activities.filter((a) => a.category === '美食' && /周边|附近|区域/.test(a.name)).length,
      categories: [...selected].reduce<Record<string, number>>((out, id) => { const category = byId.get(id)!.category; out[category] = (out[category] ?? 0) + 1; return out; }, {}) };
  });
  const cities = data.cities.map((city) => {
    const all = rows.filter((p) => p.city === city);
    const eligible = all.filter((p) => !p.exclusion);
    return { city, total: all.length, eligible: eligible.length, excluded: all.length - eligible.length,
      candidateCovered: eligible.filter((p) => p.candidateCases.length).length,
      selectedCovered: eligible.filter((p) => p.selectedCases.length).length,
      uncovered: eligible.filter((p) => !p.candidateCases.length && !p.selectedCases.length).length };
  });
  const preferenceComparisons = cases.filter((c) => c.caseId.startsWith('matrix-') && !c.caseId.endsWith('-none')).flatMap((variant) => {
    const baseline = cases.find((c) => c.city === variant.city && c.days === variant.days && c.caseId.endsWith('-none'));
    if (!baseline) return [];
    const attractions = (ids: string[]) => new Set(ids.filter((id) => !['美食', 'food', '住宿', 'hotel'].includes(byId.get(id)!.category)));
    const a = attractions(baseline.selectedIds), b = attractions(variant.selectedIds);
    const shared = [...a].filter((id) => b.has(id));
    const union = new Set([...a, ...b]);
    return [{ baseline: baseline.caseId, variant: variant.caseId, city: variant.city, days: variant.days,
      sharedIds: shared, baselineOnlyIds: [...a].filter((id) => !b.has(id)), variantOnlyIds: [...b].filter((id) => !a.has(id)),
      attractionJaccard: union.size ? shared.length / union.size : null }];
  });
  return { rows, cities, cases, preferenceComparisons, unresolved,
    method: '同城唯一名称/显式 aliases/memberNames 关联冻结库 ID；最终活动优先回溯候选运行 ID。不使用子串/距离猜测，不等同数据库真实召回轨迹或地点事实正确性。' };
}
