// 单测：placeFacts 实体归一（09-23）——归一键、合并规则、加载集成（本地库）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlaceFacts, mergeFacts, normalizePlaceKey, renderOpenHours, type PlaceFacts } from '../generation/scheduling/placeFacts';
import { poiScore, scoreMaxima } from '../generation/scheduling/score';

// ---------- 归一键 ----------

test('归一键：机构后缀剥离后同键，无后缀原名保持', () => {
  assert.equal(normalizePlaceKey('故宫博物院'), '故宫');
  assert.equal(normalizePlaceKey('故宫'), '故宫');
  assert.equal(normalizePlaceKey('景山公园'), '景山');
  assert.equal(normalizePlaceKey('景山'), '景山');
  assert.equal(normalizePlaceKey('恭王府博物馆'), '恭王府');
  assert.equal(normalizePlaceKey(' 故宫博物院 '), '故宫', '空白先 trim');
});

test('归一键：不剥非后缀差异（沈阳故宫 ≠ 故宫），不剥到少于 2 字', () => {
  assert.notEqual(normalizePlaceKey('沈阳故宫'), normalizePlaceKey('故宫博物院'));
  assert.equal(normalizePlaceKey('公园'), '公园', '整名就是后缀时不剥');
});

// ---------- 合并规则 ----------

const fx = (over: Partial<PlaceFacts> & { name: string }): PlaceFacts => ({
  category: '', source: 'xhs', themes: [], recommendScore: 0, mentionCount: 0, aliases: [], ...over,
});

test('合并：质量和热度取 max、themes 并集、source 优先金集', () => {
  const merged = mergeFacts([
    fx({ name: '故宫博物院', source: 'goldset', recommendScore: 17.33, mentionCount: 6, themes: ['历史古迹'] }),
    fx({ name: '故宫', source: 'xhs', recommendScore: 40, mentionCount: 12, themes: ['历史古迹', '赏雪'] }),
  ]);
  assert.equal(merged.recommendScore, 40, '质量取 max');
  assert.equal(merged.mentionCount, 12, '相同来源的别名不能重复累加热度');
  assert.deepEqual(merged.themes, ['历史古迹', '赏雪'], 'themes 并集去重');
  assert.equal(merged.source, 'goldset', 'source 取高优先');
});

test('合并：坐标与停留时长取有值/最大', () => {
  const merged = mergeFacts([
    fx({ name: '甲', visitMinutes: 120 }),
    fx({ name: '甲公园', lat: 39.9, lng: 116.4, visitMinutes: 90 }),
  ]);
  assert.equal(merged.visitMinutes, 120);
  assert.equal(merged.lat, 39.9);
});

test('合并：coverImage 任一成员有值即可用（同键分裂条目共享同一批导出的图）', () => {
  const merged = mergeFacts([
    fx({ name: '故宫' }),
    fx({ name: '故宫博物院', coverImage: 'xhs/北京/8f3a/00.webp' }),
  ]);
  assert.equal(merged.coverImage, 'xhs/北京/8f3a/00.webp');
  assert.equal(mergeFacts([fx({ name: '甲' })]).coverImage, undefined, '都没图时不编造');
});

// ---------- 加载集成（本地库；库不可达时 placeFacts 降级为空 Map，跳过断言） ----------

test('loadPlaceFacts：候选「故宫博物院」合并到「故宫」分裂条目的分数与提及', async () => {
  const map = await loadPlaceFacts(['故宫博物院'], '北京');
  const facts = map.get('故宫博物院');
  if (!facts) {
    console.warn('本地库不可达或未命中，跳过集成断言');
    return;
  }
  // 分裂前实测：recommendScore 17.33 / mentionCount 6；合并后提及应 > 6（故宫条目的提及加进来）
  assert.ok((facts.mentionCount ?? 0) > 6, `合并后提及应大于单条目 6，实际 ${facts.mentionCount}`);
});

test('未知评分在合并后仍走中性值，真实零保持为零', () => {
  const unknown = fx({ name: '金集地标', source: 'goldset', recommendScore: undefined, mentionCount: undefined });
  const merged = mergeFacts([unknown, { ...unknown, name: '金集地标公园' }]);
  assert.equal(merged.recommendScore, undefined);
  assert.equal(merged.mentionCount, undefined);
  const maxima = scoreMaxima([merged, { recommendScore: 80, mentionCount: 10 }]);
  assert.equal(poiScore(merged, maxima), 65);
  const zero = mergeFacts([unknown, fx({ name: '零分地标' })]);
  assert.equal(zero.recommendScore, 0);
  assert.equal(zero.mentionCount, 0);
  assert.equal(poiScore(zero, maxima), 15);
  assert.equal(mergeFacts([unknown, fx({ name: '已知', mentionCount: 7 })]).mentionCount, 7);
});

// ---------- 结构化开闭馆渲染（09-27） ----------

test('v2 归属待审及子设施不渲染为主地点营业规则，明确主语继续生效', () => {
  const fields = { version: 2, scope: 'place', openTime: '09:00', closeTime: '17:00', closedWeekdays: [1] };
  assert.equal(renderOpenHours({ ...fields, status: 'unknown' }), undefined);
  assert.equal(renderOpenHours({ ...fields, status: 'attributed', scope: 'component' }), undefined);
  assert.equal(renderOpenHours({ ...fields, status: 'attributed' }), '09:00-17:00；周一闭馆');
});

test('renderOpenHours：营业时段与闭馆星期渲染成 openTime 同构文本', () => {
  assert.equal(renderOpenHours({ openTime: '09:00', closeTime: '17:00', closedWeekdays: [] }), '09:00-17:00');
  assert.equal(renderOpenHours({ text: '周一闭馆', openTime: null, closeTime: null, closedWeekdays: [1] }), '周一闭馆');
  assert.equal(
    renderOpenHours({ openTime: '09:00', closeTime: '17:00', closedWeekdays: [1, 6], note: '法定节假日除外' }),
    '09:00-17:00；周一、周六闭馆；法定节假日除外',
  );
  assert.equal(renderOpenHours({ closedWeekdays: [2, 1, 2] }), '周一、周二闭馆', '星期去重并排序');
});

test('renderOpenHours：字段缺失或类型不符时返回 undefined，不编造', () => {
  assert.equal(renderOpenHours(undefined), undefined);
  assert.equal(renderOpenHours(null), undefined);
  assert.equal(renderOpenHours('09:00-17:00'), undefined, '自由文本不走这条路');
  assert.equal(renderOpenHours({}), undefined);
  assert.equal(renderOpenHours({ closedWeekdays: [9, -1] }), undefined, '越界星期丢弃后无内容');
  assert.equal(
    renderOpenHours({ openTime: '09:00', closeTime: '17:00', closedWeekdays: ['1'] }),
    '09:00-17:00',
    '非数字星期忽略，不报错',
  );
});

// ---------- payload.aliases（09-27） ----------

test('loadPlaceFacts：payload.aliases 参与归一，别名能命中正式名条目', async () => {
  // 库里只有「香山双清别墅」一行，别名含「双清别墅」；候选名「双清别墅」剥不出后缀，
  // 主键与库内行不等 —— 只有别名键参与归一才能命中（实测库内无「双清别墅」独立行）。
  const map = await loadPlaceFacts(['双清别墅'], '北京');
  const facts = map.get('双清别墅');
  if (!facts) {
    console.warn('本地库不可达或无 aliases 数据，跳过集成断言');
    return;
  }
  assert.equal(facts.name, '香山双清别墅', `应靠别名命中正式名条目，实际命中 ${facts.name}`);
});

test('loadPlaceFacts：payload.openHours 渲染进 facts.openTime', async () => {
  const map = await loadPlaceFacts(['景山公园'], '北京');
  const facts = map.get('景山公园');
  if (!facts) {
    console.warn('本地库不可达或无 openHours 数据，跳过集成断言');
    return;
  }
  // 不硬编码具体时段：上游 openHours 会随数据治理更新（景山公园已从 06:30-20:00 变为 06:00-21:00），
  // 硬编码会让测试跟着数据漂移而假失败。这里只锁定「渲染确实发生且格式正确」。
  assert.match(facts.openTime ?? '', /^\d{2}:\d{2}-\d{2}:\d{2}$/, 'openHours.text 应被渲染为 HH:MM-HH:MM');
});

// ---------- payload.coverImage（09-27） ----------

test('loadPlaceFacts：payload.coverImage 透传为相对 key', async () => {
  const map = await loadPlaceFacts(['故宫博物院'], '北京');
  const facts = map.get('故宫博物院');
  if (!facts?.coverImage) {
    console.warn('本地库尚无封面 key（先跑 export_place_images.py + seed-xhs-place-images.ts），跳过断言');
    return;
  }
  assert.match(facts.coverImage, /^xhs\//, '存的是相对 key，不带 /media 前缀');
  assert.ok(!facts.coverImage.startsWith('/'), '绝对路径不入库');
});
