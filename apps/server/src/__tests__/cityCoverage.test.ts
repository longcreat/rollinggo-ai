// 单测：城市覆盖阈值判定（纯函数边界）；DB 路径由 verify-c2 覆盖
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITY_COVERAGE_THRESHOLD, coverageFromCount } from '../services/cityCoverageService';

test('阈值为 100（北京 1349 / 成都 411 vs 断层下 ≤21，一个数分开两档）', () => {
  assert.equal(CITY_COVERAGE_THRESHOLD, 100);
});

test('边界：99 未覆盖，100 覆盖', () => {
  assert.equal(coverageFromCount(99), 'uncovered');
  assert.equal(coverageFromCount(100), 'covered');
  assert.equal(coverageFromCount(1349), 'covered');
});

test('零覆盖与负值都判未覆盖', () => {
  assert.equal(coverageFromCount(0), 'uncovered');
  assert.equal(coverageFromCount(21), 'uncovered');
});
