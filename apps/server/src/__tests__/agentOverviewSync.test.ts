// Agent 新增活动后补 overview 候选：详情弹窗的图/简介/预约都靠它。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Trip } from '@tripweaver/shared';
import { createPlacePointCache } from '../chat/agent/placePoints';
import { syncOverviewWithActivities } from '../chat/agent/overviewSync';

function trip(): Trip {
  return {
    id: 't1', title: '成都四日', destination: '成都', startDate: '2026-11-08',
    budgetLevel: '舒适', totalBudget: 3000, preferences: [], partySize: 2, extraNotes: '',
    transportMode: 'transit',
    days: [{
      id: 'd1', dayIndex: 1, title: '都江堰一日',
      activities: [{
        id: 'a1', name: '都江堰景区', startTime: '', endTime: '', description: '看鱼嘴分水堤、飞沙堰与宝瓶口的千年水利工程',
        lat: 31.0026, lng: 103.6176, coordSource: 'geocoded', coordSystem: 'gcj02',
        category: '文化', openTime: '11-01至03-01 周一至周日 08:00-17:30', sourceNotes: [],
      }],
      legs: [],
    }],
    overview: [], meta: { usedXhs: false, reviewNotes: [] }, createdAt: 1, updatedAt: 1,
  };
}

describe('syncOverviewWithActivities', () => {
  it('新增活动补一条候选：简介用活动描述、类目映射、预约未知、带上官方图', () => {
    const points = createPlacePointCache();
    points.rememberPhotos('都江堰景区', ['https://store.is.autonavi.com/a.jpg', 'https://store.is.autonavi.com/b.jpg']);
    const next = syncOverviewWithActivities(trip(), points);
    const poi = next.overview?.[0];
    assert.ok(poi);
    assert.equal(poi.name, '都江堰景区');
    assert.equal(poi.category, 'attraction');
    assert.match(poi.intro, /鱼嘴分水堤/);
    assert.equal(poi.reservation, 'unknown');
    assert.equal(poi.openTime, '11-01至03-01 周一至周日 08:00-17:30');
    assert.equal(poi.coverUrl, 'https://store.is.autonavi.com/a.jpg');
    assert.equal(poi.photos?.length, 2);
  });

  it('已有同名候选不覆盖（调研简介更可靠）', () => {
    const base = trip();
    base.overview = [{
      id: 'p1', name: '都江堰景区', category: 'attraction', intro: '调研产出的完整介绍',
      reservation: 'required', reservationNote: '官方小程序预约', sourceLinks: [{ title: '官方', url: 'https://example.com' }],
    }];
    const next = syncOverviewWithActivities(base, createPlacePointCache());
    assert.equal(next.overview?.length, 1);
    assert.equal(next.overview?.[0]?.intro, '调研产出的完整介绍');
    assert.equal(next.overview?.[0]?.reservation, 'required');
  });

  it('没有图片时只补文字，不伪造 coverUrl', () => {
    const next = syncOverviewWithActivities(trip(), createPlacePointCache());
    assert.equal(next.overview?.[0]?.coverUrl, undefined);
    assert.equal(next.overview?.[0]?.photos, undefined);
  });

  it('美食/住宿映射到候选类目；括号分店名不重复补', () => {
    const base = trip();
    base.days[0]!.activities.push({
      id: 'a2', name: '陈麻婆豆腐（旗舰店）', startTime: '', endTime: '', description: '',
      lat: 30.66, lng: 104.03, coordSource: 'geocoded', coordSystem: 'gcj02', category: '美食', sourceNotes: [],
    });
    base.overview = [{ id: 'p2', name: '陈麻婆豆腐(旗舰店)', category: 'food', intro: '老字号', reservation: 'unknown', sourceLinks: [] }];
    const next = syncOverviewWithActivities(base, createPlacePointCache());
    assert.equal(next.overview?.filter((poi) => poi.name.includes('陈麻婆')).length, 1);
    assert.ok(next.overview?.some((poi) => poi.name === '都江堰景区'));
  });
});

describe('PlacePointCache 名称匹配护栏', () => {
  it('find：精确命中；包含匹配要求短侧 ≥2 字且不低于长侧一半，太悬殊不命中', () => {
    const points = createPlacePointCache();
    points.remember('人民公园东门', { lat: 30.66, lng: 104.06 });
    assert.deepEqual(points.find('人民公园东门'), { lat: 30.66, lng: 104.06 });
    assert.deepEqual(points.find('人民公园 东门'), { lat: 30.66, lng: 104.06 }, '空白归一化后精确命中');
    assert.deepEqual(points.find('人民公园'), { lat: 30.66, lng: 104.06 }, '4/6 过半命中');
    assert.equal(points.find('西湖'), null, '2/6 不足一半，宁缺勿错');
    assert.equal(points.find('完全不同的名字'), null);
  });

  it('findPhotos：同一护栏，避免「西湖」拿到「西湖醋鱼」的图', () => {
    const points = createPlacePointCache();
    points.rememberPhotos('都江堰景区正门', ['https://store.is.autonavi.com/a.jpg']);
    assert.deepEqual(points.findPhotos('都江堰景区'), ['https://store.is.autonavi.com/a.jpg']);
    assert.deepEqual(points.findPhotos('都江堰景区正门'), ['https://store.is.autonavi.com/a.jpg']);
    assert.deepEqual(points.findPhotos('都江堰'), [], '3/7 不足一半不命中');
    assert.deepEqual(points.findPhotos('无关节点'), []);
  });
});
