// 行程按需编辑：纯函数，不读库、不调 LLM、不做网络解析 —— 与 brief.ts 同一设计。
//
// 设计约束（09-24 PRD R1）：
//   - 操作集支持活动修改与追加日期；坐标解析（异步）由调用方先做，这里只接收已解析结果。
//   - 防御性归一：dayIndex 越界、activityId 不存在、操作重复命中同一活动等一律按「该条拒绝」处理，
//     不丢整批。模型给的输入是 unknown，逐字段校验后才进入行程。
//   - 时刻轴恒为空（D5）：编辑只动活动列表，不推算时刻；通勤段 leg 凡触及变动活动的一律丢弃，
//     由后续 computeLegs 或消费方缺失处理兜底。
import {
  ACTIVITY_CATEGORIES,
  MAX_EDIT_OPS_PER_TURN,
  MAX_EDIT_ACTIVITIES_PER_DAY,
  MAX_TRIP_DAYS,
  uid,
  samePlaceReference,
  type Activity,
  type EditOpOutcome,
  type ItineraryEditOp,
  type NewActivityDraft,
  type Trip,
} from '@tripweaver/shared';
import { asRecord, readString } from './models';

/** 路由层解析后的新活动：在模型草稿基础上补上坐标（可能解析失败 → 无坐标，走 estimated 兜底） */
export interface ResolvedNewActivity extends NewActivityDraft {
  /** 服务端解析身份；不读取模型传入的 canonicalPlaceId。 */
  canonicalPlaceId?: string;
  /** 只有用户明确表达重访时，由服务端允许重复地点。 */
  allowRevisit?: boolean;
  lat?: number;
  lng?: number;
  openTime?: string;
  /** 仅服务端调研写入；normalizeEditOps 不读取模型给出的来源。 */
  sourceNotes?: Activity['sourceNotes'];
  placeName?: string;
  skipGeocode?: boolean;
}

export interface ResolvedEditOp {
  kind: ItineraryEditOp['kind'];
  dayIndex: number;
  activityId?: string;          // replace / delete 必填
  position?: number;            // add 可选
  activity?: ResolvedNewActivity; // replace / add 必填
  days?: { title: string; activities: ResolvedNewActivity[] }[]; // add_days 必填
}

export interface EditApplyResult {
  /** 应用后的新行程（未落库；调用方负责 createTrip 进版本链） */
  trip: Trip;
  outcomes: EditOpOutcome[];
  /** 是否有任何一条真正改动行程；全拒绝时调用方不应产生新版本 */
  changed: boolean;
}

const MAX_OPS = MAX_EDIT_OPS_PER_TURN;
const MAX_ACTIVITIES_PER_DAY = MAX_EDIT_ACTIVITIES_PER_DAY;

function readDayIndex(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : null;
}

function readActivityId(raw: unknown): string | null {
  const value = readString(raw, 'activityId')?.trim();
  return value ? value : null;
}

function readDraft(raw: unknown): ResolvedNewActivity | null {
  const node = asRecord(raw);
  const name = typeof node.name === 'string' ? node.name.trim() : '';
  if (!name) return null;
  const category = typeof node.category === 'string' && (ACTIVITY_CATEGORIES as readonly string[]).includes(node.category)
    ? (node.category as Activity['category'])
    : undefined;
  const description = typeof node.description === 'string' ? node.description.trim().slice(0, 500) : '';
  const draft: ResolvedNewActivity = { name: name.slice(0, 100), ...(category ? { category } : {}), ...(description ? { description } : {}) };
  if (typeof node.lat === 'number' && typeof node.lng === 'number') {
    draft.lat = node.lat;
    draft.lng = node.lng;
  }
  if (typeof node.openTime === 'string' && node.openTime.trim()) draft.openTime = node.openTime.trim().slice(0, 60);
  return draft;
}

/** 模型原始输出 → 已校验操作列表；非法条目直接丢弃（不调 LLM 重试，模型下轮自行修正） */
export function normalizeEditOps(raw: unknown): ResolvedEditOp[] {
  const list = Array.isArray(raw) ? raw.slice(0, MAX_OPS) : [];
  const ops: ResolvedEditOp[] = [];
  for (const item of list) {
    const node = asRecord(item);
    const kind = readString(node, 'kind');
    const dayIndex = readDayIndex(node.dayIndex);
    if (!dayIndex) continue;
    if (kind === 'add_days') {
      if (!Array.isArray(node.days) || !node.days.length || node.days.length > MAX_TRIP_DAYS) continue;
      const days: NonNullable<ResolvedEditOp['days']> = [];
      for (const rawDay of node.days) {
        const day = asRecord(rawDay);
        const title = readString(day, 'title')?.trim();
        if (!title || !Array.isArray(day.activities) || day.activities.length > MAX_ACTIVITIES_PER_DAY) break;
        const activities = day.activities.map(readDraft);
        if (activities.some((activity) => !activity)) break;
        days.push({ title: title.slice(0, 30), activities: activities.filter((activity): activity is ResolvedNewActivity => activity !== null) });
      }
      // 不截断新增日期组，避免「延长两天」只保存了一天。
      if (days.length === node.days.length) ops.push({ kind, dayIndex, days });
      continue;
    }
    if (kind === 'delete_activity') {
      const activityId = readActivityId(node);
      if (activityId) ops.push({ kind, dayIndex, activityId });
      continue;
    }
    if (kind === 'replace_activity') {
      const activityId = readActivityId(node);
      const activity = readDraft(node.activity);
      if (activityId && activity) ops.push({ kind, dayIndex, activityId, activity });
      continue;
    }
    if (kind === 'add_activity') {
      const activity = readDraft(node.activity);
      const position = typeof node.position === 'number' && Number.isInteger(node.position) && node.position >= 0 ? node.position : undefined;
      if (activity) ops.push({ kind, dayIndex, ...(position !== undefined ? { position } : {}), activity });
    }
  }
  return ops;
}

/** 调用方在解析地点时同时覆盖单个活动和新增日期内的所有活动。 */
export function editActivityDrafts(ops: ResolvedEditOp[]): ResolvedNewActivity[] {
  return ops.flatMap((op) => op.kind === 'add_days' ? op.days?.flatMap((day) => day.activities) ?? [] : op.activity ? [op.activity] : []);
}

function toActivity(draft: ResolvedNewActivity): Activity {
  const geocoded = draft.lat !== undefined && draft.lng !== undefined;
  return {
    id: uid(),
    name: draft.name,
    ...(draft.canonicalPlaceId ? { canonicalPlaceId: draft.canonicalPlaceId } : {}),
    startTime: '',
    endTime: '',
    description: draft.description ?? '',
    lat: draft.lat ?? 0,
    lng: draft.lng ?? 0,
    coordSource: geocoded ? 'geocoded' : 'estimated',
    ...(geocoded ? { coordSystem: 'gcj02' as const } : {}),
    category: draft.category ?? '其他',
    ...(draft.openTime ? { openTime: draft.openTime } : {}),
    sourceNotes: draft.sourceNotes ?? [],
  };
}

/** 定位目标活动：dayIndex 与 activityId 双锚都必须命中，防模型张冠李戴 */
function findTarget(trip: Trip, dayIndex: number, activityId: string) {
  const day = trip.days.find((d) => d.dayIndex === dayIndex);
  const activity = day?.activities.find((a) => a.id === activityId);
  return day && activity ? { day, activity } : null;
}

/** 丢弃触及指定活动 id 的通勤段（失配 leg 的确定性清理，不靠消费方过滤兜底） */
function pruneLegs(trip: Trip, removedIds: ReadonlySet<string>): void {
  if (removedIds.size === 0) return;
  for (const day of trip.days) {
    if (!day.legs) continue;
    day.legs = day.legs.filter((leg) => !removedIds.has(leg.fromActivityId) && !removedIds.has(leg.toActivityId));
  }
}

/**
 * 应用编辑操作。同一条操作失败不影响其他条；全部失败时 changed=false，调用方不落新版本。
 * 同一活动被多条操作命中时只执行第一条（模型的重复输出视为噪声）。
 */
export function applyItineraryEdits(current: Trip, ops: ResolvedEditOp[]): EditApplyResult {
  const trip: Trip = structuredClone(current);
  const outcomes: EditOpOutcome[] = [];
  const touchedActivityIds = new Set<string>();
  const removedIds = new Set<string>();
  let changed = false;
  let daysAdded = false;

  for (const op of ops) {
    if (op.kind !== 'delete_activity') {
      const drafts = editActivityDrafts([op]);
      const scheduled = trip.days.flatMap(day => day.activities).filter(a => a.id !== op.activityId);
      const batch: ResolvedNewActivity[] = [];
      const duplicate = drafts.find(draft => {
        const repeated = !draft.allowRevisit && draft.canonicalPlaceId
          && [...scheduled, ...batch].some(other => other.canonicalPlaceId && samePlaceReference(draft, other));
        batch.push(draft); return repeated;
      });
      if (duplicate) {
        outcomes.push({ kind: op.kind, applied: false, summary: `「${duplicate.name}」已在行程中；如需再次游览，请明确说明` });
        continue;
      }
    }
    if (op.kind === 'add_days') {
      const nextIndex = Math.max(0, ...trip.days.map((day) => day.dayIndex)) + 1;
      const days = op.days;
      const invalid = !days?.length || days.some((day) => !day.title.trim() || day.activities.length > MAX_ACTIVITIES_PER_DAY);
      if (invalid || !days || daysAdded || op.dayIndex !== nextIndex) {
        outcomes.push({ kind: op.kind, applied: false, summary: `新增日期须从第 ${nextIndex} 天开始，且每轮只追加一组日期` });
        continue;
      }
      if (trip.days.length + days.length > MAX_TRIP_DAYS || nextIndex + days.length - 1 > MAX_TRIP_DAYS) {
        outcomes.push({ kind: op.kind, applied: false, summary: `行程最多支持 ${MAX_TRIP_DAYS} 天，本次未新增日期` });
        continue;
      }
      trip.days.push(...days.map((day, index) => ({ id: uid(), dayIndex: nextIndex + index, title: day.title, activities: day.activities.map(toActivity), legs: [] })));
      daysAdded = true;
      changed = true;
      outcomes.push({ kind: op.kind, applied: true, summary: `新增 ${days.length} 天行程（第 ${nextIndex}${days.length > 1 ? `～${nextIndex + days.length - 1}` : ''} 天），共 ${trip.days.length} 天` });
      continue;
    }
    if (op.kind === 'delete_activity') {
      const target = op.activityId && !touchedActivityIds.has(op.activityId) ? findTarget(trip, op.dayIndex, op.activityId) : null;
      if (!target || !op.activityId) {
        outcomes.push({ kind: op.kind, applied: false, summary: `第 ${op.dayIndex} 天没找到要删除的活动` });
        continue;
      }
      target.day.activities = target.day.activities.filter((a) => a.id !== op.activityId);
      touchedActivityIds.add(op.activityId);
      removedIds.add(op.activityId);
      changed = true;
      outcomes.push({ kind: op.kind, applied: true, summary: `第 ${op.dayIndex} 天：删除「${target.activity.name}」` });
      continue;
    }

    if (op.kind === 'replace_activity') {
      const target = op.activityId && !touchedActivityIds.has(op.activityId) ? findTarget(trip, op.dayIndex, op.activityId) : null;
      if (!target || !op.activityId || !op.activity) {
        outcomes.push({ kind: op.kind, applied: false, summary: `第 ${op.dayIndex} 天没找到要替换的活动` });
        continue;
      }
      const next = toActivity(op.activity);
      const index = target.day.activities.findIndex((a) => a.id === op.activityId);
      target.day.activities[index] = next;   // 原位替换，顺序不变
      touchedActivityIds.add(op.activityId);
      removedIds.add(op.activityId);         // 旧 id 的 leg 全部失效
      changed = true;
      outcomes.push({ kind: op.kind, applied: true, summary: `第 ${op.dayIndex} 天：「${target.activity.name}」换成「${next.name}」` });
      continue;
    }

    // add_activity
    const day = trip.days.find((d) => d.dayIndex === op.dayIndex);
    if (!day || !op.activity) {
      outcomes.push({ kind: op.kind, applied: false, summary: `第 ${op.dayIndex} 天不存在，无法新增活动` });
      continue;
    }
    if (day.activities.length >= MAX_ACTIVITIES_PER_DAY) {
      outcomes.push({ kind: op.kind, applied: false, summary: `第 ${op.dayIndex} 天活动已满（${MAX_ACTIVITIES_PER_DAY} 个），先删再加` });
      continue;
    }
    const next = toActivity(op.activity);
    const position = op.position !== undefined ? Math.min(op.position, day.activities.length) : day.activities.length;
    day.activities.splice(position, 0, next);
    changed = true;
    outcomes.push({ kind: op.kind, applied: true, summary: `第 ${op.dayIndex} 天：新增「${next.name}」` });
  }

  pruneLegs(trip, removedIds);
  trip.updatedAt = Date.now();
  return { trip, outcomes, changed };
}
