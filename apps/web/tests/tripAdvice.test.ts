import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeSampleTrip, personalAdviceIsCurrent, tripAdviceInputSnapshot, type TripWeather, type ResearchPoi } from '@tripweaver/shared';
import { buildTripAdvice } from '../src/lib/tripAdvice';

test('advice uses only matching current weather and booked itinerary places', () => {
  const now = Date.parse('2026-10-04T04:00:00Z');
  const trip = { ...makeSampleTrip(), destination: '北京', startDate: '2026-10-04' };
  const weather: TripWeather = { destination: '北京', checkedAt: now, status: 'available', forecast: {
    city: '北京市', locationId: '101010100', reportTime: '2026-10-04 11:00:00', casts: [{ date: trip.startDate, dayWeather: '雷阵雨', nightWeather: '多云', dayTemp: 31, nightTemp: 19, dayWind: '北风', nightWind: '北风', dayPower: '4-5', nightPower: '≤3' }],
  } };
  const poi: ResearchPoi = { id: 'p1', name: '故宫', category: 'attraction', intro: '', reservation: 'required', sourceLinks: [] };
  const result = buildTripAdvice(trip, weather, new Map([['a', poi], ['b', poi]]), now);
  assert.ok(result.suggestions.some(item => item.id === 'rain' && item.text.includes('第 1 天')));
  assert.ok(result.suggestions.some(item => item.id === 'heat'));
  assert.ok(result.cautions.some(item => item.id === 'severe'));
  assert.equal(result.cautions.find(item => item.id === 'reservations')!.text.match(/故宫/g)?.length, 1);
  const far = buildTripAdvice({ ...trip, startDate: '2026-11-04' }, weather, new Map(), now);
  assert.ok(far.cautions.some(item => item.id === 'forecast-window'));
  assert.ok(far.suggestions.every(item => !['rain', 'heat', 'layers'].includes(item.id)));
  const unconfigured = buildTripAdvice(trip, { destination: '北京', checkedAt: now, status: 'not_configured' }, new Map(), now);
  assert.ok(unconfigured.cautions.some(item => item.id === 'weather-unconfigured'), 'no data source is told apart from a failed lookup');
  assert.equal(JSON.stringify(unconfigured).includes('稍后重试'), false, 'a missing data source must not be sold as retryable');
  assert.ok(!JSON.stringify(buildTripAdvice(trip, { ...weather, destination: '上海' }, new Map(), now)).includes('有雨雪预报'));
});

test('专属建议优先展示，天气另行补充；手动调整后隐藏旧建议并标记待更新', () => {
  const trip = makeSampleTrip();
  const activityIds = [trip.days[0]!.activities[0]!.id];
  trip.meta.advice = { version: 1, generatedAt: 1, inputSnapshot: tripAdviceInputSnapshot(trip),
    suggestions: [{ title: '专属建议', text: '第一站慢慢参观。', activityIds, sources: [] }],
    cautions: [{ title: '专属注意', text: '第一站预约需核实。', activityIds, sources: [] }] };
  const result = buildTripAdvice(trip, undefined, new Map());
  assert.equal(result.stale, false);
  assert.equal(result.suggestions[0]!.title, '专属建议');
  assert.ok(!result.suggestions.some(i => i.id === 'transport' || i.id === 'packing'));
  assert.ok(result.cautions.some(i => i.id.startsWith('weather-') || i.id === 'dates' || i.id === 'forecast-window'));
  const renamed = structuredClone(trip);
  renamed.id = 'new-version'; renamed.updatedAt++; renamed.title = '新标题'; renamed.days[0]!.title = '日标题';
  renamed.weather = { destination: trip.destination, checkedAt: 123, status: 'unavailable' };
  assert.ok(personalAdviceIsCurrent(renamed));
  for (const change of [
    (t: typeof trip) => { t.startDate = '2027-01-01'; },
    (t: typeof trip) => { t.days[0]!.activities.reverse(); },
    (t: typeof trip) => { t.days[0]!.activities.pop(); },
    (t: typeof trip) => { t.transportMode = 'drive'; },
    (t: typeof trip) => { t.extraNotes = '带孩子出行'; },
  ]) {
    const modified = structuredClone(trip); change(modified);
    const stale = buildTripAdvice(modified, undefined, new Map());
    assert.equal(stale.stale, true);
    assert.ok(!JSON.stringify(stale).includes('专属建议'));
    assert.ok(stale.suggestions.length > 0);
  }
});
