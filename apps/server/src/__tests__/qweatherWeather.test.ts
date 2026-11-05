import assert from 'node:assert/strict';
import { test, mock, afterEach } from 'node:test';
import { makeSampleTrip, weatherForDate, WEATHER_FORECAST_DAYS, type TripWeather } from '@tripweaver/shared';
import { chinaTimestamp, createQWeatherLookup, parseQWeatherCity, parseQWeatherDaily } from '../integrations/qweather/weather';
import type { QWeatherAuth } from '../integrations/qweather/auth';
import type { qweatherRequest } from '../integrations/qweather/client';
import { getTripWeather } from '../services/tripWeatherService';

const now = Date.parse('2026-10-04T04:00:00Z');   // 中国时间 2026-10-04 12:00
const auth: QWeatherAuth = { mode: 'api-key', apiKey: 'test-key' };
type Daily = Record<string, unknown>;
const day = (date: string, patch: Daily = {}): Daily => ({ fxDate: date, textDay: '晴', textNight: '多云', tempMax: '0', tempMin: '-5', windDirDay: '北风', windDirNight: '北风', windScaleDay: '≤3', windScaleNight: '4-5', ...patch });
const series = (...dates: string[]) => ({ code: '200', updateTime: '2026-10-04T11:00+08:00', daily: dates.map(date => day(date)) });
afterEach(() => { mock.timers.reset(); });

test('forecast parsing normalizes update time and rejects illegal days instead of faking values', () => {
  const forecast = parseQWeatherDaily(series('2026-10-04', '2026-10-05'), '北京', '101010100')!;
  assert.equal(forecast.casts[0]!.dayTemp, 0);
  assert.equal(forecast.casts[0]!.nightTemp, -5);
  assert.equal(forecast.reportTime, '2026-10-04 11:00:00');
  assert.equal(forecast.locationId, '101010100');
  assert.equal(forecast.casts[0]!.dayWind, '北', 'the 「风」 suffix belongs to the display layer, not the contract');
  assert.equal(forecast.casts[0]!.dayPower, '≤3');
  assert.equal(chinaTimestamp('2021-11-15T16:35+08:00'), '2021-11-15 16:35:00');
  for (const patch of [{ tempMax: '' }, { tempMax: 'NaN' }, { tempMax: '100' }, { fxDate: '2026-02-30' }, { textDay: '' }, { textNight: 3 }]) {
    assert.equal(parseQWeatherDaily({ ...series('2026-10-04'), daily: [day('2026-10-04', patch)] }, '北京', '101010100'), null);
  }
  assert.equal(parseQWeatherDaily({ ...series('2026-10-04'), daily: [day('2026-10-04', { windScaleDay: [] })] }, '北京', '101010100')!.casts[0]!.dayPower, '', 'missing wind is emptied, not invented');
  assert.equal(parseQWeatherDaily({ ...series('2026-10-04'), daily: [day('2026-10-04'), day('2026-10-04')] }, '北京', '101010100'), null, 'duplicate dates');
  assert.equal(parseQWeatherDaily({ daily: series('2026-10-04').daily }, '北京', '101010100'), null, 'missing updateTime');
  assert.equal(parseQWeatherDaily({ ...series('2026-10-04'), updateTime: 'not-a-date' }, '北京', '101010100'), null);
  assert.equal(parseQWeatherDaily({ ...series('2026-10-04'), daily: [] }, '北京', '101010100'), null);
  assert.equal(parseQWeatherDaily(series('2026-10-04'), 'x'.repeat(61), '101010100'), null, 'city longer than the contract');
  const partial = parseQWeatherDaily({ ...series('2026-10-04', '2026-10-05', '2026-10-06'), daily: [day('2026-10-04'), day('2026-10-05', { tempMin: '' }), day('2026-10-06')] }, '北京', '101010100')!;
  assert.deepEqual(partial.casts.map(cast => cast.date), ['2026-10-04', '2026-10-06'], 'one bad day must not cost the whole 15-day forecast');
});

test('city search refuses to silently pick among same-named candidates', () => {
  assert.deepEqual(parseQWeatherCity({ code: '200', location: [{ id: '101010100', name: '北京' }, { id: '101010200', name: '海淀' }] }), { id: '101010100', name: '北京' });
  // 无 type/rank 可供消歧的同名候选：保持拒绝，绝不静默取第一条
  assert.equal(parseQWeatherCity({ location: [{ id: '1', name: '朝阳' }, { id: '2', name: '朝阳' }] }), null);
  // 11-03 实测 bug：「西安」市 vs 吉林辽源「西安」区，number=2 必然带回同名区县，须按 type/rank 消歧
  assert.deepEqual(
    parseQWeatherCity({ location: [
      { id: '101110101', name: '西安', type: 'city', rank: '11' },
      { id: '101060705', name: '西安', type: 'district', rank: '34' },
    ] }),
    { id: '101110101', name: '西安' },
  );
  // 同 type 且同 rank 的真歧义仍然拒绝
  assert.equal(parseQWeatherCity({ location: [
    { id: '1', name: '朝阳', type: 'city', rank: '20' },
    { id: '2', name: '朝阳', type: 'city', rank: '20' },
  ] }), null);
  assert.equal(parseQWeatherCity({ location: [] }), null);
  assert.equal(parseQWeatherCity({ location: [{ name: '北京' }] }), null);
  assert.equal(parseQWeatherCity({}), null);
});

test('calendar matching handles shuffled casts, China midnight, distant days and stale data', () => {
  const forecast = parseQWeatherDaily(series('2026-10-04', '2026-10-05'), '北京', '101010100')!;
  forecast.casts.reverse();
  const weather: TripWeather = { destination: '北京', checkedAt: now, status: 'available', forecast };
  const today = weatherForDate(weather, '北京', '2026-10-04', now);
  assert.equal(today.status, 'available');
  if (today.status === 'available') { assert.equal(today.cast.dayTemp, 0); assert.equal(today.distant, false); }
  assert.equal(weatherForDate(weather, '上海', '2026-10-04', now).status, 'unavailable');
  assert.equal(weatherForDate(weather, '北京', '2026-10-19', now).status, 'pending', `beyond the ${WEATHER_FORECAST_DAYS}-day window`);
  assert.equal(weatherForDate(weather, '北京', '2026-10-06', now).status, 'unavailable', 'inside the window but missing from casts');
  assert.equal(weatherForDate(weather, '北京', '2026-10-03', now).status, 'past');
  assert.equal(weatherForDate(weather, '北京', '', now).status, 'undated');
  assert.equal(weatherForDate(weather, '北京', '2026-02-30', now).status, 'undated');
  assert.equal(weatherForDate(weather, '北京', '2026-10-04', now + 3 * 3600_000).status, 'unavailable', 'stale snapshot');
  assert.equal(weatherForDate({ ...weather, forecast: { ...forecast, reportTime: '2026-10-01 11:00:00' } }, '北京', '2026-10-04', now).status, 'unavailable', 'stale report');
  const distant = parseQWeatherDaily(series('2026-10-04', '2026-10-10', '2026-10-11'), '北京', '101010100')!;
  const marked: TripWeather = { destination: '北京', checkedAt: now, status: 'available', forecast: distant };
  const distantAt = (date: string) => {
    const result = weatherForDate(marked, '北京', date, now);
    assert.equal(result.status, 'available');
    return result.status === 'available' && result.distant;
  };
  assert.equal(distantAt('2026-10-10'), false, 'day 7 is not yet "distant"');
  assert.equal(distantAt('2026-10-11'), true, 'day 8 and later is trend-only');
});

test('lookup coalesces concurrent calls, caches by credential and China date, recovers after failures', async () => {
  mock.timers.enable({ apis: ['Date'], now });
  const calls: string[] = [];
  const request: typeof qweatherRequest = async (host, path, params, credential, timeout) => {
    calls.push(path);
    assert.equal(host, 'fixture.qweatherapi.com');
    assert.equal(credential.mode, 'api-key');
    assert.ok(['test-key', 'other-key'].includes((credential as { apiKey: string }).apiKey), 'credential reaches the provider unchanged');
    assert.equal(timeout, 5000);
    if (path === '/geo/v2/city/lookup') {
      assert.equal(params.get('location'), '北京');
      return { code: '200', location: [{ id: '101010100', name: '北京' }] };
    }
    assert.equal(path, `/v7/weather/${WEATHER_FORECAST_DAYS}d`);
    assert.equal(params.get('location'), '101010100');
    return series('2026-10-04', '2026-10-05');
  };
  const lookup = createQWeatherLookup(request);
  const results = await Promise.all(Array.from({ length: 5 }, () => lookup('fixture.qweatherapi.com', auth, '北京')));
  assert.ok(results.every(Boolean));
  assert.deepEqual(calls, ['/geo/v2/city/lookup', '/v7/weather/15d']);
  await lookup('fixture.qweatherapi.com', auth, '北京');
  assert.equal(calls.length, 2, 'forecast cache serves the repeat visit');
  assert.ok(await lookup('fixture.qweatherapi.com', { mode: 'api-key', apiKey: 'other-key' }, '北京'));
  assert.equal(calls.length, 4, 'credentials never share a cache entry');
  mock.timers.setTime(now + 3600_001);
  await lookup('fixture.qweatherapi.com', auth, '北京');
  assert.equal(calls.length, 5, 'expired forecast refetches');
  assert.equal(calls.at(-1), '/v7/weather/15d', 'city lookup stays cached for 24h');
});

test('lookup failures are bounded, cached briefly and never leak upstream errors', async () => {
  mock.timers.enable({ apis: ['Date'], now });
  let fail = true;
  let count = 0;
  const lookup = createQWeatherLookup(async (_host, path) => {
    count++;
    if (path === '/geo/v2/city/lookup') return { code: '200', location: [{ id: '101010100', name: '北京' }] };
    if (fail) throw new Error('private-upstream-value');
    return series('2026-10-04');
  });
  assert.equal(await lookup('fixture.qweatherapi.com', auth, '北京'), null);
  assert.equal(await lookup('fixture.qweatherapi.com', auth, '北京'), null);
  assert.equal(count, 2, 'failure is cached for a minute');
  fail = false;
  mock.timers.setTime(now + 60_001);
  assert.ok(await lookup('fixture.qweatherapi.com', auth, '北京'));
  assert.equal(count, 3);
});

test('a slow upstream is abandoned at the deadline and its request is aborted', async () => {
  let aborted = false;
  const lookup = createQWeatherLookup(async (_host, _path, _params, _auth, _timeout, signal) => {
    await new Promise<void>(resolve => { signal!.addEventListener('abort', () => { aborted = true; resolve(); }); });
    throw new Error('aborted');
  }, 10);
  assert.equal(await lookup('fixture.qweatherapi.com', auth, '北京'), null);
  assert.equal(aborted, true);
  assert.equal(await createQWeatherLookup(() => new Promise(() => {}), 10)('fixture.qweatherapi.com', auth, '北京'), null);
});

test('undated, past and distant trips never resolve credentials or call upstream', async () => {
  mock.timers.enable({ apis: ['Date'], now });
  for (const startDate of ['', '2020-01-01', '2030-10-01']) {
    assert.equal((await getTripWeather({ ...makeSampleTrip(), startDate })).status, 'not_needed');
  }
});
