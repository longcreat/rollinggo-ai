// 高德 POI 图片（09-27，11-05 成为唯一图片来源）：挑选闸门（纯函数）+ 适配器的缓存、失败降级、请求上限（mock fetch）
// 只依赖 lib/* 与同目录 geocoder 的共享队列，导入本文件不连库。
import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/amapQuotaMock';
import { createAmapPoiPhotoLookup, pickPhotos } from '../integrations/amap/poiPhotos';

const PHOTO = 'https://store.is.autonavi.com/showpic/78e3e7b400e9290d0000003670488183';
const PHOTO_2 = 'https://store.is.autonavi.com/showpic/78e3e7b400e9290d0000003670488184';
const PHOTO_3 = 'https://store.is.autonavi.com/showpic/78e3e7b400e9290d0000003670488185';
const PHOTO_4 = 'https://store.is.autonavi.com/showpic/78e3e7b400e9290d0000003670488186';

const SCENIC = '风景名胜;风景名胜;国家级景点';

function poi(name: string, photos: { url: string }[] = [{ url: PHOTO }], type = SCENIC) {
  return { name, type, photos };
}

test('挑选：名字归一键相同或以其结尾的 POI 才算命中', () => {
  // 高德 name 带「风景名胜区」后缀 → 归一后「杭州西湖」以「西湖」结尾
  assert.deepEqual(pickPhotos([poi('杭州西湖风景名胜区')], '西湖'), [PHOTO]);
  // 精确同名
  assert.deepEqual(pickPhotos([poi('故宫博物院')], '故宫'), [PHOTO]);
  // 「西湖区××」不得被当成「西湖」（endsWith 而非 includes）
  assert.deepEqual(pickPhotos([poi('西湖区某小区')], '西湖'), []);
  assert.deepEqual(pickPhotos([poi('灵隐寺')], '西湖'), []);
  assert.deepEqual(pickPhotos([], '西湖'), []);
});

test('挑选：一个 POI 的多张图按顺序返回，去重且最多三张', () => {
  const photos = [{ url: PHOTO }, { url: PHOTO_2 }, { url: PHOTO_2 }, { url: PHOTO_3 }, { url: PHOTO_4 }];
  assert.deepEqual(pickPhotos([poi('西湖', photos)], '西湖'), [PHOTO, PHOTO_2, PHOTO_3]);
  assert.deepEqual(pickPhotos([poi('西湖', photos)], '西湖', 2), [PHOTO, PHOTO_2]);
});

test('挑选：http 图片地址改写成 https，其他协议丢弃', () => {
  const http = 'http://store.is.autonavi.com/showpic/d7a717ff';
  assert.deepEqual(pickPhotos([poi('西湖', [{ url: http }])], '西湖'), ['https://store.is.autonavi.com/showpic/d7a717ff']);
  assert.deepEqual(pickPhotos([poi('西湖', [{ url: 'ftp://x/y.png' }])], '西湖'), []);
  assert.deepEqual(pickPhotos([poi('西湖', [])], '西湖'), []);
});

test('挑选：首个命中 POI 没图时继续看下一个候选', () => {
  const pois = [poi('西湖', []), poi('杭州西湖风景名胜区', [{ url: PHOTO }])];
  assert.deepEqual(pickPhotos(pois, '西湖'), [PHOTO]);
});

test('挑选：类型白名单拦住公交站 / 路名 / 餐厅类 POI 的图', () => {
  const busStop = poi('龙井村(公交站)', [{ url: PHOTO }], '交通设施服务;公交车站;公交车站');
  assert.deepEqual(pickPhotos([busStop], '龙井村'), [], '公交站不能当景点封面');
  const road = poi('宋城路', [{ url: PHOTO }], '地名地址信息;地名地址信息;地名地址信息');
  assert.deepEqual(pickPhotos([road], '宋城'), [], '路名不能当景点封面');
  const restaurant = poi('龙井村', [{ url: PHOTO }], '餐饮服务;中餐厅;中餐厅');
  assert.deepEqual(pickPhotos([restaurant], '龙井村'), []);
  assert.deepEqual(pickPhotos([poi('龙井村', [{ url: PHOTO }], '')], '龙井村'), [], 'type 缺失一律拒绝');
  assert.deepEqual(
    pickPhotos([poi('龙井村', [{ url: PHOTO }], '风景名胜;公园广场;公园')], '龙井村'),
    [PHOTO],
    '白名单内的类型正常取图',
  );
});

test('挑选：地点名中间插词也能命中（西溪湿地 → 西溪国家湿地公园）', () => {
  assert.deepEqual(pickPhotos([poi('西溪国家湿地公园')], '西溪湿地'), [PHOTO]);
  assert.deepEqual(pickPhotos([poi('杭州西溪国家湿地公园')], '西溪湿地'), [PHOTO]);
  assert.deepEqual(pickPhotos([poi('湿地西溪公园')], '西溪湿地'), [], '分段必须按序出现');
  assert.deepEqual(pickPhotos([poi('九溪烟树景区')], '九溪烟树'), [PHOTO], '整体后缀仍走 endsWith');
});

test('挑选：地点名过短（剥不出有效键）时不猜', () => {
  assert.deepEqual(pickPhotos([poi('甲')], '甲'), []);
});

test('适配器：未配置 key 时直接返回空数组，不发请求且 calls 保持 0', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({ status: '1', pois: [] });
  }) as typeof fetch;
  try {
    const lookup = createAmapPoiPhotoLookup('', 8);
    assert.deepEqual(await lookup.photosFor({ name: '西湖', city: '杭州' }), []);
    assert.equal(calls, 0, '无 key 不得发请求');
    assert.equal(lookup.calls, 0, 'calls 反映真实请求数');
  } finally {
    globalThis.fetch = original;
  }
});

test('适配器：命中返回多张 https 图，第二次走缓存，calls 只在真实请求时增长', async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return Response.json({ status: '1', pois: [poi('杭州西湖风景名胜区', [{ url: PHOTO }, { url: PHOTO_2 }])] });
  }) as typeof fetch;
  try {
    const lookup = createAmapPoiPhotoLookup('test-key', 8);
    const query = { name: '西湖', city: '杭州' };
    assert.deepEqual(await lookup.photosFor(query), [PHOTO, PHOTO_2]);
    assert.deepEqual(await lookup.photosFor(query), [PHOTO, PHOTO_2]);
    assert.equal(urls.length, 1, '第二次应命中缓存，不再发请求');
    assert.match(urls[0]!, /show_fields=photos/);
    assert.match(urls[0]!, /region=/);
    assert.equal(lookup.calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('适配器：确认无图的 POI 进负缓存，第二次不再发请求', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({ status: '1', pois: [{ name: '云栖竹径', photos: [] }] });
  }) as typeof fetch;
  try {
    const lookup = createAmapPoiPhotoLookup('test-key', 8);
    const query = { name: '云栖竹径', city: '杭州' };
    assert.deepEqual(await lookup.photosFor(query), []);
    assert.deepEqual(await lookup.photosFor(query), []);
    assert.equal(calls, 1, '两次调用只应发一次请求（负缓存命中）');
    assert.equal(lookup.calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('适配器：业务失败（status≠1）返回空数组且不进缓存，下次重试', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return Response.json({ status: '0', info: 'USER_DAILY_QUERY_OVER_LIMIT' });
  }) as typeof fetch;
  try {
    const lookup = createAmapPoiPhotoLookup('test-key', 8);
    const query = { name: '九溪烟树', city: '杭州' };
    assert.deepEqual(await lookup.photosFor(query), []);
    assert.deepEqual(await lookup.photosFor(query), []);
    assert.equal(calls, 2, '失败不缓存，第二次应再次尝试');
  } finally {
    globalThis.fetch = original;
  }
});

test('适配器：超过单次生成上限后不再发请求', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response('nope', { status: 500 });
  }) as typeof fetch;
  try {
    const lookup = createAmapPoiPhotoLookup('test-key', 1);
    assert.deepEqual(await lookup.photosFor({ name: '甲园', city: '北京' }), []);
    assert.deepEqual(await lookup.photosFor({ name: '乙园', city: '北京' }), []);
    assert.equal(calls, 1, '上限为 1 时第二次不得发请求');
    assert.equal(lookup.calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
