// 每日景点密度：按节奏取上限，餐次/住宿/交通不计入 —— prompt 与草稿校验共用 DAILY_SIGHT_LIMITS。
import assert from 'node:assert/strict';
import test from 'node:test';
import type { GenerateForm } from '@rollinggo-trip/shared';
import { DraftTrip } from '@rollinggo-trip/agent/generation/draft';

function draftWith(pace: GenerateForm['pace'], sights: number, meals: number): DraftTrip {
  const form: GenerateForm = {
    destination: '北京', days: 1, startDate: '', budgetLevel: '舒适', totalBudget: 0,
    preferences: [], partySize: 2, extraNotes: '', pace,
  };
  const draft = new DraftTrip(form);
  draft.setSkeleton('密度测试', ['第一天']);
  for (let i = 0; i < sights; i += 1) {
    draft.addActivity(1, { name: `景点${i + 1}`, category: '文化', lat: 39.9 + i * 0.001, lng: 116.4 });
  }
  for (let i = 0; i < meals; i += 1) {
    draft.addActivity(1, { name: `餐${i + 1}`, category: '美食' });
  }
  return draft;
}

const densityProblems = (draft: DraftTrip) => draft.validate().filter((problem) => problem.includes('景点过多'));

test('密度按节奏取上限，餐次不计入景点数', () => {
  assert.deepEqual(densityProblems(draftWith('tight', 10, 2)), [], 'tight 上限 10：10 景点 + 2 餐不该误报');
  assert.deepEqual(densityProblems(draftWith('moderate', 8, 2)), [], 'moderate 上限 8：8 景点 + 2 餐不该误报');
  assert.equal(densityProblems(draftWith('relaxed', 7, 0)).length, 1, 'relaxed 上限 6：7 个景点应报');
  assert.equal(densityProblems(draftWith('tight', 11, 0)).length, 1, 'tight 上限 10：11 个景点应报');
});

test('未指定节奏时按 moderate 处理', () => {
  assert.deepEqual(densityProblems(draftWith(undefined, 8, 2)), []);
  assert.equal(densityProblems(draftWith(undefined, 9, 0)).length, 1);
});
test('草稿快照往返：结构/渲染/校验一致，且深拷贝互不影响', () => {
  const form: GenerateForm = {
    destination: '成都', days: 2, startDate: '2026-11-10', budgetLevel: '舒适', totalBudget: 0,
    preferences: ['文化'], partySize: 2, extraNotes: '', pace: 'moderate',
  };
  const draft = new DraftTrip(form);
  draft.setSkeleton('成都三日', ['第一天', '第二天']);
  draft.setLodging('春熙路');
  draft.addActivity(1, { name: '人民公园', category: '文化', lat: 30.66, lng: 104.06 });

  const snapshot = draft.toSnapshot();
  const restored = DraftTrip.fromSnapshot(form, snapshot);

  assert.deepEqual(restored.mutableDays(), draft.mutableDays());
  assert.equal(restored.render(), draft.render());
  assert.deepEqual(restored.validate(), draft.validate());

  // 修改原草稿不影响快照与恢复体（两边都是深拷贝）
  draft.mutableDays()[0]!.activities[0]!.name = '改过的公园';
  assert.equal(restored.mutableDays()[0]!.activities[0]!.name, '人民公园');
  assert.equal(snapshot.days[0]!.activities[0]!.name, '人民公园');
});
