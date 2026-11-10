// 任务级 POI 记账：调研 / 片区 / 补餐共用统计，额度各自独立 —— 防止 amapCalls 少计、dataSources 漏标。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PoiSource, SourcedPoi } from '@tripweaver/integrations/geoContracts';
import { createTaskPoiGate, createTaskPoiSource, POI_MAX_PER_TASK, type TaskPoiStats } from '@tripweaver/integrations/poiTaskSource';
import { getNullPoiSource } from '@tripweaver/integrations/nullPoiSource';

const fixture: SourcedPoi = {
  name: '测试公园', type: '风景名胜;公园', address: '测试地址', rating: '', cost: '',
  opentime: '', photoUrls: [], location: { lat: 39.9, lng: 116.4 }, adcode: '110000',
};

function fakeSource(): PoiSource {
  return {
    kind: 'amap',
    async searchPois() { return [fixture]; },
    selfCheck: async () => ({ configured: true, checked: true, ok: true, message: '' }),
  };
}

describe('共享统计、独立额度', () => {
  it('多个包装源把调用计入同一份 stats', async () => {
    const stats: TaskPoiStats = { calls: 0, gotResults: false };
    const a = createTaskPoiSource(fakeSource(), { stats });
    const b = createTaskPoiSource(fakeSource(), { stats, maxCalls: 6 });
    await a.source.searchPois('attraction', '公园', '北京');
    await b.source.searchPois('food', '餐厅', '北京');
    assert.equal(stats.calls, 2);
    assert.equal(stats.gotResults, true);
  });

  it('额度按用途各自计数，互不挤占', async () => {
    const stats: TaskPoiStats = { calls: 0, gotResults: false };
    const a = createTaskPoiSource(fakeSource(), { stats, maxCalls: 2 });
    const b = createTaskPoiSource(fakeSource(), { stats, maxCalls: 2 });
    for (let i = 0; i < 3; i += 1) await a.source.searchPois('attraction', '公园', '北京');
    for (let i = 0; i < 3; i += 1) await b.source.searchPois('food', '餐厅', '北京');
    assert.equal(stats.calls, 4, '每个用途各放行 2 次，第三次被自己的额度挡住');
  });

  it('片区检索闸门也计入同一本账', async () => {
    const stats: TaskPoiStats = { calls: 0, gotResults: false };
    const gate = createTaskPoiGate(stats, 1);
    await gate(async () => [fixture]);
    const blocked = await gate(async () => { throw new Error('不该外呼'); });
    assert.equal(stats.calls, 1);
    assert.deepEqual(blocked, [], '超过额度直接回空数组，不外呼');
  });

  it('Null 源不计数', async () => {
    const stats: TaskPoiStats = { calls: 0, gotResults: false };
    const task = createTaskPoiSource(getNullPoiSource(), { stats });
    await task.source.searchPois('attraction', '公园', '北京');
    assert.equal(stats.calls, 0);
    assert.equal(stats.gotResults, false);
  });

  it('默认额度为 POI_MAX_PER_TASK', async () => {
    const task = createTaskPoiSource(fakeSource());
    for (let i = 0; i < POI_MAX_PER_TASK + 2; i += 1) await task.source.searchPois('attraction', '公园', '北京');
    assert.equal(task.stats.calls, POI_MAX_PER_TASK);
  });
});