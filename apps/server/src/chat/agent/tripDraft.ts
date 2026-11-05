// 详情 Agent 的行程草稿：把「写操作」收敛到一层纯函数式的内存变更，不读库、不调模型、不发网络请求。
//
// 为什么需要草稿而不是每次直接落库：
//   - 一个回合里模型可能连续改 3–5 处（加餐厅、挪活动、改标题）。逐次落库会产生多个版本，
//     历史面板被一轮对话刷屏，而且中途失败会留下半成品版本。
//   - 读工具（get_trip/get_day）必须看到本回合刚做的修改，否则模型会重复修改或自我矛盾。
//   - 提交放在回合末尾一次性完成：一个新版本 + 一次 editResult，前端整体刷新到新版本。
//
// 与确定性编辑链（chat/editOps.ts）的分工：那边是「模型给 JSON → 服务端应用」的一次性批处理；
// 这里是「模型逐个工具调用 → 同一份草稿累积」，校验语义刻意保持一致（每天上限、地点去重、id 双锚）。
//
// 通勤段（legs）由调用方在提交时用 repairChangedRoutes 重算：本层在结构变化后直接清空受影响当天的 legs，
// 避免给模型看到指向已删除活动的过期路线。
import {
  ACTIVITY_CATEGORIES,
  BUDGET_LEVELS,
  MAX_EDIT_ACTIVITIES_PER_DAY,
  MAX_TRIP_DAYS,
  TRANSPORT_MODES,
  uid,
  type Activity,
  type EditOpOutcome,
  type Trip,
  type TripDay,
} from '@tripweaver/shared';

/** 工具返回值：给模型看的结论 + 该操作的 result 契约（提交时汇总进 editResult）。 */
export interface DraftResult {
  outcome: EditOpOutcome;
  /** 受影响当天的快照，模型据此确认结果，不必再调 get_day */
  day?: ReturnType<typeof dayView>;
}

const MAX_ACTIVITIES = MAX_EDIT_ACTIVITIES_PER_DAY;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function nameKey(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

function fail(kind: EditOpOutcome['kind'], summary: string): DraftResult {
  return { outcome: { kind, applied: false, summary: summary.slice(0, 200) } };
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function dayView(day: TripDay) {
  return {
    day: day.dayIndex,
    title: day.title,
    activities: day.activities.map((activity) => ({
      id: activity.id,
      name: activity.name,
      category: activity.category,
      startTime: activity.startTime,
      endTime: activity.endTime,
      cost: activity.cost,
      located: activity.coordSource !== 'estimated',
    })),
    legs: day.legs?.length ?? 0,
  };
}

export interface NewActivityInput {
  dayIndex: number;
  name: string;
  category?: string;
  description?: string;
  openTime?: string;
  cost?: number;
  position?: number;
  /** 已解析的坐标（GCJ-02）；缺省 = 未定位，提交后按 estimated 处理 */
  lat?: number;
  lng?: number;
  /** 明确要求重访同一地点时才允许重复加入 */
  allowRevisit?: boolean;
}

export interface UpdateActivityInput {
  dayIndex: number;
  activityId: string;
  name?: string;
  /** 改名后重新解析到的坐标；不给就视为「位置待核实」，绝不能沿用旧地点的坐标 */
  lat?: number;
  lng?: number;
  category?: string;
  description?: string;
  startTime?: string;
  endTime?: string;
  openTime?: string;
  cost?: number;
}

export interface UpdateTripInput {
  title?: string;
  startDate?: string;
  partySize?: number;
  budgetLevel?: string;
  totalBudget?: number;
  preferences?: string[];
  extraNotes?: string;
  transportMode?: string;
}

export function createTripDraft(initial: Trip) {
  let trip: Trip = structuredClone(initial);
  let dirty = false;
  const outcomes: EditOpOutcome[] = [];

  const findDay = (dayIndex: number) => trip.days.find((day) => day.dayIndex === dayIndex);
  /** id 双锚：dayIndex 与 activityId 必须同时命中，防模型张冠李戴 */
  const findActivity = (dayIndex: number, activityId: string) => {
    const day = findDay(dayIndex);
    const activity = day?.activities.find((item) => item.id === activityId);
    return day && activity ? { day, activity } : null;
  };
  const touch = (day: TripDay) => { day.legs = []; dirty = true; trip.updatedAt = Date.now(); };
  const record = (result: DraftResult) => {
    outcomes.push(result.outcome);
    return result;
  };

  function toActivity(input: NewActivityInput): Activity {
    const located = typeof input.lat === 'number' && typeof input.lng === 'number';
    return {
      id: uid(),
      name: text(input.name, 100),
      startTime: '',
      endTime: '',
      description: text(input.description, 500),
      lat: located ? input.lat! : 0,
      lng: located ? input.lng! : 0,
      // 未解析到坐标时按 estimated，与确定性编辑链 / 生成链路一致（前端会用「估算位置」提示）
      coordSource: located ? 'geocoded' : 'estimated',
      ...(located ? { coordSystem: 'gcj02' as const } : {}),
      category: (ACTIVITY_CATEGORIES as readonly string[]).includes(input.category ?? '')
        ? input.category as Activity['category']
        : '其他',
      ...(input.cost !== undefined && Number.isFinite(input.cost) && input.cost >= 0 ? { cost: Math.round(input.cost) } : {}),
      ...(input.openTime ? { openTime: text(input.openTime, 60) } : {}),
      sourceNotes: [],
    };
  }

  return {
    /** 读工具用：始终返回本回合最新草稿 */
    current: (): Trip => trip,
    changed: () => dirty,
    outcomes: (): EditOpOutcome[] => [...outcomes],

    addActivity(input: NewActivityInput): DraftResult {
      const kind: EditOpOutcome['kind'] = 'add_activity';
      const day = findDay(input.dayIndex);
      if (!day) return record(fail(kind, `第 ${input.dayIndex} 天不存在；当前共 ${trip.days.length} 天`));
      const name = text(input.name, 100);
      if (!name) return record(fail(kind, '缺少活动名称'));
      if (day.activities.length >= MAX_ACTIVITIES) {
        return record(fail(kind, `第 ${input.dayIndex} 天已有 ${MAX_ACTIVITIES} 个活动（上限），先删再加`));
      }
      if (!input.allowRevisit) {
        const duplicate = trip.days.flatMap((item) => item.activities).find((item) => nameKey(item.name) === nameKey(name));
        if (duplicate) {
          return record(fail(kind, `「${duplicate.name}」已在行程中；确实要再去一次请说明，我会按重复游览添加`));
        }
      }
      const activity = toActivity(input);
      const position = input.position !== undefined ? Math.min(Math.max(0, Math.round(input.position)), day.activities.length) : day.activities.length;
      day.activities.splice(position, 0, activity);
      touch(day);
      return record({
        outcome: { kind, applied: true, summary: `第 ${day.dayIndex} 天：新增「${name}」` },
        day: dayView(day),
      });
    },

    updateActivity(input: UpdateActivityInput): DraftResult {
      const kind: EditOpOutcome['kind'] = 'update_activity';
      const target = findActivity(input.dayIndex, input.activityId);
      if (!target) return record(fail(kind, `第 ${input.dayIndex} 天没找到该活动（activityId 可能已变，先调 get_day 确认）`));
      const { activity } = target;
      const changes: string[] = [];
      let renamed = false;
      const nextName = input.name === undefined ? undefined : text(input.name, 100);
      if (nextName !== undefined) {
        if (!nextName) return record(fail(kind, '活动名称不能为空'));
        const duplicate = trip.days.flatMap((item) => item.activities)
          .find((item) => item.id !== activity.id && nameKey(item.name) === nameKey(nextName));
        if (duplicate) return record(fail(kind, `行程里已有「${duplicate.name}」，不能改成同名`));
        if (nextName !== activity.name) { activity.name = nextName; renamed = true; changes.push(`名称→${nextName}`); }
      }
      if (input.category !== undefined && (ACTIVITY_CATEGORIES as readonly string[]).includes(input.category)) {
        if (activity.category !== input.category) { activity.category = input.category as Activity['category']; changes.push(`类目→${input.category}`); }
      }
      if (input.description !== undefined) {
        const description = text(input.description, 500);
        if (description !== activity.description) { activity.description = description; changes.push('简介已更新'); }
      }
      for (const field of ['startTime', 'endTime'] as const) {
        const value = input[field];
        if (value === undefined) continue;
        const time = /^\d{2}:\d{2}$/.test(value.trim()) ? value.trim() : '';
        if (time !== activity[field]) { activity[field] = time; changes.push(`${field === 'startTime' ? '开始' : '结束'}时间→${time || '未定'}`); }
      }
      if (input.openTime !== undefined) {
        const openTime = text(input.openTime, 60);
        if (openTime !== (activity.openTime ?? '')) {
          if (openTime) activity.openTime = openTime; else delete activity.openTime;
          changes.push('开放时间已更新');
        }
      }
      if (input.cost !== undefined && Number.isFinite(input.cost) && input.cost >= 0) {
        const cost = Math.round(input.cost);
        if (cost !== activity.cost) { activity.cost = cost; changes.push(`人均→${cost}`); }
      }
      if (!changes.length) return record(fail(kind, `「${activity.name}」没有可应用的变化（请给出要改的字段）`));
      // 改名到这个地步，这就是另一个地点了：旧坐标必须失效，否则地图会指向原地点。
      if (renamed) {
        const located = typeof input.lat === 'number' && typeof input.lng === 'number';
        if (located) {
          activity.lat = input.lat!;
          activity.lng = input.lng!;
          activity.coordSource = 'geocoded';
          activity.coordSystem = 'gcj02';
        } else {
          activity.lat = 0;
          activity.lng = 0;
          activity.coordSource = 'estimated';
          delete activity.coordSystem;
        }
        target.day.legs = [];
      }
      dirty = true;
      trip.updatedAt = Date.now();
      return record({
        outcome: { kind, applied: true, summary: `第 ${target.day.dayIndex} 天：「${activity.name}」${changes.join('、')}` },
        day: dayView(target.day),
      });
    },

    deleteActivity(dayIndex: number, activityId: string): DraftResult {
      const kind: EditOpOutcome['kind'] = 'delete_activity';
      const target = findActivity(dayIndex, activityId);
      if (!target) return record(fail(kind, `第 ${dayIndex} 天没找到要删的活动（先调 get_day 确认 id）`));
      target.day.activities = target.day.activities.filter((item) => item.id !== activityId);
      touch(target.day);
      return record({
        outcome: { kind, applied: true, summary: `第 ${target.day.dayIndex} 天：删除「${target.activity.name}」` },
        day: dayView(target.day),
      });
    },

    moveActivity(fromDayIndex: number, activityId: string, toDayIndex: number, position?: number): DraftResult {
      const kind: EditOpOutcome['kind'] = 'move_activity';
      const target = findActivity(fromDayIndex, activityId);
      if (!target) return record(fail(kind, `第 ${fromDayIndex} 天没找到要移动的活动`));
      const toDay = findDay(toDayIndex);
      if (!toDay) return record(fail(kind, `第 ${toDayIndex} 天不存在`));
      if (toDay.dayIndex === target.day.dayIndex) {
        return record(fail(kind, '同一天内调整顺序请用 reorder_day，跨天才用 move_activity'));
      }
      if (toDay.activities.length >= MAX_ACTIVITIES) {
        return record(fail(kind, `第 ${toDayIndex} 天已有 ${MAX_ACTIVITIES} 个活动（上限），先删再加`));
      }
      const [activity] = target.day.activities.filter((item) => item.id === activityId);
      target.day.activities = target.day.activities.filter((item) => item.id !== activityId);
      const index = position !== undefined ? Math.min(Math.max(0, Math.round(position)), toDay.activities.length) : toDay.activities.length;
      toDay.activities.splice(index, 0, activity!);
      touch(target.day);
      touch(toDay);
      return record({
        outcome: { kind, applied: true, summary: `「${activity!.name}」从第 ${target.day.dayIndex} 天移到第 ${toDay.dayIndex} 天` },
        day: dayView(toDay),
      });
    },

    reorderDay(dayIndex: number, activityIds: readonly string[]): DraftResult {
      const kind: EditOpOutcome['kind'] = 'reorder_day';
      const day = findDay(dayIndex);
      if (!day) return record(fail(kind, `第 ${dayIndex} 天不存在`));
      const wanted = activityIds.map((id) => id.trim()).filter(Boolean);
      const current = day.activities.map((item) => item.id);
      if (wanted.length !== current.length || new Set(wanted).size !== wanted.length
        || !current.every((id) => wanted.includes(id))) {
        return record(fail(kind, `顺序必须是当天全部 ${current.length} 个活动 id 的一个排列，不要漏项或加新项`));
      }
      if (wanted.every((id, index) => id === current[index])) {
        return record(fail(kind, '顺序没有变化'));
      }
      const byId = new Map(day.activities.map((item) => [item.id, item]));
      day.activities = wanted.map((id) => byId.get(id)!);
      touch(day);
      return record({
        outcome: { kind, applied: true, summary: `第 ${day.dayIndex} 天：已按新顺序重排 ${wanted.length} 个活动` },
        day: dayView(day),
      });
    },

    addDay(title?: string): DraftResult {
      const kind: EditOpOutcome['kind'] = 'add_day';
      if (trip.days.length >= MAX_TRIP_DAYS) return record(fail(kind, `行程最多 ${MAX_TRIP_DAYS} 天，已到上限`));
      const dayIndex = Math.max(0, ...trip.days.map((item) => item.dayIndex)) + 1;
      const day: TripDay = {
        id: uid(), dayIndex, title: text(title, 30) || `第${dayIndex}天`, activities: [], legs: [],
      };
      trip.days.push(day);
      dirty = true;
      trip.updatedAt = Date.now();
      return record({
        outcome: { kind, applied: true, summary: `新增第 ${dayIndex} 天（当前共 ${trip.days.length} 天）` },
        day: dayView(day),
      });
    },

    updateDay(dayIndex: number, title: string): DraftResult {
      const kind: EditOpOutcome['kind'] = 'update_day';
      const day = findDay(dayIndex);
      if (!day) return record(fail(kind, `第 ${dayIndex} 天不存在`));
      const next = text(title, 30);
      if (!next) return record(fail(kind, '当天主题不能为空'));
      if (next === day.title) return record(fail(kind, '主题没有变化'));
      const previous = day.title;
      day.title = next;
      dirty = true;
      trip.updatedAt = Date.now();
      return record({
        outcome: { kind, applied: true, summary: `第 ${dayIndex} 天主题：「${previous}」→「${next}」` },
        day: dayView(day),
      });
    },

    deleteDay(dayIndex: number): DraftResult {
      const kind: EditOpOutcome['kind'] = 'delete_day';
      const day = findDay(dayIndex);
      if (!day) return record(fail(kind, `第 ${dayIndex} 天不存在`));
      if (trip.days.length <= 1) return record(fail(kind, '行程至少保留一天，不能删掉唯一的一天'));
      trip.days = trip.days.filter((item) => item.dayIndex !== dayIndex);
      // 后续天数前移，保持 dayIndex 连续（地图配色与「第 N 天」文案都依赖连续编号）
      trip.days.forEach((item, index) => { item.dayIndex = index + 1; });
      dirty = true;
      trip.updatedAt = Date.now();
      return record({
        outcome: { kind, applied: true, summary: `删除第 ${dayIndex} 天（「${day.title}」，含 ${day.activities.length} 个活动），当前共 ${trip.days.length} 天` },
      });
    },

    updateTrip(input: UpdateTripInput): DraftResult {
      const kind: EditOpOutcome['kind'] = 'update_trip';
      const changes: string[] = [];
      if (input.title !== undefined) {
        const title = text(input.title, 60);
        if (!title) return record(fail(kind, '行程标题不能为空'));
        if (title !== trip.title) { trip.title = title; changes.push(`标题→「${title}」`); }
      }
      if (input.startDate !== undefined) {
        const startDate = input.startDate.trim();
        if (startDate && !DATE_RE.test(startDate)) return record(fail(kind, '出发日期格式需为 YYYY-MM-DD'));
        if (startDate !== trip.startDate) { trip.startDate = startDate; changes.push(startDate ? `出发日期→${startDate}` : '出发日期已清空'); }
      }
      if (input.partySize !== undefined) {
        const size = Math.round(input.partySize);
        if (!Number.isFinite(size) || size < 1 || size > 50) return record(fail(kind, '人数需在 1–50 之间'));
        if (size !== trip.partySize) { trip.partySize = size; changes.push(`人数→${size}`); }
      }
      if (input.budgetLevel !== undefined) {
        if (!(BUDGET_LEVELS as readonly string[]).includes(input.budgetLevel)) {
          return record(fail(kind, `预算档位只能是 ${BUDGET_LEVELS.join(' / ')}`));
        }
        if (input.budgetLevel !== trip.budgetLevel) { trip.budgetLevel = input.budgetLevel as Trip['budgetLevel']; changes.push(`预算档位→${input.budgetLevel}`); }
      }
      if (input.totalBudget !== undefined) {
        if (!Number.isFinite(input.totalBudget) || input.totalBudget < 0) return record(fail(kind, '总预算不能为负数'));
        const budget = Math.round(input.totalBudget);
        if (budget !== trip.totalBudget) { trip.totalBudget = budget; changes.push(`总预算→${budget}`); }
      }
      if (input.preferences !== undefined) {
        const preferences = [...new Set(input.preferences.map((item) => text(item, 10)).filter(Boolean))].slice(0, 10);
        if (preferences.join('|') !== trip.preferences.join('|')) {
          trip.preferences = preferences;
          changes.push(`偏好→${preferences.length ? preferences.join('、') : '无'}`);
        }
      }
      if (input.extraNotes !== undefined) {
        const notes = text(input.extraNotes, 200);
        if (notes !== trip.extraNotes) { trip.extraNotes = notes; changes.push('备注已更新'); }
      }
      if (input.transportMode !== undefined) {
        if (!(TRANSPORT_MODES as readonly string[]).includes(input.transportMode)) {
          return record(fail(kind, `出行方式只能是 ${TRANSPORT_MODES.join(' / ')}`));
        }
        if (input.transportMode !== (trip.transportMode ?? 'transit')) {
          trip.transportMode = input.transportMode as Trip['transportMode'];
          changes.push(`出行方式→${input.transportMode}`);
          // 出行方式变了，全行程通勤段都要按新方式重算
          for (const day of trip.days) day.legs = [];
        }
      }
      if (!changes.length) return record(fail(kind, '没有可应用的行程信息变化'));
      dirty = true;
      trip.updatedAt = Date.now();
      return record({ outcome: { kind, applied: true, summary: changes.join('；') } });
    },

    /** 提交用：结构化克隆，避免调用方后续改动污染草稿 */
    snapshot: (): Trip => structuredClone(trip),
  };
}

export type TripDraft = ReturnType<typeof createTripDraft>;
