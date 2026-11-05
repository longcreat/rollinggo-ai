import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSchedule, selectMealStop, type SchedulablePoi } from '../generation/scheduling/schedule';

const point = (id: string, lat: number, lng: number, category: 'food' | 'attraction' = 'attraction'): SchedulablePoi =>
  ({ id, name: id, lat, lng, category, score: 10, weight: 2 });

test('餐厅当日闭馆时使用附近区域，候选保留给开放日；未知日期保持距离判断', () => {
  const before = point('景点', 30.67, 104.05);
  const restaurant = { ...point('奎星楼街', 30.671, 104.05, 'food'), openTime: '周一闭馆' };
  const foods = new Set([restaurant]);
  for (const kind of ['lunch', 'dinner'] as const) {
    assert.equal(selectMealStop(foods, kind, before, undefined, '成都', '2026-10-19').areaAnchorName, before.name);
    assert.ok(foods.has(restaurant));
  }
  assert.equal(selectMealStop(foods, 'lunch', before, undefined, '成都', '2026-10-20').poi.id, restaurant.id);
  assert.equal(foods.size, 0);
  assert.equal(selectMealStop(new Set([restaurant]), 'lunch', before, undefined, '成都').poi.id, restaurant.id);
});

test('餐次使用整段交换后的实际日期，不把段序号当成日期', () => {
  const museum = { ...point('周一闭馆博物馆', 30.67, 104.05), score: 100, weight: 8, openTime: '周一闭馆' };
  const park = { ...point('开放公园', 30.68, 104.05), score: 90, weight: 8 };
  const restaurant = { ...point('周一休息餐厅', 30.675, 104.05, 'food'), openTime: '周一闭馆' };
  const result = buildSchedule([museum, park, restaurant], { days: 2, foodFocused: true, startDate: '2026-10-19', fallbackArea: '成都' });
  assert.equal(result.days[0]?.stops[0]?.poi.id, park.id);
  assert.equal(result.days[1]?.stops[0]?.poi.id, museum.id);
  assert.ok(!result.days[0]?.stops.some((stop) => stop.poi.id === restaurant.id));
  assert.ok(result.days[1]?.stops.some((stop) => stop.poi.id === restaurant.id));
  assert.deepEqual(result.closureConflicts, []);
});

test('午餐按前后景点增量绕行选点，而非只看离前一站最近', () => {
  const before = point('前站', 31, 121), after = point('后站', 31, 121.02);
  const backward = point('更近但回头', 31, 120.997, 'food');
  const onward = point('顺路餐厅', 31, 121.007, 'food');
  const foods = new Set([backward, onward]);
  const stop = selectMealStop(foods, 'lunch', before, after, '上海');
  assert.equal(stop.poi.id, onward.id);
  assert.ok(foods.has(backward) && !foods.has(onward));
});

test('拒绝远处分店但保留给附近日期，无合适门店时使用真实景点周边', () => {
  const pearl = point('东方明珠', 31.240547, 121.535454);
  const lujiazui = point('陆家嘴', 31.23096, 121.511835);
  const restaurant = point('鲜得来排骨年糕', 31.139937, 121.661004, 'food');
  const foods = new Set([restaurant]);
  const stop = selectMealStop(foods, 'lunch', pearl, lujiazui, '上海');
  assert.equal(stop.areaAnchorName, pearl.name);
  assert.equal(stop.poi.name, '东方明珠周边');
  assert.equal(stop.poi.lat, pearl.lat);
  assert.equal(stop.poi.lng, pearl.lng);
  assert.ok(foods.has(restaurant), '远端门店不能因为拒绝而被消耗');
  const nearRestaurant = point('餐厅附近景点', 31.14, 121.66);
  assert.equal(selectMealStop(foods, 'dinner', nearRestaurant, undefined, '上海').poi.id, restaurant.id);
});

test('门店或景点无坐标时不臆断距离，保持就餐区域语义', () => {
  const unknown: SchedulablePoi = { id: 'unknown', name: '未定位餐厅', category: 'food', score: 99, weight: 1 };
  const foods = new Set([unknown]);
  const nearby = point('真实景点', 39.9, 116.4);
  assert.equal(selectMealStop(foods, 'dinner', nearby, undefined, '北京').poi.name, '真实景点周边');
  const area = selectMealStop(foods, 'lunch', undefined, undefined, '北京');
  assert.equal(area.poi.name, '北京');
  assert.equal(area.poi.lat, undefined);
  assert.equal(foods.size, 1);
});

test('附近但绕路、顺路但距两端都远的餐厅均不入选', () => {
  const before = point('起点', 31, 121);
  // 距起点约 1.4km，但午餐往返会额外走约 2.8km。
  const backward = point('反方向餐厅', 31, 120.985, 'food');
  assert.equal(selectMealStop(new Set([backward]), 'lunch', before, point('终点', 31, 121.02), '上海').areaAnchorName, '起点');
  // 在长线中点，增量接近零，但离前后景点都约 4.8km。
  const midpoint = point('远端中途餐厅', 31, 121.05, 'food');
  assert.equal(selectMealStop(new Set([midpoint]), 'lunch', before, point('远端终点', 31, 121.1), '上海').areaAnchorName, '起点');
});
