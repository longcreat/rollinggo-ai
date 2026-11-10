// 单测：法定节假日表与闭馆判定豁免（09-27）
// 数据源：国办发明电〔2025〕7 号《国务院办公厅关于 2026 年部分节假日安排的通知》
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findHoliday, isClosedOnDate, isPublicHoliday } from '@tripweaver/shared';

test('节假日表：2026 年七个节日区间首尾都命中', () => {
  const cases: [string, string][] = [
    ['2026-01-01', '元旦'],
    ['2026-01-03', '元旦'],
    ['2026-02-15', '春节'],
    ['2026-02-23', '春节'],
    ['2026-04-04', '清明节'],
    ['2026-04-06', '清明节'],
    ['2026-05-01', '劳动节'],
    ['2026-05-05', '劳动节'],
    ['2026-06-19', '端午节'],
    ['2026-06-21', '端午节'],
    ['2026-09-25', '中秋节'],
    ['2026-09-27', '中秋节'],
    ['2026-10-01', '国庆节'],
    ['2026-10-07', '国庆节'],
  ];
  for (const [date, name] of cases) {
    assert.equal(findHoliday(date)?.name, name, `${date} 应属${name}`);
  }
});

test('节假日表：区间外与非 2026 年份都不命中', () => {
  for (const date of ['2026-01-04', '2026-09-24', '2026-09-28', '2026-10-08', '2027-10-01', '2025-10-01']) {
    assert.equal(findHoliday(date), null, `${date} 不该被判为节假日`);
  }
  // 格式非法一律不命中，不抛错
  for (const bad of ['', '2026-1-1', '2026/10/01', 'x', null, undefined]) {
    assert.equal(isPublicHoliday(bad), false);
    assert.equal(findHoliday(bad), null);
  }
});

test('闭馆豁免：落在法定节假日的周一不判闭馆（故宫 2026-10-05 国庆）', () => {
  const gugong = '08:30-17:00；周一闭馆；停止入园';
  // 2026-10-05 是周一，但在国庆假期内 → 按惯例故宫开放
  assert.equal(isClosedOnDate(gugong, '2026-10-05'), false);
  // 同一个文本，假期外的周一仍然闭馆
  assert.equal(isClosedOnDate(gugong, '2026-10-12'), true);
  // 节假日里的非周一同样不判闭馆（本来就是开放日）
  assert.equal(isClosedOnDate(gugong, '2026-10-06'), false);
});

test('闭馆豁免：不受调休上班日影响（周末上班不改变按星期判定）', () => {
  // 2026-09-20（周日）是调休上班日，但国庆假期未开始 → 周末不闭馆的文本照常
  assert.equal(isClosedOnDate('周一闭馆', '2026-09-20'), false);
  // 2026-10-10（周六）是调休上班日，同样不因「上班」而闭馆
  assert.equal(isClosedOnDate('周一闭馆', '2026-10-10'), false);
});
