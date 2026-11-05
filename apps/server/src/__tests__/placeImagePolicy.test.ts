import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IdentityPlace } from '../lib/placeIdentity';
import { imageGroups } from '../lib/imageGallery';
import { filterIdentityImages, validateImagePolicy } from '../services/placeImagePolicy';
import { resolveImageIdentities } from '../services/placeImageIdentity';

const sha = 'a'.repeat(64), inputHash = 'b'.repeat(64);
const binding = { imageKey: 'note_image:1', inputHash, sourceSha256: sha, assignmentRevision: 1, entityId: 'root' };
const root: IdentityPlace = { id: 'root', city: '重庆', name: '呼归石公交站对面', payload: {
  identity: { version: 2, revision: 2, entityId: 'root', canonicalName: '呼归石公交站对面', kind: 'same_entity',
    memberIds: ['root', 'old'], memberNames: ['呼归石公交站对面'] },
  imageIdentity: { version: 1, mode: 'reviewed', entityId: 'root', revision: 2, approved: [binding] },
} };
const photo = { key: `xhs/root/${sha}.webp`, provenance: { sourceSha256: sha, identityBinding: binding } };

test('旧ID兼容仍须逐图证据，错误文件与未经确认图片不得进入受控相册', () => {
  const groups = new Map([['old', [photo, { key: 'xhs/old/00.webp' }]]]);
  const result = resolveImageIdentities('重庆', groups, [root]);
  assert.deepEqual(result.get('root'), [photo]);
  assert.deepEqual(filterIdentityImages(root, [{ ...photo, key: 'xhs/other.webp' }]), []);
  assert.deepEqual(filterIdentityImages(root, [{ ...photo, provenance: { ...photo.provenance, sourceSha256: 'c'.repeat(64) } }]), []);
  assert.deepEqual(filterIdentityImages({ ...root, payload: { ...root.payload, imageIdentity: {} } }, [photo]), []);
});

test('同版本允许撤销而不允许恢复，受控策略不能消失，未知实体绑定拒绝', () => {
  const policy = root.payload!.imageIdentity as Record<string, unknown>;
  const revoked = { ...root, payload: { ...root.payload, imageIdentity: { ...policy, approved: [] } } };
  validateImagePolicy(revoked, root);
  assert.throws(() => validateImagePolicy(root, revoked), /同版本/);
  assert.throws(() => validateImagePolicy({ ...root, payload: { identity: root.payload!.identity } }, root), /被移除/);
  assert.throws(() => validateImagePolicy({ ...root, payload: { ...root.payload,
    imageIdentity: { ...policy, approved: [{ ...binding, entityId: 'other' }] } } }), /无效/);
  assert.deepEqual(filterIdentityImages(revoked, [photo]), []);
});

test('导入先筛逐图归属再限制三图，旧图不能占掉正确图片名额', () => {
  const entries = Array.from({ length: 4 }, (_, i) => ({ placeId: 'root', key: `xhs/old/${i}.webp` }));
  const groups = imageGroups([...entries, { placeId: 'root', key: photo.key, ...photo.provenance }], Number.MAX_SAFE_INTEGER);
  assert.deepEqual(resolveImageIdentities('重庆', groups, [root]).get('root'), [
    { key: photo.key, provenance: { placeId: 'root', key: photo.key, ...photo.provenance } },
  ]);
});
