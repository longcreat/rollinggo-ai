import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanResearchIntro, normalizeReservation, purifiedIntroSources } from '../generation/researchQuality';

test('介绍多引文全部保留，模型知识不伪造来源', () => {
  assert.deepEqual(purifiedIntroSources({ content: { version: 1, intro: '景点介绍。', highlights: [
    { sourceUrl: 'https://example.com/a', citations: [
      { sourceUrl: 'https://example.com/a' }, { sourceUrl: 'https://example.com/b' },
      { sourceUrl: 'javascript:alert(1)' }, null,
    ] },
    { basis: 'model_knowledge', sourceUrl: null, quote: null },
  ] } }), [
    { title: '景点介绍来源', url: 'https://example.com/a' },
    { title: '景点介绍来源', url: 'https://example.com/b' },
  ]);
});

test('预约状态与说明矛盾、仅名称或含混信息不能当作确定政策', () => {
  for (const [status, note] of [
    ['required', '天坛公园无需预约'], ['required', '烟袋斜街无需预约'],
    ['none', '请提前在官方小程序预约'], ['required', '无需预约，但节假日需预约'],
  ]) {
    const result = normalizeReservation(status, note);
    assert.equal(result.reservation, 'unknown');
    assert.match(result.reservationNote!, /冲突/);
  }
  for (const note of ['景山公园', '什刹海', '', '旺季可能需要预约', '建议提前预约', '预约政策待确认']) {
    assert.equal(normalizeReservation('required', note).reservation, 'unknown');
  }
  assert.equal(normalizeReservation('unknown', '需要预约').reservation, 'unknown');
  assert.equal(normalizeReservation(undefined, null).reservation, 'unknown');
});

test('一致且明确的预约信息保留，官方兜底提示不抹掉已知要求', () => {
  for (const [status, note] of [
    ['required', '请先预约'], ['required', '官方小程序提前7天实名预约，以官方最新信息为准'],
    ['none', '无需提前预约'], ['none', '不需要预约，可现场入园'],
  ]) assert.deepEqual(normalizeReservation(status, note), { reservation: status, reservationNote: note });
});

test('生成端保留完整介绍，不因政策关键词整句删除或改变标点', () => {
  for (const closure of ['法物流通处可能已关闭', '法物流通处已关闭']) {
    assert.equal(cleanResearchIntro(`藏传佛教寺院，可看殿宇与造像。${closure}，去前可确认。`),
      `藏传佛教寺院，可看殿宇与造像。${closure}，去前可确认。`);
  }
  for (const price of ['门票约2元', '2元门票', '票价以现场为准']) {
    assert.equal(cleanResearchIntro(`登万春亭俯瞰故宫中轴线，${price}。`), `登万春亭俯瞰故宫中轴线，${price}。`);
  }
  assert.equal(cleanResearchIntro('皇家园林，湖畔可看白塔。无需预约，免费开放，周一闭园，排队约半小时。'),
    '皇家园林，湖畔可看白塔。无需预约，免费开放，周一闭园，排队约半小时。');
  assert.equal(cleanResearchIntro('明清皇家祭天之所，祈年殿是标志建筑。需买联票才能进核心建筑，建议东门进。'),
    '明清皇家祭天之所，祈年殿是标志建筑。需买联票才能进核心建筑，建议东门进。');
});

test('简介保留有意义的静态数字与完整分句，不截断限定语', () => {
  assert.equal(cleanResearchIntro('有600年历史的古建筑，可看九龙壁和园林。'), '有600年历史的古建筑，可看九龙壁和园林。');
  const long = `${'园林'.repeat(99)}但仅供参考`;
  const result = cleanResearchIntro(`可沿湖散步。${long}。`);
  assert.equal(result, '可沿湖散步。');
  assert.equal(cleanResearchIntro('免费开放。已关闭。'), '免费开放。已关闭。');
});

test('介绍来源只保留安全URL并去重，旧版/空介绍不携带伪来源', () => {
  const content = { version: 1, intro: '明清皇家宫殿。', highlights: [
    { sourceUrl: 'https://www.dpm.org.cn/about/about_view.html' },
    { sourceUrl: 'https://www.dpm.org.cn/about/about_view.html' },
    { sourceUrl: 'javascript:alert(1)' }, { sourceUrl: 'not-a-url' }, null,
  ] };
  assert.deepEqual(purifiedIntroSources({ content }), [{ title: '景点介绍来源', url: 'https://www.dpm.org.cn/about/about_view.html' }]);
  assert.deepEqual(purifiedIntroSources({ content: { ...content, intro: '' } }), []);
});

test('同一段说明里互不重叠的提前天数判为冲突，区间写法不算冲突', () => {
  const conflict = normalizeReservation('required', '天坛公园提前7天；天坛公园提前1天00:00预约');
  assert.equal(conflict.reservation, 'unknown');
  assert.match(conflict.reservationNote!, /冲突/);
  for (const note of [
    '故宫博物院提前3-7天20:00放票；故宫/天安门升旗/天安门城楼均需通过官方小程序提前7天预约',
    '人民大会堂提前3天；人民大会堂提前3天',
    '钟鼓索道热门时段建议提前7天左右抢；钟鼓索道：需提前预约',
    '四川博物院提前7天放票',
  ]) assert.doesNotMatch(normalizeReservation('required', note).reservationNote!, /冲突/);
});
