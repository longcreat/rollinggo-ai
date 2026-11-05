import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test, mock, afterEach } from 'node:test';
import { makeSampleTrip, SHARE_POSTER_URL_PATTERN, type GenerationNotification } from '@tripweaver/shared';
import { buildTripSharePrompt } from '../lib/tripSharePrompt';
import { encodeShareImage, generateShareImage } from '../integrations/imageGeneration';
import { readImageProviders } from '../env';
import { createTripShareImageService } from '../services/tripShareImageService';
import { sharePosterUrl, type SharePosterStore } from '../services/sharePosterStore';

type GeneratedPoster = Awaited<ReturnType<typeof generateShareImage>>;

test('成品 URL 前缀跟随 MEDIA_BASE_URL，两种前缀都通过共享校验', () => {
  const fileName = `${'a'.repeat(64)}.png`;
  const sameOrigin = sharePosterUrl(fileName, '/media');
  const cdn = sharePosterUrl(fileName, 'https://media.sakiiko.com/media');
  assert.equal(sameOrigin, `/media/share-posters/${fileName}`);
  assert.equal(cdn, `https://media.sakiiko.com/media/share-posters/${fileName}`);
  const pattern = new RegExp(SHARE_POSTER_URL_PATTERN);
  assert.ok(pattern.test(sameOrigin) && pattern.test(cdn), 'CDN 前缀必须仍被 TripShareImageResponseSchema 接受');
  assert.ok(!pattern.test('/media/share-posters/not-a-hash.png'), '文件名必须是内容 sha256');
  assert.ok(!pattern.test('/media/xhs/杭州/00.webp'), '其他媒体路径不得冒名为成品');
  assert.ok(!pattern.test(`${cdn}?v=1`), '不得带查询串（否则与库里的文件名对不上）');
});

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7hQAAAAASUVORK5CYII=';
/** suffix 让每次生成的字节不同，从而得到不同的内容寻址 URL */
const generated = (suffix = ''): GeneratedPoster => ({ bytes: Buffer.concat([Buffer.from(png, 'base64'), Buffer.from(suffix)]), mimeType: 'image/png' });
const posterUrl = (suffix = '') => `/media/share-posters/${createHash('sha256').update(generated(suffix).bytes).digest('hex')}.png`;
const config = { baseUrl: 'https://8.8.8.8/v1', apiKey: 'secret-fixture', model: 'gpt-image2.5' };
const secondConfig = { baseUrl: 'https://8.8.4.4/v1', apiKey: 'second-fixture', model: 'gpt-image2.5' };

/** 生产实现是磁盘 + PostgreSQL；单测只需要「同一行程同一风格只留一张」与内容寻址 URL 的语义 */
function memoryStore(): SharePosterStore {
  const rows = new Map<string, { promptHash: string; bytes: Buffer }>();
  const key = (userId: string, tripId: string, style: string) => `${userId}:${tripId}:${style}`;
  const url = (bytes: Buffer) => `/media/share-posters/${createHash('sha256').update(bytes).digest('hex')}.png`;
  return {
    async find(userId, tripId, style) {
      const row = rows.get(key(userId, tripId, style));
      return row ? { promptHash: row.promptHash, image: { url: url(row.bytes), mimeType: 'image/png' } } : null;
    },
    async save({ userId, tripId, style, promptHash, bytes }) {
      rows.set(key(userId, tripId, style), { promptHash, bytes });
      return { promptHash, image: { url: url(bytes), mimeType: 'image/png' } };
    },
  };
}

test('explicit regeneration replaces the stored poster, coalesces in-flight calls and preserves the old result on failure', async () => {
  const trip = makeSampleTrip();
  let calls = 0;
  let release: (() => void) | undefined;
  let fail = false;
  const service = createTripShareImageService(memoryStore(), async () => {
    calls++;
    if (calls === 1) return generated();
    if (fail) throw new Error('busy');
    await new Promise<void>(resolve => { release = resolve; });
    return generated('-new');
  });
  assert.equal((await service.generate('user', trip)).url, posterUrl());
  assert.equal((await service.generate('user', trip)).url, posterUrl());
  assert.equal(calls, 1);
  const fresh = service.generate('user', trip, 'journal', true);
  const duplicate = service.generate('user', trip, 'journal', true);
  const ordinary = service.generate('user', trip);
  await Promise.resolve();
  assert.equal(calls, 2);
  release?.();
  assert.deepEqual((await Promise.all([fresh, duplicate, ordinary])).map(image => image.url), [posterUrl('-new'), posterUrl('-new'), posterUrl('-new')]);
  assert.equal((await service.generate('user', trip)).url, posterUrl('-new'));
  fail = true;
  await assert.rejects(service.generate('user', trip, 'journal', true), /busy/);
  assert.equal((await service.generate('user', trip)).url, posterUrl('-new'));
  assert.equal(calls, 3);
});
afterEach(() => mock.restoreAll());

test('海报只在保存成功后通知一次，合并请求和回显不重复，重新生成创建新通知', async () => {
  const trip = makeSampleTrip();
  const store = memoryStore();
  const notifications: GenerationNotification[] = [];
  let fail = false;
  const service = createTripShareImageService(store, async () => {
    if (fail) throw new Error('生成失败');
    return generated();
  }, async (userId, source, style) => {
    assert.equal(userId, 'owner');
    assert.ok(await store.find(userId, source.id, style), '通知写入前图片已经保存');
    const note: GenerationNotification = {
      id: `note-${notifications.length}`, sequence: notifications.length + 1, jobId: `image-${notifications.length}`,
      kind: 'success', tripId: trip.id, title: '图片已生成', message: '可下载', createdAt: Date.now(), readAt: null, shareImageStyle: style,
    };
    notifications.push(note);
    return note;
  });
  const results = await Promise.all([service.generate('owner', trip), service.generate('owner', trip)]);
  assert.equal(notifications.length, 1);
  assert.equal(results[0]?.notification?.id, results[1]?.notification?.id);
  assert.equal((await service.generate('owner', trip)).notification, undefined);
  assert.equal((await service.find('owner', trip))?.url, results[0]?.url);
  assert.equal(notifications.length, 1);
  const regenerated = await service.generate('owner', trip, 'journal', true);
  assert.notEqual(regenerated.notification?.id, results[0]?.notification?.id);
  assert.equal(notifications.length, 2);
  fail = true;
  await assert.rejects(service.generate('owner', trip, 'ink'), /生成失败/);
  assert.equal(notifications.length, 2);
});

test('prompt preserves itinerary order while excluding private fields and lodging', () => {
  const trip = makeSampleTrip();
  trip.extraNotes = 'PRIVATE_NOTES'; trip.startDate = 'PRIVATE_DATE';
  trip.lodging = { name: 'PRIVATE_HOTEL' };
  trip.days[0]!.activities[0]!.description = 'PRIVATE_DESCRIPTION';
  const prompt = buildTripSharePrompt(trip);
  assert.ok(prompt.includes(trip.destination));
  assert.ok(prompt.includes('AI 创作 · RollingGo'));
  assert.equal(prompt.includes('PRIVATE_'), false);
  const data = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.equal(data.days.length, trip.days.length);
  assert.deepEqual(data.days[0].places, trip.days[0]!.activities.filter(a => a.category !== '住宿').slice(0, 6).map(a => a.name.slice(0, 60)));
});

test('ink style swaps only the style sentence and keeps the shared skeleton', () => {
  const trip = makeSampleTrip();
  const journal = buildTripSharePrompt(trip);
  const ink = buildTripSharePrompt(trip, 'ink');
  const withoutStyle = (prompt: string) => prompt.split('\n').filter(line => !line.startsWith('风格：')).join('\n');
  assert.ok(journal.includes('清爽现代旅行手账'));
  assert.ok(ink.includes('中国水墨写意'));
  assert.equal(ink.includes('清爽现代旅行手账'), false);
  assert.equal(withoutStyle(ink), withoutStyle(journal));
});

test('style is part of the storage key so switching styles regenerates', async () => {
  const seen: string[] = [];
  const service = createTripShareImageService(memoryStore(), async prompt => { seen.push(prompt); return generated(); });
  const trip = makeSampleTrip();
  await service.generate('user', trip, 'journal');
  await service.generate('user', trip, 'ink');
  await service.generate('user', trip);
  assert.equal(seen.length, 2);
  assert.ok(seen[1]!.includes('中国水墨写意'));
});

test('an already stored poster is returned without calling the model, and a changed trip is not', async () => {
  let calls = 0;
  const service = createTripShareImageService(memoryStore(), async () => { calls++; return generated(); });
  const trip = makeSampleTrip();
  const first = await service.generate('user', trip);
  assert.equal((await service.find('user', trip))?.url, first.url);
  assert.equal((await service.generate('user', trip)).url, first.url);
  assert.equal(calls, 1, 'opening the dialog again never pays for a new image');
  assert.equal(await service.find('user', { ...trip, title: '行程改名了' }), null, 'changed content never replays the old poster');
  assert.equal(await service.find('other-user', trip), null, 'another account never sees the poster');
});

test('specified model and default Images API protocol produce validated base64 image', async () => {
  const fetch = mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://8.8.8.8/v1/images/generations');
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init?.body)), { model: 'gpt-image2.5', prompt: 'trip prompt', n: 1, size: '1024x1536' });
    return Response.json({ data: [{ b64_json: png }] });
  });
  assert.deepEqual(await generateShareImage([config], 'trip prompt'), generated());
  assert.equal(fetch.mock.callCount(), 1);
});

test('URL response downloads image without leaking authorization', async () => {
  let count = 0;
  mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    if (++count === 1) return Response.json({ data: [{ url: 'https://8.8.4.4/image.png' }] });
    assert.equal(init?.headers, undefined);
    assert.equal(init?.redirect, 'error');
    return new Response(Buffer.from(png, 'base64'));
  });
  assert.deepEqual(await generateShareImage([config], 'trip'), generated());
  assert.equal(count, 2);
});

test('missing credential, unsafe returned URL, upstream error, oversized or malformed image fail safely', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ url: 'https://127.0.0.1/secret' }] }));
  await assert.rejects(generateShareImage([{ ...config, apiKey: '' }], 'trip'), /IMAGE_API_KEY/);
  assert.equal(fetch.mock.callCount(), 0);
  await assert.rejects(generateShareImage([config], 'trip'));
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async () => new Response('secret-fixture', { status: 401 }));
  await assert.rejects(generateShareImage([config], 'trip'), error => error instanceof Error && /鉴权失败/.test(error.message) && !error.message.includes('secret-fixture'));
  fetch.mock.mockImplementation(async () => new Response('{}', { headers: { 'content-length': '20000000' } }));
  await assert.rejects(generateShareImage([config], 'trip'), /过大/);
  fetch.mock.mockImplementation(async () => Response.json({ data: [{ b64_json: Buffer.from('<svg/>').toString('base64') }] }));
  await assert.rejects(generateShareImage([config], 'trip'), /有效/);
  assert.throws(() => encodeShareImage(Buffer.alloc(11 * 1024 * 1024)), /大小异常/);
});

test('retryable failure on the first relay falls back to the next one', async () => {
  const urls: string[] = [];
  mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    urls.push(String(url));
    return urls.length === 1 ? new Response('secret-busy', { status: 429 }) : Response.json({ data: [{ b64_json: png }] });
  });
  assert.deepEqual(await generateShareImage([config, secondConfig], 'trip'), generated());
  assert.deepEqual(urls, ['https://8.8.8.8/v1/images/generations', 'https://8.8.4.4/v1/images/generations']);
});

test('request errors and invalid local configuration never fall back', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => new Response('secret-bad-request', { status: 400 }));
  await assert.rejects(generateShareImage([config, secondConfig], 'trip'), error => error instanceof Error && /HTTP 400/.test(error.message) && !error.message.includes('secret'));
  assert.equal(fetch.mock.callCount(), 1);
  await assert.rejects(generateShareImage([{ ...config, baseUrl: 'https://8.8.8.8/v1?key=x' }, secondConfig], 'trip'), /地址配置不正确/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('relays without a key are skipped and an empty list stays unconfigured', async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => Response.json({ data: [{ b64_json: png }] }));
  await assert.rejects(generateShareImage([{ ...config, apiKey: '' }, { ...secondConfig, apiKey: '' }], 'trip'), /IMAGE_API_KEY/);
  await assert.rejects(generateShareImage([], 'trip'), /IMAGE_API_KEY/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('all relays failing throws the last real error', async () => {
  mock.method(globalThis, 'fetch', async (url: string | URL | Request) =>
    String(url).includes('8.8.4.4') ? new Response('secret-second', { status: 401 }) : new Response('secret-first', { status: 429 }));
  await assert.rejects(generateShareImage([config, secondConfig], 'trip'),
    error => error instanceof Error && /鉴权失败/.test(error.message) && !error.message.includes('secret'));
});

test('relay configuration parses indexed suffixes and ignores overflow', () => {
  const warn = mock.method(console, 'warn', () => {});
  const providers = readImageProviders({
    IMAGE_API_KEY: 'first',
    IMAGE_API_BASE_URL_2: 'https://b.lol/v1',
    IMAGE_API_KEY_2: 'second',
    IMAGE_MODEL_2: 'gpt-image-3',
    IMAGE_API_BASE_URL_3: 'https://c.lol/v1',   // 缺 Key：跳过但不中断扫描
    IMAGE_API_BASE_URL_4: 'https://d.lol/v1',   // 超出上限：忽略并告警
  });
  assert.deepEqual(providers, [
    { baseUrl: 'https://xjbh.lol/v1', apiKey: 'first', model: 'gpt-image2.5' },
    { baseUrl: 'https://b.lol/v1', apiKey: 'second', model: 'gpt-image-3' },
  ]);
  assert.equal(warn.mock.callCount(), 1);
  assert.deepEqual(readImageProviders({ IMAGE_API_KEY: 'first', IMAGE_API_BASE_URL_3: 'https://c.lol/v1', IMAGE_API_KEY_3: 'third' }).length, 1);
  assert.deepEqual(readImageProviders({}), []);
});

test('identical pending requests coalesce and stored posters do not regenerate', async () => {
  let count = 0;
  let resolve!: (value: GeneratedPoster) => void;
  const service = createTripShareImageService(memoryStore(), async () => { count++; return new Promise(r => { resolve = r; }); });
  const trip = makeSampleTrip();
  const first = service.generate('user', trip);
  const second = service.generate('user', trip);
  // store.find 是异步的：等两个请求都走完查库再断言合并
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(count, 1);
  await assert.rejects(service.generate('user', { ...trip, title: 'changed' }), /正在生成/);
  resolve(generated());
  assert.deepEqual((await Promise.all([first, second])).map(image => image.url), [posterUrl(), posterUrl()]);
  assert.equal((await service.generate('user', trip)).url, posterUrl());
  assert.equal(count, 1);
});

test('timeout returns safe error and never automatically retries', async () => {
  mock.method(AbortSignal, 'timeout', () => AbortSignal.abort());
  const fetch = mock.method(globalThis, 'fetch', async () => { throw new Error('secret-fixture'); });
  await assert.rejects(generateShareImage([config], 'trip'), /超时/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('failed generations release locks, and different users/drafts have isolated posters', async () => {
  let count = 0;
  const service = createTripShareImageService(memoryStore(), async () => { if (++count === 1) throw new Error('failure'); return generated(); });
  const trip = makeSampleTrip();
  await assert.rejects(service.generate('a', trip));
  await service.generate('a', trip);
  await service.generate('b', trip);
  await service.generate('a', { ...trip, title: 'new title' });
  assert.equal(count, 4);
});
