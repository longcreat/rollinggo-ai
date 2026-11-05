import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LegMode, RouteOptionsResponse } from '@tripweaver/shared';
import { recommendedRoute } from '../src/lib/recommendedRoute.ts';

const option = (mode: LegMode, distanceM: number, durationMin: number): RouteOptionsResponse['options'][number] => ({ status: 'available', leg: { fromActivityId: 'a', toActivityId: 'b', source: 'amap', mode, distanceM, durationMin } });
test('real walk through 1 km takes priority, longer walks compete by duration', () => {
  assert.equal(recommendedRoute([option('drive', 1300, 3), option('walk', 1000, 20)])?.mode, 'walk');
  assert.equal(recommendedRoute([option('walk', 1001, 20), option('transit', 1500, 8), option('drive', 1300, 3)])?.mode, 'drive');
});
test('partial availability and deterministic duration/distance ties', () => {
  assert.equal(recommendedRoute([{ status: 'unavailable', mode: 'walk', reason: '不可达' }, option('transit', 2000, 8)])?.mode, 'transit');
  assert.equal(recommendedRoute([option('drive', 2000, 8), option('cycle', 2000, 8)])?.mode, 'cycle');
  assert.equal(recommendedRoute([option('drive', 1500, 8), option('cycle', 2000, 8)])?.mode, 'drive');
  assert.equal(recommendedRoute([]), undefined);
  const estimated = option('walk', 500, 5);
  if (estimated.status === 'available') estimated.leg.source = 'heuristic';
  assert.equal(recommendedRoute([estimated]), undefined);
});
