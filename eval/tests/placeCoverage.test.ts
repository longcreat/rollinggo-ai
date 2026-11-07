import assert from 'node:assert/strict';
import test from 'node:test';
import { placeCoverage } from '../placeCoverage';
import type { FrozenData } from '../frozenKnowledge';
import { currentFixture } from './currentFixture';
import { MATRIX_CASES } from '../scenarios';

test('地点覆盖按唯一城市/显式别名关联，不用子串、同名歧义或合成餐区虚增', () => {
  const place = (id: string, name: string, city = '北京', category = '文化', payload = {}) => ({ id, name, city, category, payload, verified: true,
    lat: null, lng: null, source: 'test', createdAt: '2026-10-05T00:00:00Z', embedding: null });
  const data: FrozenData = { version: 1, cities: ['北京', '云南'], vectors: { included: false, configuredModel: null, placeDimensions: null, evidenceDimensions: null },
    places: [place('palace','故宫博物院','北京','文化',{ aliases: ['故宫'] }), place('forest','奥林匹克森林公园'),
      place('ambiguous-1','同名店'), place('ambiguous-2','同名店'), place('hotel','测试酒店','北京','住宿'), place('yn','云南地点','云南'), place('new','从未涉及')], evidence: [], relations: [] };
  const snapshot = currentFixture(MATRIX_CASES[0]!);
  snapshot.research!.candidates = ['故宫','同名店','沈阳故宫','奥林匹克森林公园'].map((name,i) => ({ id: `poi-${i}`, name, category: 'attraction', intro: '', reservation: 'unknown', sourceLinks: [] }));
  snapshot.trip.days = [snapshot.trip.days[0]!];
  snapshot.trip.days[0]!.activities = [{ ...snapshot.trip.days[0]!.activities[0]!, id: 'poi-0', name: '故宫' },
    { ...snapshot.trip.days[0]!.activities[0]!, id: 'area', name: '午餐｜故宫周边', category: '美食' }];
  const result = placeCoverage(data, [snapshot]);
  assert.deepEqual(result.cases[0]!.selectedIds, ['palace']);
  assert.equal(result.rows.find((p) => p.id === 'palace')!.candidateCases.length, 1);
  assert.equal(result.rows.find((p) => p.id === 'forest')!.candidateCases.length, 1);
  assert.equal(result.rows.find((p) => p.id === 'ambiguous-1')!.candidateCases.length, 0);
  assert.equal(result.rows.find((p) => p.id === 'yn')!.exclusion, '用户排除城市');
  assert.equal(result.rows.find((p) => p.id === 'hotel')!.exclusion, '住宿不作为景点候选');
  assert.equal(result.cities[0]!.candidateCovered, 2);
  assert.equal(result.cities[0]!.selectedCovered, 1);
  assert.equal(result.cities[0]!.uncovered, 3);
  assert.equal(result.unresolved.length, 3);
});
