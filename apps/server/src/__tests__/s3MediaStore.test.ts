// S3 兼容实现（R2 / MinIO）不需要真实桶：aws4fetch 走全局 fetch，这里用替身检查
// 签名请求的落点、方法、元数据与分页解析。中文 key 的百分号编码只允许出现一次。
process.env.MASTER_KEY = 'a'.repeat(64);

import assert from 'node:assert/strict';
import test from 'node:test';
import { createS3MediaStore } from '../lib/mediaStore';

const { mediaObjectKey } = await import('../lib/dataStore');

const config = {
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  bucket: 'tripweaver-media',
  accessKeyId: 'AKIAEXAMPLEFIXTURE',
  secretAccessKey: 'secret-fixture',
  region: 'auto',
};

function stubFetch(handler: (request: Request) => Response | Promise<Response>) {
  const previous = globalThis.fetch;
  const seen: Request[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input as RequestInfo, init);
    seen.push(request);
    return handler(request);
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = previous; } };
}

const xml = (rows: { key: string; size: number; etag?: string }[], next?: string) => `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult><IsTruncated>${next ? 'true' : 'false'}</IsTruncated>
${rows.map(row => `<Contents><Key>${row.key}</Key><Size>${row.size}</Size>${row.etag ? `<ETag>"${row.etag}"</ETag>` : ''}</Contents>`).join('')}
${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}</ListBucketResult>`;

test('put：签名请求落到 bucket/key，带上 Content-Type 与 Cache-Control', async () => {
  const store = createS3MediaStore(config);
  const { seen, restore } = stubFetch(() => new Response(null, { status: 200 }));
  try {
    await store.put('media/share-posters/abc.png', Buffer.from('poster'), {
      contentType: 'image/png', cacheControl: 'public, max-age=31536000, immutable',
    });
    assert.equal(seen.length, 1);
    const request = seen[0]!;
    assert.equal(request.method, 'PUT');
    assert.equal(request.url, 'https://acct.r2.cloudflarestorage.com/tripweaver-media/media/share-posters/abc.png');
    assert.equal(request.headers.get('content-type'), 'image/png');
    assert.equal(request.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const authorization = request.headers.get('authorization') ?? '';
    assert.match(authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLEFIXTURE\/\d{8}\/auto\/s3\/aws4_request/);
    assert.match(authorization, /SignedHeaders=[^,]+, Signature=[a-f0-9]{64}$/);
    assert.equal(Buffer.from(await request.arrayBuffer()).toString(), 'poster');
  } finally { restore(); }
});

test('put：非 2xx 抛出带状态码的错误，不静默成功', async () => {
  const store = createS3MediaStore(config);
  const { restore } = stubFetch(() => new Response('denied', { status: 403 }));
  try {
    await assert.rejects(() => store.put('media/x.webp', Buffer.from('x')), /HTTP 403/);
  } finally { restore(); }
});

test('中文 key 只编码一次，且不会变成 media/media 前缀', async () => {
  const store = createS3MediaStore(config);
  const { seen, restore } = stubFetch(() => new Response(null, { status: 200 }));
  try {
    await store.put('media/xhs/杭州/8f3a/00.webp', Buffer.from('x'));
    const url = seen[0]!.url;
    assert.equal(url, 'https://acct.r2.cloudflarestorage.com/tripweaver-media/media/xhs/%E6%9D%AD%E5%B7%9E/8f3a/00.webp');
    assert.ok(!url.includes('%25'), '百分号本身不能再被编码（二次编码会让签名与对象不匹配）');
  } finally { restore(); }
});

test('get：404 视为不存在，其余非 2xx 抛出', async () => {
  const store = createS3MediaStore(config);
  const missing = stubFetch(() => new Response(null, { status: 404 }));
  try {
    assert.equal(await store.get('media/remote-photos/none.webp'), null);
  } finally { missing.restore(); }

  const healthy = stubFetch(() => new Response(Buffer.from([1, 2, 3]), { status: 200 }));
  try {
    assert.deepEqual(await store.get('media/remote-photos/one.webp'), Buffer.from([1, 2, 3]));
  } finally { healthy.restore(); }

  const broken = stubFetch(() => new Response(null, { status: 500 }));
  try {
    await assert.rejects(() => store.get('media/remote-photos/one.webp'), /HTTP 500/);
  } finally { broken.restore(); }
});

test('exists / delete：HEAD 与 DELETE 的 404 都按“没有这个对象”处理', async () => {
  const store = createS3MediaStore(config);
  const present = stubFetch(request => new Response(null, { status: request.method === 'HEAD' ? 200 : 204 }));
  try {
    assert.equal(await store.exists('media/x.webp'), true);
    assert.equal(present.seen[0]!.method, 'HEAD');
    await store.delete('media/x.webp');
    assert.equal(present.seen[1]!.method, 'DELETE');
  } finally { present.restore(); }

  const absent = stubFetch(() => new Response(null, { status: 404 }));
  try {
    assert.equal(await store.exists('media/x.webp'), false);
    await store.delete('media/x.webp');
  } finally { absent.restore(); }
});

test('list：解析 key/大小/ETag，并按 NextContinuationToken 翻页', async () => {
  const store = createS3MediaStore(config);
  const MD5_A = 'd41d8cd98f00b204e9800998ecf8427e', MD5_B = '0cc175b9c0f1b6a831c399e269772661';
  const pages = [
    xml([{ key: 'photo-store/review-jobs/aa.json', size: 12, etag: MD5_A }], 'TOKEN-1'),
    xml([{ key: 'photo-store/review-jobs/bb.json', size: 34, etag: MD5_B }, { key: 'photo-store/review-jobs/cc.json', size: 56 }]),
  ];
  let call = 0;
  const { seen, restore } = stubFetch(() => new Response(pages[call++]!, { status: 200 }));
  try {
    const objects = await store.list('photo-store/review-jobs');
    assert.deepEqual(objects, [
      { key: 'photo-store/review-jobs/aa.json', size: 12, etag: MD5_A },
      { key: 'photo-store/review-jobs/bb.json', size: 34, etag: MD5_B },
      // 无 ETag（分片上传）时只给 key/大小，调用方需自行降级
      { key: 'photo-store/review-jobs/cc.json', size: 56, etag: undefined },
    ]);
    assert.equal(seen.length, 2);
    assert.match(seen[0]!.url, /list-type=2&prefix=photo-store%2Freview-jobs%2F/);
    assert.match(seen[1]!.url, /continuation-token=TOKEN-1/);
  } finally { restore(); }
});

test('list：截断却没有 continuation token 时抛错，不返回半份列表', async () => {
  const store = createS3MediaStore(config);
  const { restore } = stubFetch(() => new Response('<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>', { status: 200 }));
  try {
    await assert.rejects(() => store.list('photo-store/review-jobs'), /continuation token/);
  } finally { restore(); }
});

test('mediaObjectKey：同源路径、CDN 前缀与裸 key 归一到同一个对象 key', () => {
  assert.equal(mediaObjectKey('xhs/杭州/8f3a/00.webp'), 'media/xhs/杭州/8f3a/00.webp');
  assert.equal(mediaObjectKey('/media/xhs/杭州/8f3a/00.webp'), 'media/xhs/杭州/8f3a/00.webp');
  assert.equal(mediaObjectKey('media/xhs/杭州/8f3a/00.webp'), 'media/xhs/杭州/8f3a/00.webp');
  assert.equal(mediaObjectKey('  /media/remote-photos/ab.webp  '), 'media/remote-photos/ab.webp');
  for (const bad of ['', '   ', '/', '../escape', 'https://evil.test/media/x.webp', 'a//b.webp']) {
    assert.equal(mediaObjectKey(bad), null, `${JSON.stringify(bad)} 必须被拒绝`);
  }
});
