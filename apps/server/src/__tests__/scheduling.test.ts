import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCHEDULE_LIMITS, buildSchedule, relatedPairKey, type SchedulablePoi } from '../generation/scheduling/schedule';
import { NEUTRAL_RATIO, poiScore, scoreMaxima } from '../generation/scheduling/score';
import { DEFAULT_VISIT_WEIGHT, isHeavy, visitWeight } from '../generation/scheduling/visitWeight';
import { DraftTrip } from '../generation/draft';

let seq = 0;
function poi(overrides: Partial<SchedulablePoi> & { name: string }): SchedulablePoi {
  seq += 1;
  return { id: `p${seq}`, category: 'attraction', score: 10, weight: 2, ...overrides };
}

/** 一列在城里均匀排开的坐标，保证最近邻成链有确定结果 */
function ring(index: number, total: number): { lat: number; lng: number } {
  const angle = (index / Math.max(1, total)) * 2 * Math.PI;
  return { lat: 39.9 + Math.cos(angle) * 0.05, lng: 116.4 + Math.sin(angle) * 0.05 };
}

const sumScore = (stops: { poi: SchedulablePoi }[]) => stops.reduce((sum, stop) => sum + stop.poi.score, 0);

test('所有节奏的美食行程预留餐次容量，空天及闭馆降级也满足完整性', () => {
  for (const pace of ['relaxed', 'moderate', 'tight'] as const) {
    for (const count of [0, 1, 8, 20]) {
      for (const closed of [false, true]) {
        const result = buildSchedule(Array.from({ length: count }, (_, i) => poi({
          name: `街区${i}`, weight: 1, score: 100 - i, ...ring(i, count),
          ...(closed ? { openTime: '周一、周二、周三闭馆' } : {}),
        })), { days: 3, foodFocused: true, pace, startDate: '2026-09-28' });
        const draft = new DraftTrip({ destination: '北京', days: 3, budgetLevel: '经济', partySize: 1,
          startDate: '', totalBudget: 0, preferences: ['美食'], extraNotes: '', pace });
        draft.setSkeleton('完整性回归', result.days.map((day) => day.title));
        for (const day of result.days) {
          assert.ok(day.stops.length <= 8, `${pace}/${count}: 活动数不得超过 8`);
          assert.deepEqual(day.stops.filter((stop) => stop.meal).map((stop) => stop.meal), ['lunch', 'dinner']);
          for (const stop of day.stops) draft.addActivity(day.dayIndex, {
            name: stop.meal ? `${stop.meal === 'lunch' ? '午餐' : '晚餐'}｜${stop.poi.name}` : stop.poi.name,
            category: stop.meal ? '美食' : '其他',
          });
        }
        assert.deepEqual(draft.validate(), [], `${pace}/${count}/${closed}`);
      }
    }
  }
});

test('先后约束同时约束起点、多个前置点和最终段内重排', () => {
  for (const afterScore of [70, 120]) {
    const result = buildSchedule([
      poi({ name: '起点', score: 100, lat: 39.9, lng: 116.4 }),
      poi({ name: '前置甲', score: 80, lat: 39.9, lng: 116.45 }),
      poi({ name: '前置乙', score: 75, lat: 39.9, lng: 116.46 }),
      poi({ name: '后置', score: afterScore, lat: 39.9, lng: 116.401 }),
    ], { days: 1, foodFocused: false, orderConstraints: [{ before: '前置甲', after: '后置' }, { before: '前置乙', after: '后置' }] });
    const names = result.days[0]!.stops.map((stop) => stop.poi.name);
    assert.ok(names.indexOf('前置甲') < names.indexOf('后置'));
    assert.ok(names.indexOf('前置乙') < names.indexOf('后置'));
  }
});

test('循环顺序约束有限退让，不挂起或丢点', () => {
  const result = buildSchedule([poi({ name: '甲', ...ring(0, 2) }), poi({ name: '乙', ...ring(1, 2) })], {
    days: 1, foodFocused: false, orderConstraints: [{ before: '甲', after: '乙' }, { before: '乙', after: '甲' }],
  });
  assert.equal(result.days[0]!.stops.length, 2);
});

test('日期匹配把灵活段让到后一天，保住唯一开放日的低分段', () => {
  const result = buildSchedule([
    poi({ name: '每日开放', score: 100, weight: 5, ...ring(0, 2) }),
    poi({ name: '周二闭馆', score: 90, weight: 5, openTime: '周二闭馆', ...ring(1, 2) }),
  ], { days: 2, foodFocused: false, startDate: '2026-09-28' });
  assert.deepEqual(result.days.map((day) => day.stops[0]!.poi.name), ['周二闭馆', '每日开放']);
  assert.equal(result.droppedCount, 0);
  assert.deepEqual(result.closureConflicts, []);
});

test('日期匹配支持多段连锁换日与最大 15 天，且不改变无约束时的优先顺序', () => {
  const candidates = Array.from({ length: 15 }, (_, i) => poi({ name: `景点${i}`, score: 100 - i, weight: 5, ...ring(i, 15) }));
  const result = buildSchedule(candidates, { days: 15, foodFocused: false });
  assert.equal(result.droppedCount, 0);
  assert.deepEqual(result.days.map((day) => day.stops[0]!.poi.name), candidates.map((p) => p.name));
  const constrained = buildSchedule([
    poi({ name: '灵活', score: 100, weight: 5, ...ring(0, 3) }),
    poi({ name: '仅周一', score: 90, weight: 5, openTime: '周二、周三闭馆', ...ring(1, 3) }),
    poi({ name: '仅周二', score: 80, weight: 5, openTime: '周一、周三闭馆', ...ring(2, 3) }),
  ], { days: 3, foodFocused: false, startDate: '2026-09-28' });
  assert.deepEqual(constrained.days.map((day) => day.stops[0]!.poi.name), ['仅周一', '仅周二', '灵活']);
});

test('选点权重：缺失分走中性（不当 0），金集另有加分', () => {
  const maxima = { score: 50, mention: 20 };
  assert.equal(poiScore({ recommendScore: 50, mentionCount: 20, source: 'xhs' }, maxima), 100);
  // 分数全缺：质量/热度各取中性 0.5，金集再加 15
  assert.equal(poiScore({ source: 'goldset' }, maxima), NEUTRAL_RATIO * 60 + NEUTRAL_RATIO * 40 + 15);
  assert.equal(poiScore({ source: 'xhs' }, maxima), NEUTRAL_RATIO * 60 + NEUTRAL_RATIO * 40);
  assert.equal(poiScore(undefined, maxima), NEUTRAL_RATIO * 60 + NEUTRAL_RATIO * 40);
  // 金集地标（无分数）必须排在同为无数据的普通点前面 —— 修的就是这个反转
  assert.ok(poiScore({ source: 'goldset' }, maxima) > poiScore({ source: 'xhs' }, maxima));
  // 金集自带分数时，和同样有分的点比仍然是「金集优先」
  assert.ok(poiScore({ recommendScore: 40, source: 'goldset' }, maxima) > poiScore({ recommendScore: 40, source: 'xhs' }, maxima));
});

test('归一化基准只统计有值样本，缺失值不拉低整体', () => {
  assert.deepEqual(scoreMaxima([{ recommendScore: 10, mentionCount: 2 }, { source: 'goldset' }]), {
    score: 10,
    mention: 2,
  });
  assert.deepEqual(scoreMaxima([{ source: 'goldset' }, undefined]), { score: 0, mention: 0 });
});

test('停留分量：细粒度类型表 → 类目表 → 默认值', () => {
  assert.equal(visitWeight({ placeType: 'scenic_area', category: '文化' }), 3);
  assert.equal(visitWeight({ placeType: 'attraction', category: '文化' }), 2);
  assert.equal(visitWeight({ placeType: 'museum', category: '文化' }), 2);
  assert.equal(visitWeight({ placeType: 'street', category: '文化' }), 1);
  // 无 placeType 时退类目表（金集快照类候选只有这张表）
  assert.equal(visitWeight({ category: '自然' }), 2);
  assert.equal(visitWeight({ category: '购物' }), 1);
  assert.equal(visitWeight({}), DEFAULT_VISIT_WEIGHT);
  assert.equal(visitWeight(undefined), DEFAULT_VISIT_WEIGHT);
  assert.equal(isHeavy('scenic_area'), true);
  assert.equal(isHeavy('street'), false);
});

test('按停留分量切段：每天分量不超上限、个数不超单日上限', () => {
  // 6 个「大点」（分量 3）：上限 7 → 每段只能放 2 个（3+3=6，再加一个就 9 > 7）
  const candidates = Array.from({ length: 6 }, (_, i) =>
    poi({ name: `大点${i}`, score: 100 - i, weight: 3, ...ring(i, 6) }),
  );
  const result = buildSchedule(candidates, { days: 3, foodFocused: false });

  assert.equal(result.days.length, 3);
  for (const day of result.days) {
    const weight = day.stops.reduce((sum, stop) => sum + stop.poi.weight, 0);
    assert.ok(weight <= SCHEDULE_LIMITS.dayWeightLimit, `第${day.dayIndex}天分量 ${weight} 超上限`);
    assert.ok(day.stops.length <= SCHEDULE_LIMITS.maxStopsPerDay);
  }
  assert.equal(result.days.flatMap((day) => day.stops).length, 6);
  assert.equal(result.droppedCount, 0);
});

test('节奏决定每日容量：轻松少排、紧凑多排、适中保持既有上限（09-26）', () => {
  // 13 个普通点（分量 2，3 天）：
  // relaxed 容量 3×5=15 → 选 7 个，切段每段 ≤2 → 3 天排 6 个；
  // moderate 容量 3×8=24 → 选 12 个，每段 ≤4 → 排 12 个；
  // tight 容量 3×12=36 → 全选 13 个，每段 ≤6 → 排 13 个。
  const candidates = Array.from({ length: 13 }, (_, i) => poi({ name: `点${i}`, score: 100 - i, ...ring(i, 13) }));
  const count = (r: { days: { stops: unknown[] }[] }) => r.days.flatMap((d) => d.stops).length;
  assert.equal(count(buildSchedule(candidates, { days: 3, foodFocused: false, pace: 'relaxed' })), 6);
  assert.equal(count(buildSchedule(candidates, { days: 3, foodFocused: false, pace: 'moderate' })), 12);
  assert.equal(count(buildSchedule(candidates, { days: 3, foodFocused: false, pace: 'tight' })), 13);
});

test('容量不足时按分数丢弃：低分先出局，高分必留', () => {
  const candidates = Array.from({ length: 20 }, (_, i) => poi({ name: `点${i}`, score: 100 - i, ...ring(i, 20) }));
  const result = buildSchedule(candidates, { days: 2, foodFocused: false });

  assert.equal(result.days.length, 2);
  assert.ok(result.days.every((day) => day.stops.length <= SCHEDULE_LIMITS.maxStopsPerDay));
  assert.equal(result.droppedCount, 20 - result.days.reduce((sum, day) => sum + day.stops.length, 0));
  const kept = new Set(result.days.flatMap((day) => day.stops.map((stop) => stop.poi.name)));
  assert.ok(kept.has('点0'), '最高分必须留下');
  assert.equal(kept.has('点19'), false, '最低分必须被丢弃');
});

test('强独占级地点独占一天，不与市区点混排', () => {
  const candidates = [
    poi({ name: '远郊长城', score: 90, lat: 40.35, lng: 116.02 }),
    poi({ name: '甲馆', score: 50, ...ring(0, 3) }),
    poi({ name: '乙园', score: 40, ...ring(1, 3) }),
    poi({ name: '丙寺', score: 30, ...ring(2, 3) }),
  ];
  const result = buildSchedule(candidates, { days: 2, foodFocused: false, exclusiveNames: ['远郊长城'] });

  assert.deepEqual(result.days[0]!.stops.map((stop) => stop.poi.name), ['远郊长城']);
  assert.deepEqual(
    result.days[1]!.stops.map((stop) => stop.poi.name).sort(),
    ['丙寺', '乙园', '甲馆'].sort(),
  );
  assert.equal(result.droppedCount, 0);
});

test('强独占级最多占一半天数：3 天行程只保留分数最高的那个远郊点', () => {
  const candidates = [
    poi({ name: '八达岭长城', score: 95, lat: 40.35, lng: 116.02 }),
    poi({ name: '慕田峪长城', score: 90, lat: 40.43, lng: 116.57 }),
    ...Array.from({ length: 5 }, (_, i) => poi({ name: `市区点${i}`, score: 60 - i, ...ring(i, 5) })),
  ];
  const result = buildSchedule(candidates, {
    days: 3,
    foodFocused: false,
    exclusiveNames: ['八达岭长城', '慕田峪长城'],
  });

  const names = result.days.flatMap((day) => day.stops.map((stop) => stop.poi.name));
  assert.ok(names.includes('八达岭长城'), '高分远郊点必须留下');
  assert.equal(names.includes('慕田峪长城'), false, '同类远郊点被上限挤掉');
  assert.equal(result.droppedCount, 1);
  // 剩下 2 天全部给市区点，且不超单日上限
  assert.equal(result.days.length, 3);
  assert.ok(result.days.every((day) => day.stops.length <= SCHEDULE_LIMITS.maxStopsPerDay));
  assert.equal(result.days.flatMap((day) => day.stops).length, 6);
});

test('独占点数超过上限时按分数如实丢弃，不把远端点塞进市区天', () => {
  const candidates = ['远郊甲', '远郊乙', '远郊丙'].map((name, i) =>
    poi({ name, score: 90 - i, lat: 40.4 + i * 0.01, lng: 116.0 }),
  );
  const result = buildSchedule(candidates, {
    days: 2,
    foodFocused: false,
    exclusiveNames: ['远郊甲', '远郊乙', '远郊丙'],
  });

  // 2 天 → 上限 1 天给远郊，另 1 天空出来走占位
  assert.deepEqual(result.days[0]!.stops.map((stop) => stop.poi.name), ['远郊甲']);
  assert.equal(result.droppedCount, 2);
});

test('无坐标候选不参与成链但照样排入（坐标由 geoPipeline 事后解析）', () => {
  const candidates = [
    poi({ name: '甲馆', score: 50, lat: 39.9, lng: 116.4 }),
    poi({ name: '乙园', score: 40, lat: 39.91, lng: 116.41 }),
    poi({ name: '无坐标馆', score: 30 }),
  ];
  const result = buildSchedule(candidates, { days: 1, foodFocused: false });

  assert.deepEqual(
    result.days[0]!.stops.map((stop) => stop.poi.name).sort(),
    ['甲馆', '乙园', '无坐标馆'].sort(),
  );
  assert.equal(result.droppedCount, 0);
});

test('美食导向每天必有午餐与晚餐；非美食导向一个餐次都没有', () => {
  const candidates = [
    poi({ name: '甲馆', score: 50, lat: 39.9, lng: 116.4 }),
    poi({ name: '乙园', score: 40, lat: 39.91, lng: 116.41 }),
    poi({ name: '南锣鼓巷小吃街', category: 'food', score: 5, lat: 39.937, lng: 116.403 }),
    poi({ name: '前门片食', category: 'food', score: 4, lat: 39.899, lng: 116.398 }),
  ];

  const free = buildSchedule(candidates, { days: 1, foodFocused: false });
  assert.ok(free.days[0]!.stops.every((stop) => stop.meal === undefined));

  const focused = buildSchedule(candidates, { days: 1, foodFocused: true, fallbackArea: '北京' });
  assert.deepEqual(
    focused.days[0]!.stops.filter((stop) => stop.meal).map((stop) => stop.meal),
    ['lunch', 'dinner'],
  );
  assert.ok(focused.days[0]!.stops.filter((stop) => stop.meal).every((stop) => stop.poi.category === 'food'));
});

test('美食导向没有美食候选时用景点周边补齐餐次（餐次是硬门槛）', () => {
  const result = buildSchedule([poi({ name: '甲馆', score: 50, lat: 39.9, lng: 116.4 })], {
    days: 1,
    foodFocused: true,
    fallbackArea: '北京',
  });
  const meals = result.days[0]!.stops.filter((stop) => stop.meal);
  assert.deepEqual(meals.map((stop) => stop.meal), ['lunch', 'dinner']);
  assert.ok(meals.every((stop) => stop.poi.name === '甲馆周边' && stop.areaAnchorName === '甲馆'));
  assert.ok(meals.every((stop) => stop.poi.lat === 39.9 && stop.poi.lng === 116.4));
});

test('候选排不满天数：空天用占位活动兜底（保住每天至少一个活动）', () => {
  const result = buildSchedule([poi({ name: '甲馆', score: 50, lat: 39.9, lng: 116.4 })], {
    days: 3,
    foodFocused: false,
    fallbackArea: '北京',
  });

  assert.equal(result.days.length, 3);
  assert.deepEqual(result.days[0]!.stops.map((stop) => stop.poi.name), ['甲馆']);
  for (const day of result.days.slice(1)) {
    assert.equal(day.stops.length, 1);
    assert.ok(day.stops[0]!.poi.name.startsWith(SCHEDULE_LIMITS.emptyDayPrefix));
    assert.equal(day.title, SCHEDULE_LIMITS.emptyDayPrefix);
  }
  assert.equal(result.droppedCount, 0);
});

test('段按权重降序分天：总分最高的段拿 Day1（分数管分天 D1）', () => {
  const candidates = Array.from({ length: 6 }, (_, i) => poi({ name: `点${i}`, score: 100 - i * 10, ...ring(i, 6) }));
  const result = buildSchedule(candidates, { days: 3, foodFocused: false });

  const weights = result.days.map((day) => sumScore(day.stops));
  assert.deepEqual(weights, [...weights].sort((a, b) => b - a), `Day1..k 的段权重应递减，实际 ${weights.join(',')}`);
});

test('每天主题取成员 themes 众数；无 themes 时回退知识库 8 类目', () => {
  const themed = buildSchedule(
    [
      poi({ name: '甲馆', theme: '人文老城', score: 50, lat: 39.9, lng: 116.4 }),
      poi({ name: '乙园', theme: '人文老城', score: 40, lat: 39.91, lng: 116.41 }),
      poi({ name: '丙市', theme: '城市漫步', score: 30, lat: 39.92, lng: 116.42 }),
    ],
    { days: 1, foodFocused: false },
  );
  assert.equal(themed.days[0]!.title, '人文老城');

  const fallback = buildSchedule([poi({ name: '甲馆', kbCategory: '自然', score: 50, lat: 39.9, lng: 116.4 })], {
    days: 1,
    foodFocused: false,
  });
  assert.equal(fallback.days[0]!.title, '自然');

  const neither = buildSchedule([poi({ name: '甲馆', score: 50, lat: 39.9, lng: 116.4 })], {
    days: 1,
    foodFocused: false,
  });
  assert.equal(neither.days[0]!.title, '自由漫步');
});

// ---------- 闭馆日避让（09-22-opentime） ----------

test('段→天分配避让闭馆日：高分段不再铁定落 Day1', () => {
  // 两个大点各自成段（weight 5+5=10 > dayWeightLimit 8）；startDate 周一。
  // 甲馆「周一闭馆」分数最高 → 不避让时会落 Day1（周一），避让后应落 Day2（周二）。
  const result = buildSchedule(
    [
      poi({ name: '甲馆', score: 100, weight: 5, openTime: '09:00-17:00；周一闭馆', lat: 39.9, lng: 116.4 }),
      poi({ name: '乙园', score: 90, weight: 5, lat: 39.91, lng: 116.41 }),
    ],
    { days: 2, foodFocused: false, startDate: '2026-09-21' },
  );
  const day1Names = result.days[0]!.stops.map((s) => s.poi.name);
  const day2Names = result.days[1]!.stops.map((s) => s.poi.name);
  assert.ok(day2Names.includes('甲馆'), `甲馆周一闭馆，应避让到 Day2，实际 Day1=${day1Names} Day2=${day2Names}`);
  assert.ok(day1Names.includes('乙园'));
});

test('闭馆日避让：无 startDate 时不干预分天（拿不准不校验）', () => {
  const result = buildSchedule(
    [
      poi({ name: '甲馆', score: 100, weight: 5, openTime: '周一闭馆', lat: 39.9, lng: 116.4 }),
      poi({ name: '乙园', score: 90, weight: 5, lat: 39.91, lng: 116.41 }),
    ],
    { days: 2, foodFocused: false },
  );
  // 分数高 → Day1（与避让前行为一致）
  assert.equal(result.days[0]!.stops[0]!.poi.name, '甲馆');
});

test('闭馆日无解保留景点和结构化冲突，不用删点或空天掩盖', () => {
  const result = buildSchedule(
    [poi({ name: '甲馆', score: 100, weight: 5, openTime: '周一、周二闭馆', lat: 39.9, lng: 116.4 })],
    { days: 1, foodFocused: false, startDate: '2026-09-21', fallbackArea: '北京' },
  );
  assert.equal(result.days[0]!.stops[0]!.poi.name, '甲馆', '保留诊断，由 buildDraft 拒绝写入');
  assert.equal(result.droppedCount, 0);
  assert.equal(result.dateRepair.reason, 'no_open_day');
  assert.equal(result.closureConflicts.length, 1);
  assert.deepEqual(result.closureConflicts[0]!.names, ['甲馆']);
  assert.equal(result.closureConflicts[0]!.date, '2026-09-21');
  assert.equal(result.closureConflicts[0]!.holiday, null);
});

test('两个闭馆组竞争唯一开放日且独占不能合并时明确无解', () => {
  // 复刻实测：2 天行程、startDate 2026-09-28（周一）。
  // 故宫段（3 人，只有故宫周一闭馆）与八达岭段（1 人，整段闭馆）争两个天。
  // 旧行为：八达岭段被塞进周一（它自己闭馆）→ 那天完全作废。
  // 修复不能将八达岭与市区合并，也不能删掉任何已选景点。
  const result = buildSchedule(
    [
      poi({ name: '故宫', score: 115, weight: 3, openTime: '周一闭馆', lat: 39.9187, lng: 116.397 }),
      poi({ name: '景山', score: 83, weight: 2, lat: 39.9259, lng: 116.3966 }),
      poi({ name: '北海', score: 59, weight: 2, lat: 39.9278, lng: 116.3887 }),
      poi({ name: '八达岭', score: 69, weight: 3, openTime: '周一闭馆', lat: 40.3616, lng: 116.0113 }),
    ],
    { days: 2, foodFocused: false, exclusiveNames: ['八达岭'], startDate: '2026-09-28', fallbackArea: '北京' },
  );
  const namesByDay = result.days.map((d) => d.stops.map((s) => s.poi.name));
  assert.equal(namesByDay.flat().length, 4);
  assert.equal(namesByDay.find((day) => day.includes('八达岭'))!.length, 1);
  assert.equal(result.droppedCount, 0);
  assert.equal(result.closureConflicts.length, 1);
  assert.equal(result.dateRepair.reason, 'search_exhausted');
  assert.equal(result.closureConflicts[0]!.date, '2026-09-28');
});

test('闭馆日避让：段内部分闭馆仍可分配（只避开人数，不弃整段）', () => {
  // 故宫周一闭馆但景山/北海开放 → 该段放周一仍有 2 个点可游，不该被整体丢弃。
  // （与上一条的差别：这里只有一个段，且它不是「整段闭馆」）
  const result = buildSchedule(
    [
      poi({ name: '故宫', score: 115, weight: 2, openTime: '周一闭馆', lat: 39.9187, lng: 116.397 }),
      poi({ name: '景山', score: 83, weight: 2, lat: 39.9259, lng: 116.3966 }),
    ],
    { days: 2, foodFocused: false, startDate: '2026-09-28', fallbackArea: '北京' },
  );
  assert.equal(result.droppedCount, 0, '有部分成员开放的段不该被丢弃');
  assert.equal(result.closureConflicts.length, 0);
  const all = result.days.flatMap((d) => d.stops.map((s) => s.poi.name));
  assert.ok(all.includes('故宫') && all.includes('景山'));
});

// ---------- 顺序种子表（09-23） ----------

test('顺序约束：景山必须在故宫之后进链（出入口方向修正）', () => {
  // 景山离故宫质心极近，纯距离最近邻会把景山排前面（实测北京 3 日就是这么错的）
  const result = buildSchedule(
    [
      poi({ name: '故宫博物院', score: 90, weight: 3, lat: 39.9163, lng: 116.3972 }),
      poi({ name: '景山公园', score: 80, weight: 2, lat: 39.9251, lng: 116.3966 }),
      poi({ name: '天坛公园', score: 70, weight: 3, lat: 39.8822, lng: 116.4066 }),
    ],
    {
      days: 1,
      foodFocused: false,
      orderConstraints: [{ before: '故宫博物院', after: '景山公园' }],
    },
  );
  const names = result.days[0]!.stops.map((s) => s.poi.name);
  assert.ok(names.indexOf('故宫博物院') < names.indexOf('景山公园'), `期望故宫在景山前，实际：${names.join('→')}`);
});

test('顺序约束：约束一端缺席时不生效，两端在但无坐标时退让纯距离', () => {
  // 只有景山没有故宫 → 约束不生效，景山可以排第一
  const onlyAfter = buildSchedule(
    [poi({ name: '景山公园', score: 80, weight: 2, lat: 39.9251, lng: 116.3966 }), poi({ name: '天坛公园', score: 70, weight: 3, lat: 39.8822, lng: 116.4066 })],
    { days: 1, foodFocused: false, orderConstraints: [{ before: '故宫博物院', after: '景山公园' }] },
  );
  assert.equal(onlyAfter.days[0]!.stops[0]!.poi.name, '景山公园');
  // 故宫无坐标（stranded）→ 约束退让，景山照常按距离排
  const strandedPred = buildSchedule(
    [
      poi({ name: '故宫博物院', score: 90, weight: 3 }),  // 无坐标
      poi({ name: '景山公园', score: 80, weight: 2, lat: 39.9251, lng: 116.3966 }),
      poi({ name: '天坛公园', score: 70, weight: 3, lat: 39.8822, lng: 116.4066 }),
    ],
    { days: 1, foodFocused: false, orderConstraints: [{ before: '故宫博物院', after: '景山公园' }] },
  );
  assert.ok(strandedPred.days[0]!.stops.length > 0, '退让后仍应产出正常排程');
});

// ---------- 同类远郊点：独占上限挤掉低分者（09-23） ----------

test('双长城场景：两个强独占级候选 → 低分者不入选（droppedCount 计入）', () => {
  const result = buildSchedule(
    [
      poi({ name: '故宫博物院', score: 100, weight: 3, lat: 39.9163, lng: 116.3972 }),
      poi({ name: '景山公园', score: 60, weight: 2, lat: 39.9251, lng: 116.3966 }),
      poi({ name: '慕田峪长城', score: 50, weight: 3, lat: 40.4319, lng: 116.5703 }),
      poi({ name: '八达岭长城', score: 40, weight: 3, lat: 40.3598, lng: 116.0201 }),
    ],
    { days: 3, foodFocused: false, exclusiveNames: ['慕田峪长城', '八达岭长城'] },
  );
  const allNames = result.days.flatMap((d) => d.stops.map((s) => s.poi.name));
  assert.ok(allNames.includes('慕田峪长城'), '高分独占点应入选');
  assert.ok(!allNames.includes('八达岭长城'), '第二个长城应被独占上限挤掉');
  assert.equal(result.droppedCount, 1);
});

// ---------- POI 关联对：同天聚类的距离折扣（09-27） ----------

/** 4 个分量 3 的点 → 切两段（每段 2 个），模拟两天行程 */
const relationFixture = (): SchedulablePoi[] => [
  poi({ name: '甲', score: 100, weight: 3, lat: 39.9, lng: 116.4 }),
  poi({ name: '乙', score: 60, weight: 3, lat: 39.9, lng: 116.4155 }), // 离甲 1.32km
  poi({ name: '丙', score: 50, weight: 3, lat: 39.9, lng: 116.4094 }), // 离甲 0.80km（比乙近）
  poi({ name: '丁', score: 40, weight: 3, lat: 39.9, lng: 116.5 }),
];

const dayIndexByName = (result: ReturnType<typeof buildSchedule>, name: string): number =>
  result.days.find((d) => d.stops.some((s) => s.poi.name === name))!.dayIndex;

test('关联对：命中后距离打折，两点被拉到同一天（无关联时按纯几何分开）', () => {
  const without = buildSchedule(relationFixture(), { days: 2, foodFocused: false });
  assert.notEqual(
    dayIndexByName(without, '甲'),
    dayIndexByName(without, '乙'),
    '无关联对时按纯几何：丙插在甲乙之间，乙落到第二天',
  );

  const withRelation = buildSchedule(relationFixture(), {
    days: 2,
    foodFocused: false,
    relatedPairs: new Set([relatedPairKey('甲', '乙')]),
  });
  assert.equal(
    dayIndexByName(withRelation, '甲'),
    dayIndexByName(withRelation, '乙'),
    '命中关联对后成链相邻，两点落进同一天',
  );
});

test('关联对：不传或传空集合时排程输出与接入前一致（回归）', () => {
  const shape = (result: ReturnType<typeof buildSchedule>) =>
    result.days.map((d) => d.stops.map((s) => s.poi.name).join('→'));
  const base = buildSchedule(relationFixture(), { days: 2, foodFocused: false });
  const empty = buildSchedule(relationFixture(), { days: 2, foodFocused: false, relatedPairs: new Set() });
  assert.deepEqual(shape(empty), shape(base));
});

test('关联对：无关候选不受影响，集合里不存在的 pair 不改变链', () => {
  const shape = (result: ReturnType<typeof buildSchedule>) =>
    result.days.map((d) => d.stops.map((s) => s.poi.name).join('→'));
  const base = buildSchedule(relationFixture(), { days: 2, foodFocused: false });
  const unrelated = buildSchedule(relationFixture(), {
    days: 2,
    foodFocused: false,
    relatedPairs: new Set([relatedPairKey('丙', '丁')]),
  });
  // 丙丁本就近，打折后仍与基线同形状
  assert.deepEqual(shape(unrelated), shape(base));
});
