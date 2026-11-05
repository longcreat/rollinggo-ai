import { create } from 'zustand';
import { LODGING_SENTINEL, uid, type Activity, type TransitLeg, type Trip, type TripDay } from '@tripweaver/shared';
import { routePairKey } from '../lib/routePair';

// 编辑器交互态：业务数据以服务端为唯一事实源，此处仅为编辑期副本
// revision 驱动防抖自动保存；结构化更新用 structuredClone（行程体量 <50KB，KISS）
export interface RouteReplan {
  id: string;
  key: string;
  dayId: string;
  fromId: string;
  status: 'pending' | 'error';
  error?: string;
  refresh?: boolean;
}

interface EditorState {
  readOnly: boolean;
  setReadOnly: (value: boolean) => void;
  acknowledgeSave: (tripId: string, saved: Trip) => void;
  routeReplans: Record<string, RouteReplan>;
  finishRouteReplan: (id: string, leg?: TransitLeg, error?: string) => void;
  retryRouteReplan: (key: string) => void;
  cancelRouteReplan: (key: string) => void;
  trip: Trip | null;
  revision: number;
  dayFilter: number | null;         // null = 全部天
  load: (trip: Trip) => void;
  clear: () => void;
  selectRoute: (dayId: string, key: string, leg: TransitLeg) => boolean;
  setDayFilter: (dayIndex: number | null) => void;
  updateMeta: (patch: Partial<Pick<Trip, 'title' | 'destination' | 'startDate' | 'partySize' | 'extraNotes'>>) => void;
  /** Trip 级住宿锚点：改名即清空坐标并丢弃使用该锚点各天的住宿 leg（无客户端重编码端点）；空串 = 移除 */
  updateLodging: (name: string) => void;
  /** day 级住宿覆盖：语义同上，仅影响该天；空串 = 清除覆盖（回落 Trip 级） */
  updateDayLodging: (dayId: string, name: string) => void;
  addDay: () => void;
  deleteDay: (dayId: string) => void;
  updateDayTitle: (dayId: string, title: string) => void;
  deleteActivity: (dayId: string, activityId: string) => void;
  moveActivity: (dayId: string, activityId: string, dir: 'up' | 'down') => void;
  moveActivityToDay: (fromDayId: string, activityId: string, toDayId: string) => void;
}

function renumber(days: TripDay[]): void {
  days.forEach((d, i) => {
    d.dayIndex = i + 1;
  });
}

/** 丢弃某天的住宿 leg（哨兵 id 'lodging'）：住宿锚点改名/清除后坐标失效，leg 不再可信 */
function dropLodgingLegs(day: TripDay): void {
  if (!day.legs) return;
  day.legs = day.legs.filter((l) => l.fromActivityId !== LODGING_SENTINEL && l.toActivityId !== LODGING_SENTINEL);
}

export const useEditorStore = create<EditorState>((set, get) => {
  const mutate = (fn: (draft: Trip) => void, replan = false) => {
    if (get().readOnly) return;
    const cur = get().trip;
    if (!cur) return;
    const draft = structuredClone(cur);
    fn(draft);
    const routeReplans = Object.fromEntries(Object.entries(get().routeReplans).filter(([key, job]) => routePairKey(draft, job.dayId, job.fromId) === key));
    if (replan) {
      for (const day of draft.days) {
        const previous = cur.days.find((item) => item.id === day.id);
        if (previous?.activities.map((a) => a.id).join(',') === day.activities.map((a) => a.id).join(',')) continue;
        if (day.legs) day.legs = day.legs.filter((leg) => leg.fromActivityId === LODGING_SENTINEL || leg.toActivityId === LODGING_SENTINEL || day.activities.some((a, i) => a.id === leg.fromActivityId && day.activities[i + 1]?.id === leg.toActivityId));
        for (const from of day.activities.slice(0, -1)) {
          const key = routePairKey(draft, day.id, from.id)!;
          if (key !== routePairKey(cur, day.id, from.id)) routeReplans[key] = { id: uid(), key, dayId: day.id, fromId: from.id, status: 'pending' };
        }
      }
    }
    set({ trip: draft, routeReplans, revision: get().revision + 1 });
  };

  const findDay = (draft: Trip, dayId: string) => draft.days.find((d) => d.id === dayId);

  return {
    readOnly: false,
    setReadOnly: (value) => set({ readOnly: value }),
    acknowledgeSave: (tripId, saved) => set((state) => {
      if (state.trip?.id !== tripId) return {};
      // 只接收版本身份，不用较早快照覆盖保存期间的新编辑和日期选择。
      const trip = { ...state.trip, id: saved.id, createdAt: saved.createdAt, updatedAt: saved.updatedAt };
      const routeReplans = Object.fromEntries(Object.values(state.routeReplans).flatMap((job) => {
        const key = routePairKey(trip, job.dayId, job.fromId);
        return key ? [[key, { ...job, key, id: saved.id === tripId ? job.id : uid() }]] : [];
      }));
      return { trip, routeReplans };
    }),
    trip: null,
    routeReplans: {},
    cancelRouteReplan: (key) => set((state) => {
      const routeReplans = { ...state.routeReplans };
      delete routeReplans[key];
      return { routeReplans };
    }),
    retryRouteReplan: (key) => set((state) => {
      const job = state.routeReplans[key];
      return job ? { routeReplans: { ...state.routeReplans, [key]: { ...job, id: uid(), status: 'pending', error: undefined, refresh: true } } } : {};
    }),
    finishRouteReplan: (id, leg, error) => {
      const job = Object.values(get().routeReplans).find((item) => item.id === id && item.status === 'pending');
      if (!job) return;
      if (leg && get().selectRoute(job.dayId, job.key, leg)) return;
      set((state) => ({ routeReplans: { ...state.routeReplans, [job.key]: { ...job, status: 'error', error: error ?? '暂无可用路线，请重试' } } }));
    },
    revision: 0,
    dayFilter: null,
    load: (trip) => set({ trip: structuredClone(trip), routeReplans: {}, revision: 0, dayFilter: null }),
    clear: () => set({ trip: null, routeReplans: {}, revision: 0, dayFilter: null }),
    selectRoute: (dayId, key, leg) => {
      if (get().readOnly) return false;
      const trip = get().trip;
      if (!trip || routePairKey(trip, dayId, leg.fromActivityId) !== key) return false;
      const day = trip.days.find((d) => d.id === dayId)!;
      const index = day.activities.findIndex((a) => a.id === leg.fromActivityId);
      if (day.activities[index + 1]?.id !== leg.toActivityId) return false;
      get().cancelRouteReplan(key);
      mutate((draft) => {
        const target = findDay(draft, dayId)!;
        target.legs = [...(target.legs ?? []).filter((l) => l.fromActivityId !== leg.fromActivityId || l.toActivityId !== leg.toActivityId), structuredClone(leg)];
      });
      return true;
    },
    setDayFilter: (dayIndex) => set({ dayFilter: dayIndex }),

    updateMeta: (patch) => mutate((draft) => Object.assign(draft, patch)),

    updateLodging: (name) =>
      mutate((draft) => {
        const trimmed = name.trim().slice(0, 60);
        if (trimmed === (draft.lodging?.name ?? '')) return;
        // 改名即坐标失效：清空坐标 + 丢弃使用 Trip 级锚点各天（无 day 级覆盖）的住宿 leg
        if (trimmed) draft.lodging = { name: trimmed };
        else delete draft.lodging;
        for (const day of draft.days) {
          if (!day.lodging) dropLodgingLegs(day);
        }
      }),

    updateDayLodging: (dayId, name) =>
      mutate((draft) => {
        const day = findDay(draft, dayId);
        if (!day) return;
        const trimmed = name.trim().slice(0, 60);
        if (trimmed === (day.lodging?.name ?? '')) return;
        if (trimmed) day.lodging = { name: trimmed };
        else delete day.lodging;
        dropLodgingLegs(day);
      }),

    addDay: () =>
      mutate((draft) => {
        draft.days.push({ id: uid(), dayIndex: draft.days.length + 1, title: '', activities: [] });
      }),

    deleteDay: (dayId) => {
      const selectedId = get().trip?.days.find((day) => day.dayIndex === get().dayFilter)?.id;
      mutate((draft) => {
        draft.days = draft.days.filter((d) => d.id !== dayId);
        renumber(draft.days);
      });
      const days = get().trip?.days ?? [];
      set({ dayFilter: get().dayFilter === null ? null : (days.find((day) => day.id === selectedId)?.dayIndex ?? days[0]?.dayIndex ?? null) });
    },

    updateDayTitle: (dayId, title) =>
      mutate((draft) => {
        const day = findDay(draft, dayId);
        if (day) day.title = title;
      }),

    deleteActivity: (dayId, activityId) =>
      mutate((draft) => {
        const day = findDay(draft, dayId);
        if (day) day.activities = day.activities.filter((a) => a.id !== activityId);
      }),

    moveActivity: (dayId, activityId, dir) =>
      mutate((draft) => {
        const list = findDay(draft, dayId)?.activities;
        if (!list) return;
        const i = list.findIndex((a) => a.id === activityId);
        const j = dir === 'up' ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= list.length) return;
        const a = list[i]!;
        list[i] = list[j]!;
        list[j] = a;
      }, true),

    moveActivityToDay: (fromDayId, activityId, toDayId) =>
      mutate((draft) => {
        const from = findDay(draft, fromDayId);
        const to = findDay(draft, toDayId);
        if (!from || !to || from === to) return;
        const i = from.activities.findIndex((a) => a.id === activityId);
        if (i < 0) return;
        const [moved] = from.activities.splice(i, 1);
        if (moved) to.activities.push(moved);
      }, true),
  };
});
