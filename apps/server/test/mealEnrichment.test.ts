// 餐次充实测试：锚点识别、2km 约束、闭馆日约束、真实候选不动。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GenerateForm, PoiCategory } from '@tripweaver/shared';
import { DraftTrip } from '@tripweaver/agent/generation/draft';
import { enrichMealAnchors } from '@tripweaver/agent/generation/mealEnrichment';
import type { PoiSource, SourcedPoi } from '@tripweaver/integrations/geoContracts';

const ANCHOR_DESC = '就近就餐的片区锚点；具体门店、价格与营业情况请到大众点评或美团确认。';

function form(startDate: string): GenerateForm {
  return {
    destination: '成都', startDate, days: 2, pace: '舒适', partySize: 2,
    preferences: [], constraints: [], extraNotes: '', transportMode: 'transit',
  } as unknown as GenerateForm;
}

function draftWith(startDate: string, mealDesc: string, mealName = '午餐｜成都'): DraftTrip {
  const draft = new DraftTrip(form(startDate));
  draft.setSkeleton('成都两日', ['市区', '郊区']);
  draft.addActivity(1, {
    name: '人民公园', description: '喝茶', category: '文化',
    lat: 30.66, lng: 104.06, coordSource: 'geocoded', coordSystem: 'gcj02',
  });
  draft.addActivity(1, { name: mealName, description: mealDesc, category: '美食' });
  return draft;
}

function poiSource(hits: Partial<SourcedPoi>[]): PoiSource & { calls: string[] } {
  const calls: string[] = [];
  return {
    kind: 'amap',
    calls,
    searchPois: async (_category: PoiCategory, keyword: string) => {
      calls.push(keyword);
      return hits as SourcedPoi[];
    },
    selfCheck: async () => ({ configured: true, checked: true, ok: true, message: '' }),
  };
}

const restaurant = (over: Partial<SourcedPoi> = {}): SourcedPoi => ({
  name: '陈麻婆豆腐', type: '川菜', address: '青羊区西玉龙街', rating: '4.6', cost: '60',
  opentime: '', photoUrls: [], adcode: '510105', location: { lat: 30.669, lng: 104.06 },  // ≈1km
  ...over,
});

describe('enrichMealAnchors', () => {
  it('2km 内命中真实餐厅 → 替换锚点（名称/坐标/类目/说明）', async () => {
    const draft = draftWith('2026-12-01', ANCHOR_DESC);
    const poi = poiSource([restaurant()]);
    const result = await enrichMealAnchors({
      draft, poi, destination: '成都', startDate: '2026-12-01', signal: AbortSignal.timeout(5_000),
    });
    assert.equal(result.replaced, 1);
    assert.equal(result.notes.length, 1);
    const meal = draft.mutableDays()[0]!.activities[1]!;
    assert.equal(meal.name, '午餐｜陈麻婆豆腐');
    assert.equal(meal.category, '美食');
    assert.equal(meal.coordSource, 'geocoded');
    assert.ok(Math.abs(meal.lat! - 30.669) < 1e-9, '坐标应来自命中餐厅');
    assert.match(meal.description, /川菜/, '说明应含真实类型');
    assert.deepEqual(poi.calls, ['人民公园 美食'], '关键词应是邻居活动名 + 美食');
  });

  it('超过 2km 的餐厅不替换（保留锚点）', async () => {
    const draft = draftWith('2026-12-01', ANCHOR_DESC);
    const poi = poiSource([restaurant({ location: { lat: 30.9, lng: 104.1 } })]);   // ≈27km
    const result = await enrichMealAnchors({
      draft, poi, destination: '成都', startDate: '2026-12-01', signal: AbortSignal.timeout(5_000),
    });
    assert.equal(result.replaced, 0);
    assert.equal(result.kept, 1);
    assert.equal(draft.mutableDays()[0]!.activities[1]!.name, '午餐｜成都');
  });

  it('当天闭馆的餐厅不替换', async () => {
    // 2026-12-07 是周一
    const draft = draftWith('2026-12-07', ANCHOR_DESC);
    const poi = poiSource([restaurant({ opentime: '周一闭馆 逢周一休息' })]);
    const result = await enrichMealAnchors({
      draft, poi, destination: '成都', startDate: '2026-12-07', signal: AbortSignal.timeout(5_000),
    });
    assert.equal(result.replaced, 0);
    assert.equal(draft.mutableDays()[0]!.activities[1]!.description, ANCHOR_DESC);
  });

  it('已有真实候选的餐次（非锚点说明）不动', async () => {
    const draft = draftWith('2026-12-01', '老字号川菜馆，招牌麻婆豆腐。', '午餐｜陈麻婆豆腐');
    const poi = poiSource([restaurant({ name: '别的餐厅' })]);
    const result = await enrichMealAnchors({
      draft, poi, destination: '成都', startDate: '2026-12-01', signal: AbortSignal.timeout(5_000),
    });
    assert.equal(result.replaced, 0);
    assert.equal(result.kept, 1);
    assert.deepEqual(poi.calls, [], '不应为真实候选发搜索');
  });

  it('搜索上限生效：第 7 个锚点不再发请求', async () => {
    const draft = new DraftTrip(form('2026-12-01'));
    draft.setSkeleton('成都', Array.from({ length: 7 }, (_, i) => `第${i + 1}天`));
    for (let d = 1; d <= 7; d++) {
      draft.addActivity(d, { name: '人民公园', description: '喝茶', category: '文化', lat: 30.66, lng: 104.06, coordSource: 'geocoded', coordSystem: 'gcj02' });
      draft.addActivity(d, { name: '午餐｜成都', description: ANCHOR_DESC, category: '美食' });
    }
    const poi = poiSource([]);
    const result = await enrichMealAnchors({
      draft, poi, destination: '成都', startDate: '2026-12-01', signal: AbortSignal.timeout(5_000),
    });
    assert.equal(poi.calls.length, 6, '硬上限 6 次搜索');
    assert.equal(result.kept, 7);
  });

  it('搜索抛错 → 保留锚点，不中断生成', async () => {
    const draft = draftWith('2026-12-01', ANCHOR_DESC);
    const poi: PoiSource = {
      kind: 'amap',
      searchPois: async () => { throw new Error('上游 500'); },
      selfCheck: async () => ({ configured: true, checked: true, ok: false, message: '' }),
    };
    const result = await enrichMealAnchors({
      draft, poi, destination: '成都', startDate: '2026-12-01', signal: AbortSignal.timeout(5_000),
    });
    assert.equal(result.replaced, 0);
    assert.equal(draft.mutableDays()[0]!.activities[1]!.name, '午餐｜成都');
  });

  it('午餐与晚餐分别跟随紧邻的前置景点，杜绝跨城拉回早晨第1站', async () => {
    const draft = new DraftTrip(form('2026-12-01'));
    draft.setSkeleton('成都一日', ['市区']);
    // 0: 杜甫草堂 (早晨西区)
    draft.addActivity(1, { name: '杜甫草堂', description: '', category: '文化', lat: 30.66, lng: 104.028, coordSource: 'geocoded', coordSystem: 'gcj02' });
    // 1: 宽窄巷子 (上午中区)
    draft.addActivity(1, { name: '宽窄巷子', description: '', category: '文化', lat: 30.663, lng: 104.055, coordSource: 'geocoded', coordSystem: 'gcj02' });
    // 2: 午餐锚点
    draft.addActivity(1, { name: '午餐｜成都', description: ANCHOR_DESC, category: '美食' });
    // 3: 武侯祠 (下午南区)
    draft.addActivity(1, { name: '武侯祠', description: '', category: '文化', lat: 30.646, lng: 104.047, coordSource: 'geocoded', coordSystem: 'gcj02' });
    // 4: 晚餐锚点
    draft.addActivity(1, { name: '晚餐｜成都', description: ANCHOR_DESC, category: '美食' });

    const poi = poiSource([restaurant({ location: { lat: 30.663, lng: 104.055 } })]);
    await enrichMealAnchors({
      draft, poi, destination: '成都', startDate: '2026-12-01', signal: AbortSignal.timeout(5_000),
    });

    assert.equal(poi.calls.length, 2);
    assert.equal(poi.calls[0], '宽窄巷子 美食', '午餐应以宽窄巷子（紧邻前站）为中心，而不是杜甫草堂');
    assert.equal(poi.calls[1], '武侯祠 美食', '晚餐应以武侯祠（紧邻前站）为中心，而不是杜甫草堂');
  });
});
