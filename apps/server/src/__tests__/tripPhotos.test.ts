import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Trip, ResearchPoi } from '@tripweaver/shared';
import { enrichTripPhotos } from '../services/tripPhotoService';

const poi = (name: string, extra: Partial<ResearchPoi> = {}): ResearchPoi => ({
  id: name, name, category: 'attraction', intro: '', reservation: 'unknown', sourceLinks: [], ...extra,
});
const trip = (overview?: ResearchPoi[]): Trip => ({
  id: 'old-trip', title: '杭州', destination: '杭州', startDate: '', budgetLevel: '舒适', totalBudget: 0,
  preferences: [], partySize: 2, extraNotes: '', days: [], meta: { usedXhs: false, reviewNotes: [] },
  createdAt: 10, updatedAt: 20, ...(overview ? { overview } : {}),
});
test('只补缺图景点，保留已有图片与相册，且不改原行程快照', async () => {
  const original = trip([poi('西湖'), poi('已有', { coverUrl: '/media/existing.jpg' }),
    poi('相册', { photos: [{ url: '/media/gallery.jpg' }] }), poi('餐厅', { category: 'food' }), poi('西湖')]);
  const before = structuredClone(original), calls: string[] = [];
  const url = 'https://store.is.autonavi.com/showpic/reviewed';
  const result = await enrichTripPhotos(original, async name => { calls.push(name); return { coverUrl: url, photos: [{ url }] }; });
  assert.deepEqual(calls, ['西湖'], '同名只查一次');
  assert.deepEqual(original, before, '只补响应，不写回历史版本');
  assert.equal(result.overview?.[0]?.coverUrl, url);
  assert.deepEqual(result.overview?.[0]?.photos, [{ url }]);
  assert.deepEqual(result.overview?.slice(1, 4), original.overview?.slice(1, 4));
  assert.equal(result.updatedAt, 20);
  assert.equal(result.days, original.days);
});
test('库内无高德图时保持空图，不阻塞读取', async () => {
  const original = trip([poi('西湖')]);
  assert.equal((await enrichTripPhotos(original, async () => null)).overview?.[0]?.coverUrl, undefined);
});
test('无概览的旧数据与查询失败仍可读取', async () => {
  const old = trip();
  assert.equal(await enrichTripPhotos(old, async () => { throw new Error('不应查询'); }), old);
  const original = trip([poi('西湖')]);
  assert.deepEqual(await enrichTripPhotos(original, async () => { throw new Error('unavailable'); }), original);
});
