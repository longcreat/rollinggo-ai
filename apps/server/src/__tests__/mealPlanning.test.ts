import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Activity, GenerateForm, TransitLeg } from '@tripweaver/shared';
import { DraftTrip } from '../generation/draft';
import { ensureMealCoverage, isFoodFocused, isMeal, mealCoverageProblems, missingMeals } from '../generation/mealPlanning';

function activity(name: string, startTime: string, category: Activity['category'] = '其他', overrides: Partial<Activity> = {}): Activity {
  return {
    id: name,
    name,
    startTime,
    endTime: startTime ? `${String(Math.min(23, Number(startTime.slice(0, 2)) + 1)).padStart(2, '0')}:${startTime.slice(3)}` : '',
    description: '',
    lat: 31.23,
    lng: 121.47,
    coordSource: 'geocoded',
    category,
    sourceNotes: [],
    ...overrides,
  };
}

test('餐次识别：显式名称优先；未标注的美食活动按午晚餐窗口识别', () => {
  assert.equal(isMeal(activity('午饭｜老城小吃', '10:30'), 'lunch'), true);
  assert.equal(isMeal(activity('本地面馆', '12:30', '美食'), 'lunch'), true);
  assert.equal(isMeal(activity('本地面馆', '16:20', '美食'), 'lunch'), false);
  assert.equal(isMeal(activity('晚餐｜江边片区 · 当地菜', '18:30'), 'dinner'), true);
  assert.equal(isMeal(activity('夜市散步', '19:00', '娱乐'), 'dinner'), false);
});

test('餐次完整性逐日点名缺失的午餐和晚餐', () => {
  const days = [
    { activities: [activity('午餐｜老城 · 面食', '12:00', '美食')] },
    { activities: [activity('景点', '09:00')] },
  ];
  assert.deepEqual(missingMeals(days), [
    { dayIndex: 1, kind: 'dinner' },
    { dayIndex: 2, kind: 'lunch' },
    { dayIndex: 2, kind: 'dinner' },
  ]);
  assert.deepEqual(mealCoverageProblems(days, { foodFocused: true }), [
    '第 1 天缺少晚餐（需安排就餐区域、菜系或代表菜，并预留明确时段）',
    '第 2 天缺少午餐（需安排就餐区域、菜系或代表菜，并预留明确时段）',
    '第 2 天缺少晚餐（需安排就餐区域、菜系或代表菜，并预留明确时段）',
  ]);
});

test('非美食导向时餐次不算完整性问题（09-21 D3/D6）', () => {
  const days = [{ activities: [activity('景点', '09:00')] }];
  assert.deepEqual(mealCoverageProblems(days, { foodFocused: false }), []);
  assert.equal(isFoodFocused(['文化', '自然']), false);
  assert.equal(isFoodFocused(['文化', '美食']), true);
  assert.equal(isFoodFocused(undefined), false);
  assert.equal(isFoodFocused([]), false);
});

test('DraftTrip.validate 只在偏好含「美食」时把午晚餐作为提交门槛', () => {
  const makeDraft = (preferences: GenerateForm['preferences']) => {
    const draft = new DraftTrip({
      destination: '上海',
      days: 1,
      startDate: '',
      budgetLevel: '舒适',
      totalBudget: 0,
      preferences,
      partySize: 2,
      extraNotes: '',
    });
    draft.setSkeleton('上海一日', ['城市漫步']);
    draft.addActivity(1, { name: '外滩', startTime: '09:00', endTime: '11:00', category: '文化' });
    return draft;
  };

  const foodFocused = makeDraft(['美食']);
  assert.ok(foodFocused.validate().some((problem) => problem.includes('缺少午餐')));
  assert.ok(foodFocused.validate().some((problem) => problem.includes('缺少晚餐')));

  foodFocused.addActivity(1, { name: '午餐｜南京东路 · 本帮菜', startTime: '12:00', endTime: '13:15', category: '美食' });
  foodFocused.addActivity(1, { name: '晚餐｜人民广场 · 上海小吃', startTime: '18:00', endTime: '19:15', category: '美食' });
  assert.deepEqual(foodFocused.validate(), []);

  // 非美食导向：纯景点行程也是完整行程
  assert.deepEqual(makeDraft(['文化']).validate(), []);
});

test('最终兜底只补缺失餐次，按时间插入、清空旧 legs 且不生成费用', () => {
  const staleLeg: TransitLeg = {
    fromActivityId: 'lunch',
    toActivityId: 'museum',
    mode: 'walk',
    durationMin: 10,
    distanceM: 600,
    source: 'heuristic',
  };
  const lunch = activity('午餐｜老城 · 面食', '12:00', '美食', { id: 'lunch', endTime: '13:15' });
  const days = [
    {
      activities: [
        activity('上午景点', '09:00', '文化', { endTime: '11:00' }),
        lunch,
        activity('博物馆', '15:00', '文化', { id: 'museum', endTime: '17:00' }),
        activity('夜景', '20:00', '娱乐', { endTime: '21:00' }),
      ],
      legs: [staleLeg],
    },
  ];

  const inserted = ensureMealCoverage(days, '西安');
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0]?.kind, 'dinner');
  assert.equal(inserted[0]?.action, 'inserted');
  assert.equal(days[0]?.activities[1], lunch, '已有午餐不得替换');
  const dinner = days[0]?.activities.find((item) => item.name.startsWith('晚餐｜'));
  assert.ok(dinner);
  assert.equal(dinner.startTime, '18:00');
  assert.equal(dinner.category, '美食');
  assert.equal(dinner.coordSource, 'estimated');
  assert.equal('cost' in dinner, false);
  assert.match(dinner.description, /大众点评或美团确认/);
  assert.deepEqual(days[0]?.activities.map((item) => item.startTime), ['09:00', '12:00', '15:00', '18:00', '20:00']);
  assert.equal(days[0]?.legs, undefined, '插入活动后旧相邻段必须失效');
  assert.deepEqual(missingMeals(days), []);
});

test('餐窗没有空档时把餐次整合进跨窗活动，不制造重叠活动', () => {
  const longVisit = activity('远郊一日游', '09:00', '文化', { endTime: '21:30', description: '全天活动' });
  const days = [{ activities: [longVisit] }];
  const repairs = ensureMealCoverage(days, '北京');
  assert.equal(days[0]?.activities.length, 1);
  assert.deepEqual(repairs.map((item) => item.action), ['integrated', 'integrated']);
  assert.match(longVisit.name, /午餐安排/);
  assert.match(longVisit.name, /晚餐安排/);
  assert.match(longVisit.description, /大众点评或美团确认/);
  assert.deepEqual(missingMeals(days), []);
});

test('自动补餐与相邻活动至少保留 15 分钟移动缓冲', () => {
  const days = [
    {
      activities: [
        activity('上午景点', '10:30', '文化', { endTime: '13:00' }),
        activity('下午景点', '15:30', '自然', { endTime: '17:30' }),
        activity('晚餐｜景区周边 · 当地菜', '18:00', '美食', { endTime: '19:15' }),
      ],
    },
  ];
  const repairs = ensureMealCoverage(days, '乌兰察布');
  const lunch = days[0]!.activities.find((item) => item.name.startsWith('午餐｜'))!;
  assert.equal(repairs[0]?.kind, 'lunch');
  assert.equal(lunch.startTime, '13:15');
  assert.equal(lunch.endTime, '14:30');
});
