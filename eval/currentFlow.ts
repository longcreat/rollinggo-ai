import { LODGING_SENTINEL, type GenerateForm, type Trip } from '@tripweaver/shared';
import { isFoodFocused, missingMeals } from '../apps/server/src/generation/mealPlanning';
import type { Execution, FlowCheck } from './contracts';

/** 对齐当前编排器；增强阶段允许降级，但必须明确报告，不将尝试冒充成功。 */
export function checkCurrentFlow(trip: Trip, form: GenerateForm, execution?: Execution): FlowCheck[] {
  if (!execution) return [{ id: 'execution', label: '当前生成流程', status: 'UNAVAILABLE',
    detail: '此快照没有流程观测；只验证已保存行程，不能证明当前生成步骤、事务或界面流程已执行。' }];
  const rows: FlowCheck[] = [];
  const check = (id: string, label: string, pass: boolean, detail: string) =>
    rows.push({ id, label, status: pass ? 'PASS' : 'FAIL', detail });
  const task = (id: string, label: string, names: string[], optional = false) => {
    const absent = names.filter((name) => !execution.tasks[name]);
    const failed = names.filter((name) => !execution.tasks[name]?.ok);
    const retries = names.reduce((n, name) => n + (execution.tasks[name]?.errors ?? 0), 0);
    rows.push({ id, label, status: absent.length || failed.length ? optional ? 'DEGRADED' : 'FAIL' : 'PASS',
      detail: absent.length || failed.length ? `缺少成功执行或出现降级：${[...new Set([...absent, ...failed])].join('、')}` : `${names.join(' → ')}${retries ? `（失败尝试 ${retries} 次后完成）` : ''}` });
  };
  const preserved = trip.destination === form.destination && trip.partySize === form.partySize
    && (trip.startDate ?? '') === form.startDate && (trip.extraNotes ?? '') === form.extraNotes
    && (trip.transportMode ?? 'transit') === (form.transportMode ?? 'transit')
    && JSON.stringify([...trip.preferences].sort()) === JSON.stringify([...form.preferences].sort());
  check('input', '生成输入保留', preserved, '核对目的地、日期、人数、偏好、备注和出行方式；节奏的排程效果由流程回归验证。');
  task('research', '知识检索与调研提交', ['prefetch_verified_places', 'submit_research']);
  task('schedule', '确定性排程', ['schedule_itinerary']);
  check('plan-model', '排程不调用模型', execution.planLlmCalls === 0, `plan 阶段模型响应数 ${execution.planLlmCalls}`);
  task('writer', '标题文案', ['update_titles'], true);
  task('geo', '坐标与首次路线', ['geo_geocode_all', 'optimize_day_routes', 'geo_compute_legs', 'simulate_feasibility'], true);
  task('repair', '远郊与跨天处理', ['repair_long_haul', 'optimize_cross_day_grouping'], true);
  task('final-geo', '最终路线复核', ['geo_geocode_review_changes', 'geo_recompute_final_legs'], true);
  const activities = trip.days.flatMap((d) => d.activities);
  const ids = [...trip.days.map((d) => d.id), ...activities.map((a) => a.id)];
  check('identity', '天序与活动标识', trip.days.every((d, i) => d.dayIndex === i + 1) && new Set(ids).size === ids.length,
    '天序连续，天与活动 ID 无重复。');
  if (isFoodFocused(form.preferences)) {
    const missing = missingMeals(trip.days);
    check('meals', '美食偏好餐次', missing.length === 0, missing.length ? missing.map((m) => `D${m.dayIndex} 缺${m.kind === 'lunch' ? '午餐' : '晚餐'}`).join('；') : '每天有午餐与晚餐；区域餐次符合当前约定。');
  } else rows.push({ id: 'meals', label: '美食偏好餐次', status: 'NOT_APPLICABLE', detail: '未选择美食偏好，不要求新增餐次。' });
  check('lodging-input', '住宿可选约定', form.lodging?.trim() ? trip.lodging?.name === form.lodging.trim()
    : !trip.lodging && trip.days.every((d) => !d.lodging), '仅保留用户指定住宿，未指定时不自行生成住宿。');
  let expected = 0, present = 0, invalid = 0;
  for (const day of trip.days) {
    const allowed = new Set<string>();
    for (let i = 1; i < day.activities.length; i++) allowed.add(`${day.activities[i - 1]!.id}\0${day.activities[i]!.id}`);
    const a = day.activities[0], b = day.activities.at(-1);
    if ((day.lodging ?? trip.lodging) && a && b) {
      allowed.add(`${LODGING_SENTINEL}\0${a.id}`); allowed.add(`${b.id}\0${LODGING_SENTINEL}`);
    }
    const seen = new Set<string>();
    for (const leg of day.legs ?? []) {
      const key = `${leg.fromActivityId}\0${leg.toActivityId}`;
      if (!allowed.has(key) || seen.has(key)) invalid++;
      seen.add(key);
    }
    expected += allowed.size;
    present += [...allowed].filter((key) => seen.has(key)).length;
  }
  check('route-integrity', '最终路段引用', invalid === 0, `非当前相邻关系、悬空或重复路段 ${invalid} 条。`);
  rows.push({ id: 'route-coverage', label: '路段产出', status: !expected ? 'NOT_APPLICABLE' : present === expected ? 'PASS' : 'DEGRADED',
    detail: `${present}/${expected} 条当前相邻路线（含已指定住宿）；缺路线按现有增强降级处理，不虚构时长。` });
  check('persistence', '终态、行程与审计落库', execution.terminal === 'done' && execution.tripReadBack && execution.auditCommitted && execution.overviewMatches,
    `终态 ${execution.terminal}；行程读回 ${execution.tripReadBack}；成功审计 ${execution.auditCommitted}；概览候选一致 ${execution.overviewMatches}`);
  return rows;
}
