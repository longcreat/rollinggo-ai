import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { LODGING_SENTINEL } from '@tripweaver/shared';
import { assessCoverage } from '../coverage';
import { EVAL_DIR, createManifest, reportMarkdown } from '../artifacts';
import { GOLDEN_CASES } from '../golden/cases';
import { parseReport, parseSnapshot } from '../contracts';
import { buildReport, evaluateCase } from '../runner';
import { currentFixture } from './currentFixture';

const gc = GOLDEN_CASES[0]!;
const load = () => parseSnapshot(JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'snapshots', `${gc.id}.json`), 'utf8')));

test('无时刻与可选日期/住宿符合当前功能，单点远郊交通不冒充 0', () => {
  const { trip } = load();
  trip.days = [trip.days[0]!];
  trip.days[0]!.activities = [trip.days[0]!.activities[0]!];
  for (const a of trip.days[0]!.activities) { a.startTime = ''; a.endTime = ''; delete a.cost; }
  delete trip.days[0]!.legs;
  delete trip.lodging;
  trip.startDate = '';
  const result = assessCoverage(trip, { ...gc.form, totalBudget: 8000 });
  assert.equal(result.metrics.timeCoverageRatio, 0);
  assert.equal(result.metrics['day.1.activityMinutes'], null);
  assert.equal(result.metrics['day.1.betweenActivityMinutes'], null);
  assert.equal(result.metrics['day.1.lodgingMinutes'], null);
  assert.ok(!Object.keys(result.metrics).some((key) => /budget|cost/i.test(key)));
  assert.ok(!result.limitations.some((s) => /预算|费用/.test(s)));
  assert.ok(result.limitations.some((s) => s.includes('日期')));
  assert.ok(result.limitations.some((s) => s.includes('不能据此认定全天交通为 0')));
});

test('完整时刻和实际路段按范围统计，缺路段则完整交通为 null', () => {
  const { trip } = load();
  trip.days = [trip.days[0]!];
  const day = trip.days[0]!;
  day.activities = day.activities.slice(0, 2);
  const [a, b] = day.activities;
  Object.assign(a!, { startTime: '09:00', endTime: '10:00' });
  Object.assign(b!, { startTime: '10:30', endTime: '11:30' });
  day.legs = [{ fromActivityId: a!.id, toActivityId: b!.id, durationMin: 20, distanceM: 1000, mode: 'walk', source: 'amap' },
    { fromActivityId: LODGING_SENTINEL, toActivityId: a!.id, durationMin: 10, distanceM: 500, mode: 'walk', source: 'amap' },
    { fromActivityId: b!.id, toActivityId: LODGING_SENTINEL, durationMin: 15, distanceM: 800, mode: 'walk', source: 'amap' }];
  let result = assessCoverage(trip, gc.form);
  assert.equal(result.metrics.timeCoverageRatio, 1);
  assert.equal(result.metrics.transferTimeCoverageRatio, 1);
  assert.equal(result.metrics['day.1.activityMinutes'], 120);
  assert.equal(result.metrics['day.1.betweenActivityMinutes'], 20);
  assert.equal(result.metrics['day.1.lodgingMinutes'], 25);
  day.legs = day.legs.slice(1);
  result = assessCoverage(trip, gc.form);
  assert.equal(result.metrics['day.1.betweenActivityMinutes'], null);
  assert.equal(result.metrics.routePairCoverageRatio, 0);
});

test('单例 full 标签与 live 文案准确，限制不会冒充采集 ERROR，旧报告仍兼容', () => {
  const snapshot = currentFixture(gc);
  snapshot.research = { candidates: [{ id: 'p', name: '测试点', category: 'attraction', intro: '', reservation: 'unknown', sourceLinks: [] }] };
  snapshot.timing = { phases: { 'research#1': 1, 'plan#1': 1, 'review#1': 1 }, totalMs: 3,
    tokensIn: 1, tokensOut: 1, providerCalls: { amap: 0, search: 0, xhs: 0 } };
  for (const d of snapshot.trip.days) for (const a of d.activities) { a.startTime = ''; a.endTime = ''; }
  const report = buildReport(createManifest([gc], 'live', 'full'), [evaluateCase(gc, snapshot, true).outcome], []);
  assert.equal(report.cases[0]!.status, 'PASS');
  assert.deepEqual(report.cases[0]!.unavailable, []);
  const markdown = reportMarkdown(report);
  assert.match(markdown, /单例（从 full 9 例中选择 1 例）/);
  assert.match(markdown, /本次执行了生成链路/);
  assert.ok(!markdown.includes('本次离线'));
  assert.match(markdown, /每日时间与交通覆盖/);
  assert.match(markdown, /不将未排时刻判成缺功能/);
  delete report.cases[0]!.limitations;
  assert.doesNotThrow(() => parseReport(report));
  report.manifest.mode = 'offline';
  assert.match(reportMarkdown(report), /本次离线重放/);
});

test('预算已经退出产品，旧费用字段不会影响覆盖结果', () => {
  const { trip } = load();
  const before = assessCoverage(trip, gc.form);
  for (const day of trip.days) {
    for (const a of day.activities) delete a.cost;
    day.activities[0]!.cost = 0;
  }
  const result = assessCoverage(trip, { ...gc.form, totalBudget: 8000 });
  assert.deepEqual(result, before);
});

test('周边与无坐标的目的地就餐区域均说明未核实门店', () => {
  const { trip } = load();
  trip.days = [trip.days[0]!];
  trip.days[0]!.activities = trip.days[0]!.activities.slice(0, 2);
  const [lunch, dinner] = trip.days[0]!.activities;
  Object.assign(lunch!, { category: '美食', name: '午餐｜八达岭长城周边', description: '就近就餐的片区锚点；具体门店待定。' });
  Object.assign(dinner!, { category: '美食', name: '晚餐｜北京', description: '就近就餐的片区锚点；具体门店待定。', lat: 0, lng: 0 });
  const result = assessCoverage(trip, gc.form);
  assert.equal(result.metrics.areaMealCount, 2);
  assert.ok(result.limitations.some((s) => s.includes('2 餐') && s.includes('实际步行距离')));
});
