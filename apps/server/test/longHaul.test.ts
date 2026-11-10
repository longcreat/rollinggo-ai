// 单测：长途点距离情报的几何基元（medianCenter，node:test 经 tsx 运行）
// 覆盖：中位中心（奇/偶/空/单点）。标级逻辑由 longHaulFixer / geoSanity 的测试覆盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { medianCenter } from '@tripweaver/agent/generation/longHaul';

// ---------- medianCenter：lat/lng 各自独立取中位数 ----------

test('medianCenter 奇数个点：lat/lng 各取中间值（两轴独立）', () => {
  const c = medianCenter([
    { lat: 1, lng: 30 },
    { lat: 2, lng: 10 },
    { lat: 3, lng: 20 },
  ]);
  assert.deepEqual(c, { lat: 2, lng: 20 });
});

test('medianCenter 偶数个点：取中间两值均值', () => {
  const c = medianCenter([
    { lat: 4, lng: 40 },
    { lat: 1, lng: 10 },
    { lat: 3, lng: 30 },
    { lat: 2, lng: 20 },
  ]);
  assert.deepEqual(c, { lat: 2.5, lng: 25 });
});

test('medianCenter 空数组返回 null，单点返回自身', () => {
  assert.equal(medianCenter([]), null);
  assert.deepEqual(medianCenter([{ lat: 39.9, lng: 116.4 }]), { lat: 39.9, lng: 116.4 });
});
