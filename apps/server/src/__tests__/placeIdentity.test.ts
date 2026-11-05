import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeNameKey, samePlaceReference, uniquePlaceReferences } from '@tripweaver/shared';
import { canonicalPlaceId, createPlaceIdentityIndex, type IdentityPlace } from '../lib/placeIdentity';
import { rankPlaces, type PlaceRow } from '../generation/retrievalRanking';

function row(id: string, name: string, aliases: string[] = [], extra: Partial<PlaceRow> = {}): PlaceRow {
  return { id, city: '济南', name, category: '自然', verified: true, source: 'xhs', lat: null, lng: null,
    payload: { aliases, identity: { version: 2, entityId: id, canonicalName: name, memberIds: [id], memberNames: [name, ...aliases], kind: 'same_entity', revision: 1 } }, ...extra };
}

test('文本清洗保留主体差异：分店、机构、出入口不能因删除后缀或括号变成同一地点', () => {
  assert.equal(placeNameKey(' ＵＣＣＡ '), 'ucca');
  for (const [a, b] of [['大明湖', '大明湖超然楼'], ['饭店（东店）', '饭店（西店）'], ['天安门', '天安门广场'], ['人民公园', '人民公园北门']]) {
    assert.notEqual(placeNameKey(a!), placeNameKey(b!));
  }
});

test('已确认别名在任意查询顺序下稳定返回相同 ID；不依赖同批次召回其他成员', () => {
  const lake = row('lake-stable', '大明湖', ['大明湖景区', '大明湖公园']);
  for (const names of [['大明湖景区', '大明湖'], ['大明湖', '大明湖公园']]) {
    for (const name of names) {
      const resolved = createPlaceIdentityIndex([lake]).resolve('济南', name);
      assert.equal(resolved.status, 'resolved');
      if (resolved.status === 'resolved') assert.equal(resolved.canonicalPlaceId, 'lake-stable');
    }
  }
  const renamed = row('lake-stable', '大明湖风景名胜区', ['大明湖', '大明湖景区']);
  assert.equal(canonicalPlaceId(renamed), canonicalPlaceId(lake));
});

test('同名不同实体保留歧义，明确 ID 可以消歧；跨城市 ID 和名称不串用', () => {
  const a = row('a', '人民公园', ['市民公园']);
  const b = row('b', '人民公园', ['市民公园']);
  const other = row('c', '人民公园', [], { city: '成都' });
  for (const records of [[a, b, other], [other, b, a]]) {
    const index = createPlaceIdentityIndex(records);
    assert.equal(index.resolve('济南', '人民公园').status, 'ambiguous');
    assert.equal(index.resolve('济南', '市民公园').status, 'ambiguous');
    const explicit = index.resolve('济南', '人民公园', 'b');
    assert.equal(explicit.status, 'resolved');
    if (explicit.status === 'resolved') assert.equal(explicit.canonicalPlaceId, 'b');
    assert.equal(index.resolve('济南', '人民公园', 'c').status, 'unresolved');
    assert.equal(index.resolve('成都', '人民公园').status, 'resolved');
  }
});

test('子地点不是同义词：仅检索意图允许成员名命中整体，事实查询不能借用整体', () => {
  const complex = row('complex', '天安门');
  complex.payload!.identity = { version: 2, entityId: complex.id, kind: 'complex', memberNames: ['天安门', '天安门城楼'] };
  const index = createPlaceIdentityIndex([complex]);
  assert.equal(index.resolve('济南', '天安门城楼').status, 'unresolved');
  assert.equal(index.resolve('济南', '天安门城楼', undefined, true).status, 'resolved');
  assert.equal(index.resolve('济南', '天安门').status, 'resolved');
});

test('旧 ID 指向主实体，错误引用、跨城重定向和重定向环不能解析成功', () => {
  const root = row('root', '大明湖', ['大明湖景区']);
  const old = row('old', '大明湖景区', [], { payload: { canonicalRedirectTo: 'root' } });
  assert.equal(createPlaceIdentityIndex([root, old]).resolve('济南', old.name, old.id).status, 'resolved');
  assert.equal(createPlaceIdentityIndex([root, old]).resolve('济南', '超然楼', old.id).status, 'unresolved');
  const crossCity = { ...root, city: '成都' };
  assert.equal(createPlaceIdentityIndex([crossCity, old]).resolve('济南', old.name, old.id).status, 'unresolved');
  const loop: IdentityPlace[] = [old, { ...root, payload: { canonicalRedirectTo: 'old' } }];
  assert.equal(createPlaceIdentityIndex(loop).resolve('济南', old.name, old.id).status, 'unresolved');
});

test('排名不将相近名称或相近坐标当作实体相等；同身份不同来源按 ID 合并', () => {
  const lake = row('lake', '大明湖');
  const tower = row('tower', '大明湖超然楼', [], { lat: 36.67, lng: 117.03 });
  const museum = row('museum', '大明湖博物馆', [], { lat: 36.67, lng: 117.03 });
  assert.equal(rankPlaces([lake, tower, museum], [], [], 8).length, 3);
  const legacy = row('legacy', '大明湖景区', [], { payload: { identity: { entityId: 'lake' } }, distance: 0.1 });
  const groups = rankPlaces([legacy, lake], [], [], 8);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.row.name, '大明湖');
  assert.equal(groups[0]?.row.distance, 0.1);
  assert.deepEqual(new Set(groups[0]?.ids), new Set(['legacy', 'lake']));
});

test('候选和活动的实例 ID 不影响实体判等，同名不同实体保留独立记录', () => {
  const a = { id: 'candidate1', name: '大明湖', canonicalPlaceId: 'lake' };
  const b = { id: 'candidate2', name: '大明湖景区', canonicalPlaceId: 'lake' };
  assert.equal(samePlaceReference(a, b), true);
  assert.equal(uniquePlaceReferences([a, b]).length, 1);
  assert.equal(uniquePlaceReferences([a, { ...a, id: 'candidate3', canonicalPlaceId: 'another-lake' }]).length, 2);
});
