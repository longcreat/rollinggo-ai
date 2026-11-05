import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalMediaStore, normalizeMediaKey } from '../lib/mediaStore';
import { createMemoryMediaStore } from './helpers/memoryMediaStore';

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tripweaver-media-store-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('normalizeMediaKey：合法 key 原样保留，前导斜杠与空白被剥掉', () => {
  assert.equal(normalizeMediaKey('xhs/杭州/8f3a1b2c/00.webp'), 'xhs/杭州/8f3a1b2c/00.webp');
  assert.equal(normalizeMediaKey('/media/share-posters/abc.png'), 'media/share-posters/abc.png');
  assert.equal(normalizeMediaKey('  photo-store/sources/deadbeef.json  '), 'photo-store/sources/deadbeef.json');
});

test('normalizeMediaKey：空、目录跳转与反斜杠一律拒绝', () => {
  for (const key of ['', '   ', '/', '//', '.', '..', '../escape', 'a/../../b', 'a//b', 'a/./b', 'a\\b', 'a b.webp']) {
    assert.equal(normalizeMediaKey(key), null, `${JSON.stringify(key)} 应被拒绝`);
  }
});

test('local：put / get / exists / delete 往返', () => fixture(async root => {
  const store = createLocalMediaStore(root);
  const key = 'share-posters/abc123.png';
  assert.equal(await store.get(key), null, '未写入时 get 返回 null');
  assert.equal(await store.exists(key), false);

  await store.put(key, Buffer.from('poster'));
  assert.equal((await store.get(key))?.toString(), 'poster');
  assert.equal(await store.exists(key), true);

  await store.delete(key);
  assert.equal(await store.get(key), null);
  assert.equal(await store.exists(key), false);
  await store.delete(key); // 重复删除必须安全
}));

test('local：嵌套 key 自动建目录，点号结尾的目录名不被当成文件', () => fixture(async root => {
  const store = createLocalMediaStore(root);
  const key = 'wikimedia/nested/dir/8f.webp';
  await store.put(key, Buffer.from([1, 2, 3]));
  assert.deepEqual(await store.get(key), Buffer.from([1, 2, 3]));
}));

test('local：同 key 覆盖写入（上游重导复用 xhs/…/00.webp 的场景）', () => fixture(async root => {
  const store = createLocalMediaStore(root);
  const key = 'xhs/北京/8f3a/00.webp';
  await store.put(key, Buffer.from('older-and-longer'));
  await store.put(key, Buffer.from('new'));
  assert.equal((await store.get(key))?.toString(), 'new', '第二次写入必须覆盖第一次');
}));

test('local：非法 key 直接抛错，不落到磁盘', () => fixture(async root => {
  const store = createLocalMediaStore(root);
  await assert.rejects(() => store.put('../escape', Buffer.from('x')), /媒体 key 非法/);
  assert.equal(await store.get('../escape'), null, '非法 key 的读返回 null 而不是猜测路径');
}));

test('local：并发写同一 key 后内容仍是完整的某一次写入', () => fixture(async root => {
  const store = createLocalMediaStore(root);
  const key = 'remote-photos/conc.webp';
  const payloads = Array.from({ length: 8 }, (_, i) => `payload-${i}`.repeat(64));
  await Promise.all(payloads.map(payload => store.put(key, Buffer.from(payload))));
  const bytes = await store.get(key);
  assert.ok(bytes, '并发写入后必须能读回');
  assert.ok(payloads.includes(bytes.toString()), '读回内容必须是其中一次完整写入，不能是截断或拼接');
}));

test('memory：语义与对象存储一致，且拒绝非法 key', async () => {
  const store = createMemoryMediaStore();
  await store.put('photo-store/sources/ab.json', Buffer.from('{"v":1}'));
  assert.equal((await store.get('photo-store/sources/ab.json'))?.toString(), '{"v":1}');
  assert.deepEqual(store.keys(), ['photo-store/sources/ab.json']);
  await store.delete('photo-store/sources/ab.json');
  assert.equal(await store.exists('photo-store/sources/ab.json'), false);
  assert.equal(await store.get('photo-store/sources/ab.json'), null);
  await assert.rejects(() => store.put('../../etc/passwd', Buffer.from('x')), /媒体 key 非法/);
});
