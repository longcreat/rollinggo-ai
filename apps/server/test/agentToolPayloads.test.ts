// 工具输出契约：不按字数截断内容（上下文交给 pi-durable compaction），也不丢命中条数。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Trip } from '@rollinggo-trip/shared';
import { searchPlacesPayload, tripSnapshot, webSearchPayload } from '@rollinggo-trip/agent/chat/agent/tools';
import type { WebSearchHit } from '@rollinggo-trip/integrations/websearch/searchSource';
import type { SourcedPoi } from '@rollinggo-trip/integrations/geoContracts';

const LONG_SUMMARY = '预约说明：需提前三天在官方小程序实名预约，节假日名额紧张，现场不售票。'.repeat(40);

test('web_search：长摘要原样保留，6 条结果一条不少', () => {
  const hits: WebSearchHit[] = Array.from({ length: 6 }, (_, i) => ({
    title: `故宫预约攻略 ${i}`,
    url: `https://example.com/${i}`,
    summary: `${LONG_SUMMARY}#${i}`,
    siteName: 'example',
    datePublished: '2026-11-01',
  }));

  const payload = webSearchPayload(hits);
  assert.equal(payload.length, 6, '不能按条数裁剪');
  assert.ok(payload[0]!.summary.length > 1000, '摘要长度不应被压到几百字');
  assert.equal(payload[0]!.summary, hits[0]!.summary, '首条摘要必须逐字一致');
  assert.equal(payload[5]!.summary, hits[5]!.summary, '末条摘要也不能被裁掉');
  assert.equal(payload[0]!.date, '2026-11-01', '时效信息保留给模型判断新鲜度');
});

test('search_places：结果条数不裁剪，商业信息（人均/电话）一并给模型', () => {
  const hits: SourcedPoi[] = Array.from({ length: 10 }, (_, i) => ({
    name: `测试地点 ${i}`,
    type: '川菜',
    address: '青羊区',
    rating: '4.6',
    cost: '133.00',
    opentime: '周一至周日 11:00-14:00,17:00-20:30',
    tel: '028-64231923',
    photoUrls: [],
    location: { lat: 30.67, lng: 104.05 },
    adcode: '510105',
  }));

  const payload = searchPlacesPayload(hits);
  assert.equal(payload.length, 10);
  assert.deepEqual(payload[9], {
    name: '测试地点 9', type: '川菜', address: '青羊区',
    lat: 30.67, lng: 104.05, opentime: '周一至周日 11:00-14:00,17:00-20:30',
    rating: '4.6', cost: '133.00', tel: '028-64231923',
  });
});

test('行程快照：描述全文、费用、开放时间、通勤段与住宿都不裁剪', () => {
  const description = '这是一段很长的景点介绍，包含历史、看点与游览建议。'.repeat(20).slice(0, 500);
  const trip: Trip = {
    id: 't', title: '成都', destination: '成都', startDate: '2026-11-10', budgetLevel: '舒适', totalBudget: 3000,
    preferences: ['文化', '少走路'], partySize: 3, extraNotes: '带老人，节奏慢一点', transportMode: 'transit',
    lodging: { name: '春熙路某酒店', area: '锦江区' },
    days: [{
      id: 'd1', dayIndex: 1, title: '市区',
      lodging: { name: '宽窄巷子某客栈' },
      activities: [{
        id: 'a1', name: '人民公园', startTime: '09:00', endTime: '11:00', description,
        lat: 30.66, lng: 104.06, coordSource: 'geocoded', category: '文化', cost: 60,
        openTime: '06:00-22:00', sourceNotes: [],
      }],
      legs: [{ fromActivityId: 'a1', toActivityId: 'a2', mode: 'walk', durationMin: 12, distanceM: 800, source: 'heuristic' }],
    }],
    meta: { usedXhs: false, reviewNotes: [] }, createdAt: 1, updatedAt: 1,
  };

  const snapshot = tripSnapshot(trip);
  const day = snapshot.days[0]!;
  const activity = day.activities[0]!;
  assert.equal(activity.description, description, '500 字描述必须逐字保留');
  assert.equal(activity.description.length, 500);
  assert.equal(activity.cost, 60);
  assert.equal(activity.openTime, '06:00-22:00');
  assert.deepEqual(day.legs, [{ from: 'a1', to: 'a2', mode: 'walk', durationMin: 12, distanceM: 800 }]);
  assert.equal(day.lodging?.name, '宽窄巷子某客栈');
  assert.equal(snapshot.lodging?.name, '春熙路某酒店');
  assert.deepEqual(snapshot.preferences, ['文化', '少走路']);
  assert.equal(snapshot.extraNotes, '带老人，节奏慢一点');
  assert.equal(snapshot.partySize, 3);
  assert.equal(snapshot.totalBudget, 3000);
});
