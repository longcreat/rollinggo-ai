// 工具输出契约：不按字数截断内容（上下文交给 pi-durable compaction），也不丢命中条数。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchPlacesPayload, webSearchPayload } from '../chat/agent/tools';
import type { WebSearchHit } from '../integrations/websearch/searchSource';
import type { SourcedPoi } from '../integrations/geoContracts';

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

test('search_places：结果条数不裁剪', () => {
  const hits: SourcedPoi[] = Array.from({ length: 10 }, (_, i) => ({
    name: `测试地点 ${i}`,
    type: '川菜',
    address: '青羊区',
    rating: '4.6',
    cost: '',
    opentime: '',
    photoUrls: [],
    location: { lat: 30.67, lng: 104.05 },
    adcode: '510105',
  }));

  const payload = searchPlacesPayload(hits);
  assert.equal(payload.length, 10);
  assert.deepEqual(payload[9], {
    name: '测试地点 9', type: '川菜', address: '青羊区',
    lat: 30.67, lng: 104.05, opentime: '', rating: '4.6',
  });
});
