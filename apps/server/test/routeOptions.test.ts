import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeSampleTrip, wgs84ToGcj02, type RouteOptionsRequest } from '@tripweaver/shared';
import { queryRouteOptions } from '@tripweaver/services/routeOptions';
import type { GeoProvider } from '@tripweaver/integrations/geoProvider';

function input(): RouteOptionsRequest {
  const trip = makeSampleTrip();
  return { from: trip.days[0]!.activities[0]!, to: trip.days[0]!.activities[1]!, destination: trip.destination };
}
function provider(kind: 'amap' = 'amap'): GeoProvider {
  return { kind, enabled: true, budgetRemaining: async () => 100,
    geocodeActivity: async (_name, _city, acquire) => acquire() ? { lat: 39, lng: 116, adcode: '110000', origin: 'amap-geocode' } : null,
    createRouteBreaker: () => ({ isOpen: () => false, failStreak: () => 0,
      estimate: async (_from, _to, mode, opts, acquire) => {
        if (mode === 'transit' && kind === 'amap') assert.equal(opts.city1, '110000');
        return acquire() && mode !== 'cycle' ? { durationMin: 10, distanceM: 1000, polyline: '116,39;116.1,39.1' } : null;
      },
    }),
  };
}
test('four independent options preserve successful routes and source, failure is never heuristic', async () => {
  let calls = 0;
  const data = input();
  const result = await queryRouteOptions(data, provider(), () => { calls++; return true; });
  assert.equal(result.options.length, 4);
  assert.equal(calls, 6);
  assert.equal(result.options.filter((o) => o.status === 'available').length, 3);
  for (const option of result.options) if (option.status === 'available') {
    assert.equal(option.leg.source, 'amap');
    assert.equal(option.leg.fromActivityId, data.from.id);
  }
});
test('missing coordinates/provider and duplicate endpoints make no calls', async () => {
  const acquire = () => { throw new Error('unexpected call'); };
  const data = input();
  data.from.lat = data.from.lng = 0;
  assert.ok((await queryRouteOptions(data, provider(), acquire)).options.every((o) => o.status === 'unavailable'));
  const noProvider = { ...provider(), enabled: false };
  assert.ok((await queryRouteOptions(input(), noProvider, acquire)).options.every((o) => o.status === 'unavailable'));
  const pair = input(); pair.to = pair.from;
  assert.ok((await queryRouteOptions(pair, provider(), acquire)).options.every((o) => o.status === 'unavailable'));
});
test('legacy coordinates convert and all modes are attempted', async () => {
  const data = input(); delete data.from.coordSystem;
  const p = provider();
  const modes: string[] = [];
  p.createRouteBreaker = () => ({ isOpen: () => false, failStreak: () => 0,
    estimate: async (from, _to, mode) => {
      assert.deepEqual(from, wgs84ToGcj02(data.from.lat, data.from.lng)); modes.push(mode);
      return { durationMin: 5, distanceM: 1000 };
    },
  });
  await queryRouteOptions(data, p, () => true);
  assert.deepEqual(modes.sort(), ['cycle', 'drive', 'transit', 'walk']);
});
test('missing transit city does not fabricate a route', async () => {
  const p = provider(); p.geocodeActivity = async () => null;
  const result = await queryRouteOptions(input(), p, () => true);
  assert.ok(result.options.some((o) => o.status === 'unavailable' && o.mode === 'transit' && o.reason.includes('城市')));
});

test('single-mode selection queries only that mode and does not spend geocoding calls', async () => {
  const data = { ...input(), mode: 'drive' as const };
  let calls = 0;
  const result = await queryRouteOptions(data, provider(), () => { calls++; return true; });
  assert.equal(result.options.length, 1);
  assert.equal(calls, 1);
  assert.equal(result.options[0]?.status, 'available');
});
