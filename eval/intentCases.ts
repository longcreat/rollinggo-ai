import assert from 'node:assert/strict';
import type { ChatMessage, PlanningBriefData, Trip } from '@tripweaver/shared';
import type { UnderstandOutcome } from '../apps/server/src/chat/understanding';

export interface IntentCase {
  id: string; path: 'detail' | 'understanding-module'; text: string; brief: PlanningBriefData;
  history?: ChatMessage[]; expected: string;
  check: (outcome: UnderstandOutcome, next: PlanningBriefData) => void;
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
export function palaceRestrictionRemoved(notes: string): boolean {
  return !/(?:不去|避开|不要去)故宫/.test(notes)
    || /(?:取消|不用考虑|不再保留)[^；。\n]{0,20}(?:不去|避开|不要去)故宫[^；。\n]{0,15}(?:限制|要求)/.test(notes);
}
export function intentCases(trip: Trip): IntentCase[] {
  const first = trip.days[0]!.activities[0]!;
  const base: PlanningBriefData = { destination: trip.destination, startDate: trip.startDate, days: trip.days.length,
    pace: 'moderate', partySize: 2, transportMode: 'transit', preferences: [], constraints: [], extraNotes: '不能吃辣，不去故宫博物院。' };
  const qa = (o: UnderstandOutcome, next: PlanningBriefData) => {
    assert.equal(o.intent, 'travel_qa'); assert.equal(o.editOps, null);
    assert.deepEqual(next, base, '只读咨询不能变更 Brief 或原备注');
  };
  const edit = (kind: string, day: number, target?: string) => (o: UnderstandOutcome, next: PlanningBriefData) => {
    assert.equal(o.intent, 'modify_itinerary'); assert.equal(o.editOps?.length, 1);
    const op = record(o.editOps![0]); assert.equal(op.kind, kind); assert.equal(op.dayIndex, day);
    if (target) assert.equal(op.activityId, target);
    assert.equal(next.extraNotes, base.extraNotes, '单个活动修改不能擦除备注');
  };
  // 上下文定位用例避免重复地点歧义；否则正确的去重追问会被误判为意图失败。
  const names = trip.days.flatMap((day) => day.activities.map((activity) => activity.name));
  const contextPlace = ['玉渊潭', '陶然亭', '龙潭'].find((name) => names.every((existing) => !existing.includes(name)));
  assert.ok(contextPlace, '北京意图 fixture 必须留有一个未安排的上下文添加目标');
  const history: ChatMessage[] = [
    { role: 'user', content: `帮我加一个${contextPlace}公园。` },
    { role: 'assistant', content: `想把${contextPlace}公园加到哪一天？第1天、第2天还是第3天？` },
  ].map((m, i) => ({ ...m, role: m.role as ChatMessage['role'], id: `history-${i}`, conversationId: 'intent-fixture', sequence: i + 1, createdAt: 1 }));
  const rows: IntentCase[] = [
    { id: 'notes-readonly-food', path: 'detail', brief: base, text: '考虑我的备注，附近有什么适合的午餐？先给建议，不要修改行程。', expected: 'travel_qa；不修改活动、Brief 或不辣/故宫备注', check: qa },
    { id: 'notes-readonly-history', path: 'detail', brief: base, text: '我更喜欢历史文化，先说说哪些现有景点符合，暂时不要修改。', expected: 'travel_qa；讨论偏好不自动改稿', check: qa },
    { id: 'notes-readonly-more-days', path: 'detail', brief: base, text: '如果多玩两天可以去哪？只讨论一下，先不要加天数。', expected: 'travel_qa；不追加日期', check: qa },
    { id: 'notes-readonly-nature', path: 'detail', brief: base, text: '我膝盖不好，这些景点哪些需要爬山？先解释，不要改行程。', expected: 'travel_qa；先解释，不删除或新增活动', check: qa },
    { id: 'notes-replace', path: 'detail', brief: base, text: `把第1天的${first.name}换成天坛公园，其他活动都不要动。`, expected: 'modify_itinerary；只替换指定活动 ID', check: (o,n) => { edit('replace_activity', 1, first.id)(o,n); assert.match(String(record(record(o.editOps![0]).activity).name), /天坛/); } },
    { id: 'notes-delete', path: 'detail', brief: base, text: `请删除第1天的${first.name}，不要替换，也不要重新生成。`, expected: 'modify_itinerary；只删除指定活动', check: edit('delete_activity', 1, first.id) },
    { id: 'notes-add', path: 'detail', brief: base, text: '请在第2天添加天坛公园，现有活动全部保留。', expected: 'modify_itinerary；第2天 add_activity', check: (o,n) => { edit('add_activity', 2)(o,n); assert.match(String(record(record(o.editOps![0]).activity).name), /天坛/); } },
    { id: 'notes-add-two-days', path: 'detail', brief: base, text: '在现有行程后再加两天，主要去公园看自然风景，保留原来所有日期和活动。', expected: 'modify_itinerary；add_days 从原末日+1开始，新增2天', check: (o,n) => { edit('add_days', trip.days.length + 1)(o,n); assert.equal((record(o.editOps![0]).days as unknown[]).length, 2); } },
    { id: 'notes-option-context', path: 'detail', brief: base, history, text: '第2天', expected: `结合上轮追问，在第2天添加${contextPlace}公园`, check: (o,n) => { edit('add_activity', 2)(o,n); assert.ok(String(record(record(o.editOps![0]).activity).name).includes(contextPlace)); } },
    { id: 'notes-explicit-regenerate', path: 'detail', brief: base, text: '请保留已有出行条件和备注，重新生成整个行程。', expected: 'confirm；明确重生成而非局部新增', check: (o,n) => { assert.equal(o.intent, 'confirm'); assert.equal(o.editOps, null); assert.equal(n.extraNotes, base.extraNotes); } },
    { id: 'notes-cancel-restriction', path: 'detail', brief: base, text: '只更新备注：取消之前不去故宫博物院的限制，不能吃辣仍然保留；暂时不要改动活动。', expected: 'update_brief；移除故宫禁忌，保留不辣要求且不改活动', check: (o,n) => { assert.equal(o.intent, 'update_brief'); assert.equal(o.editOps, null); assert.match(n.extraNotes ?? '', /(?:不能|不).*辣/); assert.ok(palaceRestrictionRemoved(n.extraNotes ?? ''), '不能继续保留故宫禁忌；明确取消语句也是合法自由文本'); } },
    { id: 'notes-change-diet', path: 'detail', brief: base, text: '只更新备注：我现在可以吃辣了，但花生过敏，必须避开花生；不去故宫的限制保留，不改行程活动。', expected: 'update_brief；取消不辣、保留故宫禁忌并记录花生要求', check: (o,n) => { assert.equal(o.intent, 'update_brief'); assert.equal(o.editOps, null); const effective = [n.extraNotes, ...n.constraints.map((c) => c.valueText)].join('；'); assert.match(effective, /花生/); assert.match(effective, /(?:不去|避开|不要去)故宫/); assert.doesNotMatch(effective, /不能吃辣|不吃辣|不要辣/); } },
    { id: 'notes-negated-regenerate', path: 'detail', brief: base, text: '不要重新生成，也不要修改，只告诉我现有安排有哪些问题。', expected: 'travel_qa；否定生成不触发 confirm', check: qa },
    { id: 'notes-place-question', path: 'detail', brief: base, text: '故宫和颐和园在历史文化上有什么区别？只是问问，不要加进行程。', expected: 'travel_qa；提到地点不自动新增或修改', check: qa },
  ];
  const constraint = (polarity: string, pattern: RegExp) => (o: UnderstandOutcome, next: PlanningBriefData) => {
    assert.equal(o.intent, 'update_brief'); assert.equal(o.editOps, null);
    assert.ok(next.constraints.some((c) => c.polarity === polarity && pattern.test(c.valueText)), `应识别 ${polarity} 约束 ${pattern}`);
    assert.equal(next.destination, base.destination); assert.equal(next.extraNotes, base.extraNotes);
  };
  rows.push(
    { id: 'extract-must', path: 'understanding-module', brief: base, text: '必须去颐和园。', expected: 'update_brief；require 颐和园', check: constraint('require', /颐和园/) },
    { id: 'extract-avoid', path: 'understanding-module', brief: base, text: '不要去八达岭长城。', expected: 'update_brief；avoid 八达岭长城', check: constraint('avoid', /八达岭/) },
    { id: 'extract-prefer', path: 'understanding-module', brief: base, text: '有空优先看看公园，不一定要去。', expected: 'update_brief；prefer 公园，不升级为 require', check: (o,n) => { constraint('prefer', /公园/)(o,n); assert.ok(!n.constraints.some((c) => c.polarity === 'require')); } },
    { id: 'extract-background', path: 'understanding-module', brief: base, text: '同行有个8岁孩子，只是告诉你这个背景，不代表要去儿童乐园。', expected: 'fact 同行孩子；不自动勾选亲子/要求游乐园', check: (o,n) => { constraint('fact', /孩子|儿童|8岁/)(o,n); assert.ok(!n.preferences?.includes('亲子')); assert.ok(!n.constraints.some((c) => ['prefer','require'].includes(c.polarity) && /乐园/.test(c.valueText))); } },
    { id: 'extract-diet', path: 'understanding-module', brief: base, text: '花生过敏，必须避开所有含花生的食物。', expected: 'require/avoid 过敏约束，不能降为普通喜好', check: (o,n) => { assert.equal(o.intent,'update_brief'); assert.ok(n.constraints.some((c) => ['require','avoid'].includes(c.polarity) && /花生/.test(c.valueText))); } },
    { id: 'remove-constraint', path: 'understanding-module', brief: { ...base, constraints: [{ id: 'avoid-palace', category: 'attraction_preference', polarity: 'avoid', valueText: '故宫博物院', evidenceSequence: 1 }] }, text: '之前避开故宫的限制不用考虑了。', expected: '移除明确取消的约束 ID', check: (o,n) => { assert.equal(o.intent,'update_brief'); assert.ok(!n.constraints.some((c) => c.id === 'avoid-palace')); } },
  );
  return rows;
}
