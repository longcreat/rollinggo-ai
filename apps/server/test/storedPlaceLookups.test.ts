// 单测：库内地点事实只提供高德图与坐标（11-05 图片链路收敛后）
// env 在模块加载时校验 MASTER_KEY，必须先备好环境再动态 import（同 geoPipeline.test.ts 的做法）。
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import type { PlaceFacts } from '@rollinggo-trip/agent/generation/scheduling/placeFacts';

process.env.MASTER_KEY = 'a'.repeat(64);

const { createStoredAmapPhotoLookup, createStoredPlaceLookups } = await import('@rollinggo-trip/agent/generation/storedPlaceLookups');
const { pool } = await import('@rollinggo-trip/core/db/client');
after(() => pool.end());

const facts = (extra: Partial<PlaceFacts> = {}): PlaceFacts => ({
  name: '虎跑公园', category: '自然', source: 'xhs', themes: [], aliases: ['虎跑泉'],
  amapPhoto: 'https://store.is.autonavi.com/showpic/hupao', lat: 30.21, lng: 120.13, ...extra,
});

test('库内高德图与坐标读取共用一次城市加载，别名同样命中', async () => {
  let loads = 0;
  const lookups = createStoredPlaceLookups('杭州', async (city) => {
    assert.equal(city, '杭州');
    loads++;
    return new Map([['虎跑公园', facts()], ['虎跑泉', facts()]]);
  });
  assert.equal(await lookups.amapPhotoFor('断桥残雪'), null);
  const [photo, point] = await Promise.all([lookups.amapPhotoFor(' 虎跑公园 '), lookups.pointFor('虎跑泉')]);
  assert.equal(photo, 'https://store.is.autonavi.com/showpic/hupao');
  assert.deepEqual(point, { lat: 30.21, lng: 120.13 });
  assert.equal(loads, 1, '两类并发读取应共用一次城市加载');
});

test('坐标缺失时返回 null，不返回脏值', async () => {
  const lookups = createStoredPlaceLookups('杭州', async () => new Map([['虎跑公园', facts({ lat: undefined, lng: undefined })]]));
  assert.equal(await lookups.pointFor('虎跑公园'), null);
  assert.equal(await lookups.amapPhotoFor('虎跑公园'), 'https://store.is.autonavi.com/showpic/hupao');
});

test('空城市/空名字不加载；空索引与不同城市互不污染', async () => {
  let loads = 0;
  const empty = async () => { loads++; return new Map<string, PlaceFacts>(); };
  assert.equal(await createStoredPlaceLookups(' ', empty).pointFor('西湖'), null);
  assert.equal(await createStoredPlaceLookups('杭州', empty).amapPhotoFor(' '), null);
  assert.equal(loads, 0);
  assert.equal(await createStoredPlaceLookups('北京', empty).amapPhotoFor('西湖'), null);
  assert.equal(loads, 1);
});

test('createStoredAmapPhotoLookup：城市为空直接返回 null，不查库', async () => {
  assert.equal(await createStoredAmapPhotoLookup('')('故宫'), null);
  assert.equal(await createStoredAmapPhotoLookup('   ')('故宫'), null);
});
