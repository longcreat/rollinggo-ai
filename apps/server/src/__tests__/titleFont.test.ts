import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { DraftTrip } from '../generation/draft';
import { missingTitleCharacters } from '../generation/titleFont';
import { titleFontSources } from '../generation/titleFont.generated';
import { buildDraftTools } from '../generation/tools/draftTools';

test('字符覆盖数据对应当前部署的全部手写字体分片', async () => {
  const directory = new URL('../../../web/public/fonts/handwriting/', import.meta.url);
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.woff2')).sort(), Object.keys(titleFontSources).sort());
  for (const [name, expected] of Object.entries(titleFontSources)) {
    assert.equal(createHash('sha256').update(await readFile(new URL(name, directory))).digest('hex'), expected,
      `${name} changed: run python scripts/generate-title-font-coverage.py`);
  }
});

test('悠然小楷补全原缺字，仍按码点去重返回未收录字符', () => {
  assert.deepEqual(missingTitleCharacters(['中轴宫苑漫步', '苑麓雍颐榭锣祈簋', '南麓泉塔听溪谷']), []);
  assert.deepEqual(missingTitleCharacters(['古罍听风', '罍𠮷🌄']), ['罍', '𠮷', '🌄']);
  assert.deepEqual(missingTitleCharacters([' 山林听溪谷 ', '北京 3 日']), []);
});

test('任一标题缺字时整批拒绝，改写后可提交且活动不变', async () => {
  const draft = new DraftTrip({ destination: '北京', days: 1, startDate: '', budgetLevel: '舒适',
    totalBudget: 0, preferences: [], partySize: 2, extraNotes: '' });
  draft.setSkeleton('原行程', ['第一天']);
  draft.addActivity(1, { name: '公园散步' });
  const before = draft.render();
  const activities = structuredClone(draft.mutableDays()[0]!.activities);
  const tool = buildDraftTools(draft).find((item) => item.name === 'update_titles')!;
  for (const params of [
    { title: '古罍听风', dayTitles: ['山林听溪谷'] },
    { title: '山林听溪谷', dayTitles: ['古罍听风'] },
  ]) {
    const result = await tool.execute('missing', params);
    assert.equal(result.details.isError, true);
    assert.match(JSON.stringify(result.content), /罍/);
    assert.equal(draft.render(), before);
  }
  const result = await tool.execute('revised', { title: '山林听溪谷', dayTitles: ['中轴宫苑漫步'] });
  assert.notEqual(result.details.isError, true);
  assert.equal(draft.title, '山林听溪谷');
  assert.equal(draft.mutableDays()[0]!.title, '中轴宫苑漫步');
  assert.deepEqual(draft.mutableDays()[0]!.activities, activities);
});

test('标题生成成功一次收口；缺字或数量错误不提交、不改草稿', async () => {
  const draft = new DraftTrip({ destination: '北京', days: 1, startDate: '', budgetLevel: '舒适',
    totalBudget: 0, preferences: [], partySize: 2, extraNotes: '' });
  draft.setSkeleton('原行程', ['第一天']);
  let submitted = 0;
  const tool = buildDraftTools(draft, 'plan', () => { submitted++; }).find((item) => item.name === 'update_titles')!;
  for (const params of [{ title: '古罍听风', dayTitles: ['公园漫步'] }, { title: '公园漫步', dayTitles: [] }]) {
    const result = await tool.execute('invalid', params);
    assert.equal(result.details.isError, true);
    assert.equal(result.terminate, undefined);
    assert.equal(submitted, 0);
    assert.equal(draft.title, '原行程');
  }
  const result = await tool.execute('valid', { title: '公园漫步', dayTitles: ['公园漫步'] });
  assert.equal(result.terminate, true);
  assert.equal(submitted, 1);
});
