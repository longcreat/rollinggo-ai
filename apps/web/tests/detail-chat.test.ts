import assert from 'node:assert/strict';
import { test } from 'node:test';
import { foodAlreadyAdded, foodPositionProblem, foodTimes, makeSampleTrip, recommendedFoodPosition, type FoodCandidate } from '@tripweaver/shared';
import { useEditorStore } from '../src/store/editorStore';
import { streamChat } from '../src/api/detailChat';
import { mock } from 'node:test';

test('历史只读禁止活动和路线写入，保存回执不覆盖本地草稿', () => {
  const trip = makeSampleTrip();
  const state = () => useEditorStore.getState();
  state().load(trip); state().setReadOnly(true);
  const original = structuredClone(state().trip);
  state().updateMeta({ title: '不应生效' }); state().addDay(); state().deleteActivity(trip.days[0]!.id, trip.days[0]!.activities[0]!.id);
  assert.deepEqual(state().trip, original); assert.equal(state().revision, 0);
  state().setReadOnly(false); state().updateMeta({ title: '草稿' });
  state().acknowledgeSave(trip.id, { ...trip, updatedAt: trip.updatedAt + 1 });
  assert.equal(state().trip!.title, '草稿'); assert.equal(state().revision, 1); assert.equal(state().trip!.updatedAt, trip.updatedAt + 1);
  state().clear();
});

test('保存新版本保留等待期间的编辑、日期与路线任务，旧回执不覆盖新版本', () => {
  const trip = makeSampleTrip();
  const state = () => useEditorStore.getState();
  state().load(trip); state().setReadOnly(false);
  state().setDayFilter(2);
  state().moveActivity(trip.days[0]!.id, trip.days[0]!.activities[0]!.id, 'down');
  state().updateMeta({ title: '等待保存时继续输入的标题' });
  const revision = state().revision;
  const jobs = Object.values(state().routeReplans);
  const saved = { ...trip, id: 'saved-version', updatedAt: trip.updatedAt + 1 };
  state().acknowledgeSave(trip.id, saved);
  assert.equal(state().trip!.id, saved.id);
  assert.equal(state().trip!.title, '等待保存时继续输入的标题');
  assert.equal(state().dayFilter, 2);
  assert.equal(state().revision, revision);
  assert.equal(Object.keys(state().routeReplans).length, jobs.length);
  assert.ok(Object.values(state().routeReplans).every((job) => job.key.includes('saved-version') && !jobs.some((old) => old.id === job.id)));
  state().acknowledgeSave(trip.id, { ...trip, id: 'stale-version' });
  assert.equal(state().trip!.id, saved.id);
  state().clear();
});

test('POST 流跨 UTF-8 chunk、重复事件去重、缺终态不能成功', async () => {
  const message = { id: 'm', conversationId: 'c', role: 'user', content: '问', sequence: 1, createdAt: 1 };
  const result = { userMessage: message, replyMessage: { ...message, id: 'a', role: 'assistant', content: '中文回答', sequence: 2 }, brief: { status: 'submitted', data: { constraints: [] }, missingFields: [], updatedAt: 1 }, intent: 'travel_qa' };
  const envelope = { requestId: 'request-test', sequence: 1, type: 'accepted' };
  let frames = [envelope, envelope, { ...envelope, type: 'answer_delta', sequence: 2, text: '中文回答' }, { ...envelope, type: 'done', sequence: 3, result }];
  const mocked = mock.method(globalThis, 'fetch', async () => {
    const bytes = new TextEncoder().encode(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''));
    return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  });
  try {
    const input = { requestId: 'request-test', tripId: 'trip', updatedAt: 1, text: '问' };
    const seen: number[] = [];
    const answer = await streamChat('c', input, new AbortController().signal, (e) => seen.push(e.sequence));
    assert.equal(answer.replyMessage.content, '中文回答'); assert.deepEqual(seen, [1, 2, 3]);
    frames = frames.slice(0, -1);
    await assert.rejects(streamChat('c', input, new AbortController().signal, () => {}), /回答中断/);
  } finally { mocked.mock.restore(); }
});

test('餐饮重复以地点身份为准，过期锚点与午餐冲突可恢复，无时间轴不猜位置', () => {
  const trip = makeSampleTrip(); const day = trip.days[0]!;
  day.activities = day.activities.filter((a) => a.category !== '美食').map((a) => ({ ...a, startTime: '', endTime: '' }));
  const candidate: FoodCandidate = { id: 'c', poiKey: 'branch-1', tripId: trip.id, name: '测试餐厅一店', address: '', lat: 39.9, lng: 116.4, reason: '已核验位置', dayId: day.id, dayIndex: 1, nearby: '', sources: [{ title: '已验证地点库', url: '' }] };
  assert.equal(recommendedFoodPosition(trip, candidate), undefined);
  assert.match(foodPositionProblem(trip, candidate, { dayId: day.id, beforeActivityId: 'removed', meal: 'lunch' })!, /位置已变更/);
  day.activities.push({ ...day.activities[0]!, id: 'meal', name: candidate.name, poiKey: candidate.poiKey, category: '美食', description: '午餐' });
  assert.equal(foodAlreadyAdded(day, candidate)?.id, 'meal');
  assert.equal(foodAlreadyAdded(day, { ...candidate, poiKey: 'branch-2', name: '测试餐厅二店' }), undefined);
  assert.match(foodPositionProblem(trip, candidate, { dayId: day.id, meal: 'lunch' })!, /已安排用餐/);
  assert.equal(foodPositionProblem(trip, candidate, { dayId: day.id, meal: 'dinner' }), null);
  day.activities = day.activities.slice(0, 2);
  day.activities[0]!.endTime = '11:00'; day.activities[1]!.startTime = '13:00'; day.activities[1]!.endTime = '15:00';
  const position = { dayId: day.id, beforeActivityId: day.activities[1]!.id, meal: 'lunch' as const };
  assert.deepEqual(foodTimes(trip, candidate, position, 10, 10), { startTime: '11:10', endTime: '12:10' });
  assert.throws(() => foodTimes(trip, candidate, position, 40, 40), /交通后.*冲突/);
  assert.throws(() => foodTimes(trip, { ...candidate, openTime: '17:00-22:00' }, position), /营业时段/);
  const dinner = recommendedFoodPosition(trip, { ...candidate, meal: 'dinner', openTime: '17:00-22:00' });
  assert.equal(dinner?.meal, 'dinner');
  assert.equal(dinner?.beforeActivityId, undefined, '晚餐应安排在下午活动之后');
  assert.equal(recommendedFoodPosition(trip, { ...candidate, meal: 'lunch', openTime: '17:00-22:00' }), undefined);
});
