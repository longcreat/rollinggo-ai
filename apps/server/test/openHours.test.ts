// 单测：营业时间文本的闭馆日检测（09-22-opentime）—— 只做日期维度，不做时间窗（去时间轴后无时刻可校验）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateForDayIndex, isClosedOnDate } from '@tripweaver/shared';

// 2026-09-21 = 周一，2026-09-22 = 周二（已用 node 核实）
const MON = '2026-09-21';
const TUE = '2026-09-22';

test('单星期闭馆：周一闭馆 → 周一 true / 周二 false', () => {
  const text = '09:00-17:00；周一闭馆';
  assert.equal(isClosedOnDate(text, MON), true);
  assert.equal(isClosedOnDate(text, TUE), false);
});

test('多星期同子句：周一、周二不开放 → 两天都 true', () => {
  const text = '周一、周二不开放';
  assert.equal(isClosedOnDate(text, MON), true);
  assert.equal(isClosedOnDate(text, TUE), true);
});

test('子句边界：闭馆关键词与星期标签必须在同一子句', () => {
  // 「周一」与「休息」在不同子句 → 不算（防跨子句误判）
  assert.equal(isClosedOnDate('周一客流高峰；法定节假日不休', MON), false);
  // 长标签等价：星期一/星期天
  assert.equal(isClosedOnDate('星期一闭馆', MON), true);
  assert.equal(isClosedOnDate('每周星期天闭馆', '2026-09-20'), true); // 2026-09-20 = 周日
});

test('降级：缺文本/缺日期/非法日期 → false（拿不准不校验）', () => {
  assert.equal(isClosedOnDate(undefined, MON), false);
  assert.equal(isClosedOnDate('', MON), false);
  assert.equal(isClosedOnDate('周一闭馆', ''), false);
  assert.equal(isClosedOnDate('周一闭馆', undefined), false);
  assert.equal(isClosedOnDate('周一闭馆', '不是日期'), false);
  // 无星期标签的纯时段文本 → 任何天都不闭馆
  assert.equal(isClosedOnDate('09:00-17:00', MON), false);
  // 「除周一外开放」没有闭馆关键词 → false（不误拦）
  assert.equal(isClosedOnDate('除周一外正常开放', MON), false);
});

test('dateForDayIndex：startDate + dayIndex 推当天日期；空/非法 → undefined', () => {
  assert.equal(dateForDayIndex('2026-09-21', 1), '2026-09-21');
  assert.equal(dateForDayIndex('2026-09-21', 2), '2026-09-22');
  assert.equal(dateForDayIndex('2026-09-30', 2), '2026-10-01'); // 跨月
  assert.equal(dateForDayIndex('', 1), undefined);
  assert.equal(dateForDayIndex('2026/09/21', 1), undefined);
  assert.equal(dateForDayIndex(undefined, 1), undefined);
});
