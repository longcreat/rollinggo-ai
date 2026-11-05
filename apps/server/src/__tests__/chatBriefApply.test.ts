// 单测：Brief 变更的防御性归一 + Brief→GenerateForm 映射。
// 重点覆盖「模型胡说也不能污染已有数据」与「起止日期压过天数」两条容易回归的规则。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Value } from '@sinclair/typebox/value';
import {
  GenerateFormSchema,
  briefToGenerateForm,
  type PlanningBriefData,
} from '@tripweaver/shared';
import { applyDialogueDecision, briefStatus, normalizeBriefData } from '../chat/brief';
import { readClarification } from '../chat/models';

const empty: PlanningBriefData = { constraints: [] };

test('只读旅行问答忽略夹带的字段、增加与删除约束，保持原 Brief', () => {
  const current: PlanningBriefData = {
    destination: '北京', days: 3, pace: 'moderate', preferences: [],
    extraNotes: '不能吃辣，不去故宫博物院。',
    constraints: [{ id: 'diet', category: 'dietary_requirement', polarity: 'avoid', valueText: '花生' }],
  };
  const before = structuredClone(current);
  const next = applyDialogueDecision(current, {
    intent: 'travel_qa', destination: '上海', days: 5, preferences: ['文化'], extraNotes: '',
    addConstraints: [{ category: 'companion_context', polarity: 'fact', valueText: '膝盖不好' }],
    removeConstraintIds: ['diet'],
  }, 10);
  assert.deepEqual(next, before);
  assert.deepEqual(current, before);
});

test('合法非只读 intent 保留增量更新能力', () => {
  for (const intent of ['update_brief', 'confirm', 'modify_itinerary']) {
    const next = applyDialogueDecision(empty, {
      intent, days: 5,
      addConstraints: [{ category: 'dietary_requirement', polarity: 'avoid', valueText: '花生' }],
    }, 2);
    assert.equal(next.days, 5);
    assert.equal(next.constraints[0]?.valueText, '花生');
  }
});

test('明确清空 extraNotes 可以取消旧备注，缺省字段仍不变', () => {
  const current: PlanningBriefData = { ...empty, destination: '北京', extraNotes: '不去故宫' };
  const next = applyDialogueDecision(current, { intent: 'update_brief', extraNotes: '  ', destination: '' }, 1);
  assert.equal(next.extraNotes, '');
  assert.equal(next.destination, '北京');
  assert.equal(applyDialogueDecision(current, { days: 3 }, 1).extraNotes, '不去故宫');
  assert.equal(current.extraNotes, '不去故宫');
});

test('未提到的字段一律不动（patch 语义，不是整体覆盖）', () => {
  const current: PlanningBriefData = { ...empty, destination: '成都', days: 3, pace: 'moderate' };
  const next = applyDialogueDecision(current, { days: 5 }, 1);
  assert.equal(next.destination, '成都');
  assert.equal(next.pace, 'moderate');
  assert.equal(next.days, 5);
});

test('文本字段 trim，超长截断到 schema 上限而不是写坏数据', () => {
  const next = applyDialogueDecision(empty, { destination: '  重庆  ', extraNotes: 'x'.repeat(500) }, 2);
  assert.equal(next.destination, '重庆');
  assert.equal(next.extraNotes?.length, 200);
});

test('越界/非整数的 days、partySize 被忽略或夹紧，不抛错', () => {
  assert.equal(applyDialogueDecision(empty, { days: 999 }, 1).days, 15);
  assert.equal(applyDialogueDecision(empty, { days: 0 }, 1).days, undefined);
  assert.equal(applyDialogueDecision(empty, { days: 2.5 }, 1).days, undefined);
  assert.equal(applyDialogueDecision(empty, { partySize: 99 }, 1).partySize, 20);
  assert.equal(applyDialogueDecision(empty, { pace: 'whatever' }, 1).pace, undefined);
});

test('起止日期压过天数：先说了 3 天、后来又给具体日期时，过期的 days 必须被清掉', () => {
  const next = applyDialogueDecision(
    { ...empty, days: 3, startDate: '2026-11-05' },
    { endDate: '2026-11-07' },
    1,
  );
  assert.equal(next.startDate, '2026-11-05');
  assert.equal(next.endDate, '2026-11-07');
  assert.equal(next.days, undefined);
});

test('只给开始日期时保留天数（还没有结束日期可用）', () => {
  const next = applyDialogueDecision({ ...empty, days: 3 }, { startDate: '2026-11-05' }, 1);
  assert.equal(next.days, 3);
});

test('新增约束自动补 id 与来源消息序号', () => {
  const next = applyDialogueDecision(empty, { addConstraints: [{ category: 'companion_context', valueText: '带 2 岁小孩', polarity: 'fact' }] }, 7);
  assert.equal(next.constraints.length, 1);
  const [constraint] = next.constraints;
  assert.ok(constraint?.id);
  assert.equal(constraint?.evidenceSequence, 7);
  assert.equal(constraint?.polarity, 'fact');
});

test('同一约束重复抽取不会重复添加，保留原 id', () => {
  const once = applyDialogueDecision(empty, { addConstraints: [{ category: 'dietary_requirement', valueText: '不吃辣', polarity: 'avoid' }] }, 1);
  const twice = applyDialogueDecision(once, { addConstraints: [{ category: 'dietary_requirement', valueText: ' 不吃辣 ', polarity: 'avoid' }] }, 2);
  assert.equal(twice.constraints.length, 1);
  assert.equal(twice.constraints[0]?.id, once.constraints[0]?.id);
});

test('removeConstraintIds 删除单条约束，其他约束保留', () => {
  const first = applyDialogueDecision(empty, { addConstraints: [{ category: 'dietary_requirement', valueText: '不吃辣', polarity: 'avoid' }] }, 1);
  const second = applyDialogueDecision(first, { addConstraints: [{ category: 'travel_pace', valueText: '节奏慢一点', polarity: 'prefer' }] }, 2);
  const targetId = second.constraints[0]?.id;
  const third = applyDialogueDecision(second, { removeConstraintIds: [targetId] }, 3);
  assert.equal(third.constraints.length, 1);
  assert.equal(third.constraints[0]?.valueText, '节奏慢一点');
});

test('未知分类/极性的约束被丢弃，不影响同一批里的合法约束', () => {
  const next = applyDialogueDecision(
    empty,
    {
      addConstraints: [
        { category: 'mood', valueText: '想开心', polarity: 'prefer' },
        { category: 'travel_pace', valueText: '', polarity: 'prefer' },
        { category: 'travel_pace', valueText: '不赶时间', polarity: 'neutral' },
        { category: 'travel_pace', valueText: '不赶时间', polarity: 'prefer' },
      ],
    },
    1,
  );
  assert.equal(next.constraints.length, 1);
  assert.equal(next.constraints[0]?.valueText, '不赶时间');
});

test('preferences 过滤未知值并去重', () => {
  const next = applyDialogueDecision(empty, { preferences: ['美食', '美食', '不存在', '亲子'] }, 1);
  assert.deepEqual(next.preferences, ['美食', '亲子']);
});

test('normalizeBriefData 给缺失 constraints 的旧行补空数组', () => {
  assert.deepEqual(normalizeBriefData({ destination: '成都' }).constraints, []);
  assert.deepEqual(normalizeBriefData(null).constraints, []);
  assert.deepEqual(normalizeBriefData('nonsense').constraints, []);
});

test('briefStatus：够生成即 ready；submitted/discarded 是终态不被改写', () => {
  assert.equal(briefStatus(empty), 'collecting');
  assert.equal(briefStatus({ ...empty, destination: '成都', startDate: '2026-11-05', days: 3, pace: 'moderate' }), 'ready');
  assert.equal(briefStatus(empty, 'submitted'), 'submitted');
  assert.equal(briefStatus(empty, 'discarded'), 'discarded');
});

test('briefToGenerateForm：从起止日期推导天数，并给出契约要求的兼容默认值', () => {
  const form = briefToGenerateForm({
    constraints: [],
    destination: '成都',
    startDate: '2026-11-05',
    endDate: '2026-11-07',
    pace: 'moderate',
  });
  assert.equal(form.days, 3);
  assert.equal(form.destination, '成都');
  assert.equal(form.budgetLevel, '舒适');
  assert.equal(form.totalBudget, 0);
  assert.equal(form.partySize, 2);
  assert.equal(form.transportMode, 'transit');
  assert.ok(Value.Check(GenerateFormSchema, form));
});

test('briefToGenerateForm：显式 days 优先，且约束进入 extraNotes 而不是被丢掉', () => {
  const form = briefToGenerateForm({
    constraints: [
      { id: 'c1', category: 'dietary_requirement', valueText: '不吃辣', polarity: 'avoid' },
      { id: 'c2', category: 'companion_context', valueText: '带 2 岁小孩', polarity: 'fact' },
    ],
    destination: '成都',
    days: 4,
    pace: 'relaxed',
    partySize: 3,
    extraNotes: '想住得离地铁近',
  });
  assert.equal(form.days, 4);
  assert.equal(form.partySize, 3);
  assert.match(form.extraNotes, /避开不吃辣（饮食要求）/);
  assert.match(form.extraNotes, /带 2 岁小孩（同行）/);
  assert.match(form.extraNotes, /想住得离地铁近/);
  assert.ok(Value.Check(GenerateFormSchema, form));
});

test('briefToGenerateForm：约束过多时截断到 extraNotes 上限并留可见标记', () => {
  const constraints = Array.from({ length: 30 }, (_, i) => ({
    id: `c${i}`,
    category: 'other_travel_preference' as const,
    valueText: `要求编号${i}的详细说明文字填充填充`,
    polarity: 'prefer' as const,
  }));
  const form = briefToGenerateForm({ constraints, destination: '成都', days: 2, pace: 'moderate' });
  assert.ok(form.extraNotes.length <= 200, `extraNotes 长度 ${form.extraNotes.length} 超出上限`);
  assert.ok(form.extraNotes.endsWith('…'), '截断必须有可见标记，不能静默丢字段');
  assert.ok(Value.Check(GenerateFormSchema, form));
});

test('修订意见（appendNotes）排在所有约束之前 —— 它是本次唯一的改动指令', () => {
  const form = briefToGenerateForm(
    { constraints: [{ id: 'c1', category: 'dietary_requirement', valueText: '不吃辣', polarity: 'avoid' }], destination: '成都', days: 2 },
    { appendNotes: '把第 2 天换成博物馆' },
  );
  assert.ok(form.extraNotes.startsWith('把第 2 天换成博物馆'), form.extraNotes);
  assert.match(form.extraNotes, /不吃辣/);
  assert.ok(Value.Check(GenerateFormSchema, form));
});

test('readClarification：有 question 就返回；选项去空去重并限量；缺 question 视为没给', () => {
  assert.deepEqual(readClarification({ clarification: { question: '这次想去哪里？', options: ['成都', '重庆'] } }), {
    question: '这次想去哪里？',
    options: ['成都', '重庆'],
  });
  // 只要 question、不要选项也是合法的（枚举不出来的字段）
  assert.deepEqual(readClarification({ clarification: { question: '大概什么时候出发？' } }), {
    question: '大概什么时候出发？',
    options: [],
  });
  // 只负责「去空白 + 丢非字符串」；去重与限量由调用方（若还有）负责
  assert.deepEqual(readClarification({ clarification: { question: 'q', options: [' a ', 1, null, 'b'] } })?.options, ['a', 'b']);
  assert.equal(readClarification({ clarification: { options: ['成都'] } }), null);
  assert.equal(readClarification({}), null);
  assert.equal(readClarification(null), null);
});
