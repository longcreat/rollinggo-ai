// 单测：游览顺序种子表匹配（09-23）——别名命中、短名防误伤、跨城市不串、两端缺一不生效
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeOrderConstraints } from '../data/routeOrderSeeds';

test('两端都命中候选池才产出约束，且返回候选池里的实际名称', () => {
  const constraints = routeOrderConstraints('北京', ['故宫博物院', '景山公园', '天坛公园']);
  assert.deepEqual(constraints, [{ before: '故宫博物院', after: '景山公园' }]);
  // 别名命中：「故宫」命中故宫博物院、「景山」命中景山公园
  const byAlias = routeOrderConstraints('北京', ['故宫', '景山', '北海公园']);
  assert.deepEqual(byAlias, [{ before: '故宫', after: '景山' }]);
});

test('缺一端的约束不生效', () => {
  assert.deepEqual(routeOrderConstraints('北京', ['景山公园', '天坛公园']), []);
  assert.deepEqual(routeOrderConstraints('北京', ['故宫博物院']), []);
});

test('跨城市不串：上海候选不匹配北京种子', () => {
  assert.deepEqual(routeOrderConstraints('上海', ['故宫博物院', '景山公园']), []);
});

test('短名别名不误伤：「沈阳故宫」不命中「故宫」（≤2 字只全等）', () => {
  assert.deepEqual(routeOrderConstraints('北京', ['沈阳故宫', '景山公园']), []);
});
