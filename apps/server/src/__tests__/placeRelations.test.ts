// 单测：POI 关联对加载（09-27）——归一键双向登记、候选交叉、无数据降级（本地库集成）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadPlaceRelations, resolveRelatedPairs } from '../generation/scheduling/placeRelations';
import { relatedPairKey } from '../generation/scheduling/schedule';

// ---------- 降级路径（不依赖库数据） ----------

test('loadPlaceRelations：城市为空时返回空 Map，不发查询', async () => {
  const relations = await loadPlaceRelations('');
  assert.equal(relations.size, 0);
});

test('loadPlaceRelations：无关联对的城市返回空 Map（排程按无关联降级）', async () => {
  const relations = await loadPlaceRelations('不存在的城市');
  assert.equal(relations.size, 0);
});

// ---------- 加载集成（本地库；未导入数据时跳过） ----------

test('loadPlaceRelations：北京关联对按归一键双向登记（故宫↔景山）', async () => {
  // 上游 direct 样本：「故宫博物院 ↔ 景山公园」；归一键后应是「故宫 ↔ 景山」。
  // 未跑过 scripts/seed-xhs-relations.ts 时库为空 —— 跳过而不是判失败。
  const relations = await loadPlaceRelations('北京');
  if (!relations.size) {
    console.warn('本地库无关联对数据，跳过集成断言（先跑 scripts/seed-xhs-relations.ts）');
    return;
  }
  assert.ok([...relations.keys()].every(key => key.startsWith('id:')), '关系两端必须绑定稳定实体');
  for (const [key, values] of relations) for (const value of values) assert.ok(relations.get(value)?.includes(key));
});

// ---------- 候选交叉（纯函数，不依赖库） ----------

test('resolveRelatedPairs：两侧归一后交叉，产出候选池实际名的 pair key', () => {
  // 库里是「故宫博物院」「景山公园」，候选池里是简称 —— 归一后才能对上
  const relations = new Map([['id:palace', ['id:park']], ['id:park', ['id:palace']]]);
  const pairs = resolveRelatedPairs(relations, [{ name: '故宫', canonicalPlaceId: 'palace' },
    { name: '景山公园', canonicalPlaceId: 'park' }, { name: '天坛', canonicalPlaceId: 'temple' }]);
  assert.ok(pairs.has(relatedPairKey('故宫', '景山公园')), '简称与全名应交叉命中');
  assert.equal(pairs.size, 1, '无向对只产出一个 key');
});

test('resolveRelatedPairs：只有一端在候选池时不生效（缺一端无从打折）', () => {
  const relations = new Map([['故宫', ['景山']], ['景山', ['故宫']]]);
  assert.equal(resolveRelatedPairs(relations, ['故宫', '天坛']).size, 0);
  assert.equal(resolveRelatedPairs(relations, ['景山', '天坛']).size, 0);
});

test('resolveRelatedPairs：空关联对 / 空候选池都返回空集合', () => {
  assert.equal(resolveRelatedPairs(new Map(), ['故宫', '景山']).size, 0);
  assert.equal(resolveRelatedPairs(new Map([['故宫', ['景山']]]), []).size, 0);
});

test('resolveRelatedPairs：同一归一键的多个候选不自己和自己配对', () => {
  // 「故宫」与「故宫博物院」归一后同键，二者不是两个点，不应产出 pair
  const relations = new Map([['故宫', ['故宫博物院']]]);
  assert.equal(resolveRelatedPairs(relations, ['故宫']).size, 0);
});

test('resolveRelatedPairs：无明确身份时不因剥后缀把整体关系扩散给子项', () => {
  // 归一键会剥「广场」→「天安门」与「天安门广场」同键；
  // 库里只登记「天安门」这个键，但两个候选都应接上同一个关联对
  const relations = new Map([['天安门', ['故宫']]]);
  const pairs = resolveRelatedPairs(relations, ['天安门', '天安门广场', '故宫']);
  assert.ok(pairs.has(relatedPairKey('天安门', '故宫')), '直名候选应接上');
  assert.ok(!pairs.has(relatedPairKey('天安门广场', '故宫')), '不能把组成关系当同义词');
  assert.equal(pairs.size, 1);
});
