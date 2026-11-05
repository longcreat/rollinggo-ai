import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Value } from '@sinclair/typebox/value';
import { makeSampleTrip, personalAdviceIsCurrent, PersonalTripAdviceSchema, TripSchema, type PersonalTripAdvice } from '@tripweaver/shared';
import { buildTripAdviceTool, prepareTripAdviceEvidence, runTripAdviceWriter, tripAdviceUserPrompt } from '../generation/tripAdvice';
import type { RetrievedPlace } from '../generation/placeRetrieval';
import type { RunAgentOptions } from '../generation/agents/runner';

const signal = () => new AbortController().signal;
const sample = () => {
  const trip = makeSampleTrip();
  trip.destination = '北京';
  trip.days[0]!.activities[0]!.name = '故宫';
  return trip;
};
const place = (overrides: Partial<RetrievedPlace> = {}): RetrievedPlace => ({
  id: 'palace', name: '故宫博物院', city: '北京', aliases: ['故宫'], category: '文化', verified: true, source: 'xhs', lat: null, lng: null,
  payload: { reservation: 'required', reservationNote: '提前实名预约', components: [{ name: '珍宝馆', reservation: 'required', reservationNote: '需预约购票' }] },
  evidence: [{ kind: 'xhs_warning', strength: 'weak', content: '有游客反馈步行较多', sourceUrl: 'https://example.com/palace' }], ...overrides,
});

test('最终入选活动按八名称分批检索；隔离城市、相似名和未入选候选，保留弱证据及分项范围', async () => {
  const trip = sample();
  trip.overview = [{ id: 'unused', name: '未入选景区', intro: '不能引用', category: 'attraction', reservation: 'required', sourceLinks: [] }];
  const calls: string[][] = [];
  const evidence = await prepareTripAdviceEvidence(trip, async (names, options) => {
    calls.push(names);
    assert.equal(options.vector, 'off');
    return [place(), place({ id: 'wrong-city', city: '上海' }), place({ id: 'unused', name: '故宫旁公园', aliases: [] })];
  }, signal());
  assert.deepEqual(calls.flat(), [...new Set(trip.days.flatMap(d => d.activities.map(a => a.name)))]);
  assert.ok(calls.every(c => c.length <= 8));
  assert.ok(evidence.some(e => e.strength === 'weak' && e.sources[0]?.url === 'https://example.com/palace'));
  assert.ok(evidence.some(e => e.kind.includes('分项') && e.text.includes('珍宝馆')));
  assert.ok(evidence.every(e => e.activityIds.length === 1 && e.activityIds[0] === trip.days[0]!.activities[0]!.id));
  assert.ok(!JSON.stringify(evidence).includes('故宫旁公园'));
  assert.ok(!JSON.stringify(evidence).includes('未入选景区'));
  const context = JSON.parse(tripAdviceUserPrompt(trip, evidence));
  assert.equal(context.finalItinerary.days[0].activities[0].name, '故宫');
});

test('知识库失败保留行程输入；取消停止后续批次；危险链接不进入引用', async () => {
  const trip = sample();
  assert.deepEqual(await prepareTripAdviceEvidence(trip, async () => { throw new Error('offline'); }, signal()), []);
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(prepareTripAdviceEvidence(trip, async () => { calls++; controller.abort(); return []; }, controller.signal));
  assert.equal(calls, 1);
  const evidence = await prepareTripAdviceEvidence(trip, async () => [place({ evidence: [{ kind: 'warning', strength: 'weak', content: '反馈', sourceUrl: 'javascript:alert(1)' }] })], signal());
  assert.ok(evidence.every(e => e.sources.length === 0));
});

test('工具原子拒绝假活动、假证据、跨地点证据和重复正文，再通过合法提交持久化来源', async () => {
  const trip = sample();
  const evidence = await prepareTripAdviceEvidence(trip, async () => [place()], signal());
  const activityId = trip.days[0]!.activities[0]!.id;
  let saved: PersonalTripAdvice | undefined;
  const readSaved = () => saved;
  const tool = buildTripAdviceTool(trip, evidence, value => { saved = value; });
  const item = { title: '宫苑慢行', text: '第1天游览故宫时按体力安排停留。', activityIds: [activityId], evidenceIds: [evidence[1]!.id] };
  const params = { suggestions: [item], cautions: [{ ...item, title: '预约核实', text: '故宫预约和分项参观要求请以官方最新信息为准。' }] };
  for (const patch of [{ activityIds: ['invented'] }, { evidenceIds: ['invented'] }, { activityIds: [trip.days[0]!.activities[1]!.id] }]) {
    await tool.execute('bad', { ...params, suggestions: [{ ...item, ...patch }] });
    assert.equal(saved, undefined);
  }
  await tool.execute('duplicate', { suggestions: [item], cautions: [item] });
  assert.equal(saved, undefined);
  const before = JSON.stringify(trip);
  const result = await tool.execute('valid', params);
  assert.ok(result.terminate);
  const submitted = readSaved();
  assert.ok(Value.Check(PersonalTripAdviceSchema, submitted));
  assert.equal(submitted.suggestions[0]!.sources[0]!.url, 'https://example.com/palace');
  assert.equal(JSON.stringify(trip), before, '建议工具不可修改活动结构');
  trip.meta.advice = submitted;
  assert.ok(Value.Check(TripSchema, JSON.parse(JSON.stringify(trip))), '保存/导出结构可完整往返');
  assert.ok(personalAdviceIsCurrent(trip));
});

test('撰写器要求工具提交并保留 token；失败或取消不暴露已写的半成品', async () => {
  const trip = sample();
  const options: Pick<RunAgentOptions, 'model' | 'apiKey' | 'signal' | 'sink'> = {
    model: { id: 'test', name: 'test', api: 'openai-completions', provider: 'test', baseUrl: 'http://127.0.0.1', reasoning: false,
      input: ['text'], contextWindow: 20000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    apiKey: 'test', signal: signal(), sink: { onThought() {}, onToolStart() {}, onToolEnd() {}, onUsage() {} },
  };
  for (const state of ['success', 'error', 'cancel', 'unsubmitted']) {
    const output = await runTripAdviceWriter(trip, [], options, async opts => {
      assert.equal(opts.maxTurns, 3);
      assert.equal(opts.completion?.isComplete(), false);
      assert.equal(opts.tools.length, 1);
      if (state !== 'unsubmitted') {
        const item = { title: '当天慢游', text: '结合第一天的安排留出休息时间。', activityIds: [trip.days[0]!.activities[0]!.id], evidenceIds: [] };
        await opts.tools[0]!.execute('test', { suggestions: [item], cautions: [{ ...item, text: '出发前核实第一站的预约要求。' }] });
        assert.equal(opts.completion?.isComplete(), true);
      }
      return { tokensIn: 120, tokensOut: 60, aborted: state === 'cancel', turnLimitExceeded: false, ...(state === 'error' ? { errorMessage: 'failed' } : {}) };
    });
    assert.equal(Boolean(output.advice), state === 'success');
    assert.equal(output.result.tokensIn, 120);
  }
});
