import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlaceIdentityIndex } from '../lib/placeIdentity';
import { validateWithdrawal } from '../services/placeAvailability';

function active(id: string, name = id, revision = 2) {
  return { id, name, city: '测试城', verified: true, payload: {
    identity: { version: 2, entityId: id, canonicalName: name, kind: 'same_entity', revision, memberIds: [id], memberNames: [name] },
    imageIdentity: { version: 1, mode: 'reviewed', entityId: id, revision, approved: [] },
    mentionSources: [{ mentionId: 1, noteId: 1, inputHash: 'a'.repeat(64) }],
  } };
}
function withdrawn(candidateIds: string[], revision = 2) {
  const place = active('old', '泛名', revision);
  return { ...place, verified: false, payload: { ...place.payload, mentionSources: [],
    identityWithdrawal: { version: 1, revision, reason: candidateIds.length ? 'split_source' : 'unavailable_source', candidateIds } } };
}

test('旧泛名与旧ID只给澄清候选，单候选仍有歧义；明确新ID保持独立', () => {
  for (const ids of [['a', 'b'], ['a'], []]) {
    const old = withdrawn(ids), a = active('a', '甲店'), b = active('b', '乙店');
    const index = createPlaceIdentityIndex([old, a, b]);
    assert.equal(index.groups.length, 2);
    for (const id of [undefined, 'old']) {
      const result = index.resolve(old.city, old.name, id);
      assert.equal(result.status, ids.length ? 'ambiguous' : 'unresolved');
      if (result.status === 'ambiguous') assert.deepEqual(result.candidates.map(p => p.id), ids);
      if (result.status === 'unresolved') assert.equal(result.reason, 'withdrawn');
    }
    assert.equal(index.resolve(old.city, '无关名称', old.id).status, 'unresolved');
    assert.equal(index.resolve(old.city, a.name, a.id).status, 'resolved');
    assert.equal(index.resolve(old.city, b.name, b.id).status, 'resolved');
    assert.equal(index.resolve('别城', old.name, old.id).status, 'unresolved');
    assert.deepEqual(index.resolve(old.city, '尚未收录地点'), { status: 'unresolved' });
  }
  const merged = active('a', '甲店');
  merged.payload.identity.memberIds.push('old');
  const old = withdrawn(['a']);
  const index = createPlaceIdentityIndex([merged, { ...old, payload: { ...old.payload, canonicalRedirectTo: 'a' } }]);
  assert.equal(index.resolve(old.city, merged.name, old.id).status, 'resolved', '后续明确同义合并才允许沿旧ID解析');
});

test('撤回不能携带旧事实；同版本只能缩减候选，恢复必须有更高版本和可用提及', () => {
  const old = withdrawn(['a', 'b']);
  validateWithdrawal(old);
  validateWithdrawal(withdrawn(['a']), old);
  assert.throws(() => validateWithdrawal(withdrawn(['a', 'b', 'c']), old), /扩大候选/);
  assert.throws(() => validateWithdrawal(active('old', '泛名'), old), /旧版本不能恢复/);
  assert.throws(() => validateWithdrawal({ ...active('old', '泛名', 3), payload: {
    ...active('old', '泛名', 3).payload, mentionSources: [] } }, old), /当前可用提及/);
  validateWithdrawal(active('old', '泛名', 3), old);
  for (const patch of [{ content: { intro: '旧混合介绍' } }, { themes: ['旧主题'] }, { mentionCount: 99 }, { coverImage: 'old.webp' }]) {
    assert.throws(() => validateWithdrawal({ ...old, payload: { ...old.payload, ...patch } }), /撤回契约无效/);
  }
  assert.throws(() => validateWithdrawal({ ...old, lat: 30, lng: 120 }), /撤回契约无效/);
  assert.throws(() => validateWithdrawal({ ...old, evidence: [{ content: '旧事实' }] }), /撤回契约无效/);
  assert.throws(() => validateWithdrawal(withdrawn(['old'])), /撤回契约无效/);
  assert.throws(() => validateWithdrawal({ ...active('a'), verified: false }), /缺少撤回声明/);
});
