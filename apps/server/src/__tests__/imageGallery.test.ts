import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageGroups, readImageGallery } from '../lib/imageGallery';

test('单封面兼容，多图保持首选顺序、去重并限制三张', () => {
  const group = imageGroups(['first', 'first', 'second', 'third', 'fourth'].map(name => ({ placeId: 'a', key: `${name}.webp` })));
  assert.deepEqual(group.get('a')?.map(image => image.key), ['first.webp', 'second.webp', 'third.webp']);
  assert.deepEqual(readImageGallery(null), []);
});

test('摄影图保留模型审核与来源，不把自动审核转成已授权', () => {
  const photo = { placeId: 'a', key: 'xhs/photography/a/hash.webp', author: '摄影师',
    sourceUrl: 'https://www.xiaohongshu.com/explore/abcd', rights: 'permission-needed',
    reviewMethod: 'model', review: { status: 'eligible', identity: 'match', evidence: '太和殿全景' } };
  const result = imageGroups([photo]).get('a')![0]!;
  assert.equal(result.attribution?.source, 'xhs');
  assert.equal(result.attribution?.license, '未确认授权');
  assert.deepEqual(result.provenance, photo);
  assert.throws(() => imageGroups([{ ...photo, review: { status: 'unknown' } }]));
  assert.throws(() => imageGroups([{ ...photo, sourceUrl: 'https://www.xiaohongshu.com.evil.test/explore/a' }]));
});

test('导入拒绝越界路径和外链，读取脏图库时安全忽略', () => {
  for (const key of ['../a.webp', '/root.webp', 'xhs//a.webp', 'xhs/../a.webp', 'https://example.com/a.webp']) {
    assert.throws(() => imageGroups([{ placeId: 'a', key }]));
    assert.deepEqual(readImageGallery([{ key }]), []);
  }
});
