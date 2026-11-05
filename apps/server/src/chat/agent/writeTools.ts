// 详情 Agent 的写工具：对行程单做增删改查，改动落在回合内存草稿上，回合结束统一落一个新版本。
//
// 设计取向（参考出发鸭的 slot 级工具 + 我们的确定性编辑链）：
//   - 一个动作一个工具，参数扁平，模型好填；拒绝原因直接是中文可复述的一句话。
//   - 工具只报告「改了什么」，不负责保存：保存由 turn.ts 在回答生成后一次性提交，
//     一轮对话只产生一个版本，历史面板不会被中途状态刷屏。
//   - 每次成功都回传受影响当天的快照，模型不必再调 get_day 确认，省一轮往返。
//   - 地图不是独立资源：活动坐标与通勤段就是地图数据，新增地点会先解析坐标，
//     提交时由 repairChangedRoutes 重算动线，前端刷新到新版本即看到新标记与新折线。
import { arr, int, num, obj, opt, str } from '@earendil-works/pi-schema';
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable';
import type { TripDraft, DraftResult } from './tripDraft';

export interface TripWriteToolDeps {
  draft: TripDraft;
  signal: AbortSignal;
  /** 新地点定位（高德）。未注入时按无坐标处理，前端会标「位置待核实」。 */
  resolvePlace?: (name: string) => Promise<{ lat: number; lng: number } | null>;
}

const text = (value: string) => [{ type: 'text' as const, text: value }];

function reply(result: DraftResult) {
  return { output: text(JSON.stringify({ ok: result.outcome.applied, summary: result.outcome.summary, ...(result.day ? { day: result.day } : {}) })) };
}

export function createTripWriteTools(deps: TripWriteToolDeps): ToolRegistration[] {
  const { draft, signal } = deps;
  const dayIndex = (value: number) => Math.round(value);

  const addActivity = defineTool({
    name: 'add_activity',
    description: '在某一天新增一个活动（景点/餐厅/住宿等）。地点名称必须具体到真实地名，服务端会解析坐标并重算当天动线。',
    parameters: obj({
      dayIndex: int({ description: '第几天，从 1 开始' }),
      name: str({ description: '真实地点名称，如「人民公园」「马旺子川小馆」' }),
      category: opt(str({ description: '类目：美食 / 文化 / 自然 / 购物 / 住宿 / 交通 / 娱乐 / 其他' })),
      description: opt(str({ description: '一句话说明为什么安排这里，30–80 字' })),
      position: opt(int({ description: '插入到当天的第几个位置（0 起）；缺省追加到末尾' })),
      openTime: opt(str({ description: '开放/营业时间原文，有可靠来源再填' })),
      cost: opt(num({ description: '人均或门票花费（元）' })),
      allowRevisit: opt(str({ description: '填 "true" 表示用户明确要求再次游览已存在的同一地点' })),
    }),
    execute: async (args) => {
      signal.throwIfAborted();
      const name = args.name.trim();
      const point = deps.resolvePlace ? await deps.resolvePlace(name).catch(() => null) : null;
      signal.throwIfAborted();
      return reply(draft.addActivity({
        dayIndex: dayIndex(args.dayIndex),
        name,
        ...(args.category ? { category: args.category } : {}),
        ...(args.description ? { description: args.description } : {}),
        ...(args.position !== undefined ? { position: args.position } : {}),
        ...(args.openTime ? { openTime: args.openTime } : {}),
        ...(args.cost !== undefined ? { cost: args.cost } : {}),
        ...(point ? { lat: point.lat, lng: point.lng } : {}),
        ...(args.allowRevisit === 'true' ? { allowRevisit: true } : {}),
      }));
    },
  });

  const updateActivity = defineTool({
    name: 'update_activity',
    description: '修改某个活动的内容：名称、类目、简介、时间、花费。只传要改的字段；id 从 get_trip / get_day 取，不要自己编。',
    parameters: obj({
      dayIndex: int({ description: '第几天，从 1 开始' }),
      activityId: str({ description: '活动 id，必须来自当前行程' }),
      name: opt(str({ description: '新名称' })),
      category: opt(str({ description: '新类目' })),
      description: opt(str({ description: '新简介（≤500 字）' })),
      startTime: opt(str({ description: '开始时间 HH:MM；传空串表示清空' })),
      endTime: opt(str({ description: '结束时间 HH:MM；传空串表示清空' })),
      cost: opt(num({ description: '人均或门票花费（元）' })),
    }),
    execute: async (args) => {
      signal.throwIfAborted();
      // 改名 = 换成另一个地点：必须重新定位，不能沿用旧坐标（否则地图指错地方）
      const current = draft.current().days.find((day) => day.dayIndex === dayIndex(args.dayIndex))
        ?.activities.find((activity) => activity.id === args.activityId.trim());
      const renamed = args.name !== undefined && current !== undefined && args.name.trim() !== current.name;
      const point = renamed && deps.resolvePlace ? await deps.resolvePlace(args.name!.trim()).catch(() => null) : null;
      signal.throwIfAborted();
      return reply(draft.updateActivity({
        dayIndex: dayIndex(args.dayIndex),
        activityId: args.activityId.trim(),
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(point ? { lat: point.lat, lng: point.lng } : {}),
      ...(args.category !== undefined ? { category: args.category } : {}),
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.startTime !== undefined ? { startTime: args.startTime } : {}),
      ...(args.endTime !== undefined ? { endTime: args.endTime } : {}),
        ...(args.cost !== undefined ? { cost: args.cost } : {}),
      }));
    },
  });

  const deleteActivity = defineTool({
    name: 'delete_activity',
    description: '从某一天删除一个活动。用户没有明确要求删除时不要调用。',
    parameters: obj({
      dayIndex: int({ description: '第几天，从 1 开始' }),
      activityId: str({ description: '活动 id，必须来自当前行程' }),
    }),
    execute: async (args) => reply(draft.deleteActivity(dayIndex(args.dayIndex), args.activityId.trim())),
  });

  const moveActivity = defineTool({
    name: 'move_activity',
    description: '把一个活动移到另一天（跨天调整）。同一天内换顺序请用 reorder_day。',
    parameters: obj({
      fromDayIndex: int({ description: '原第几天' }),
      activityId: str({ description: '活动 id' }),
      toDayIndex: int({ description: '目标第几天' }),
      position: opt(int({ description: '在目标天的插入位置（0 起）；缺省追加到末尾' })),
    }),
    execute: async (args) => reply(draft.moveActivity(
      dayIndex(args.fromDayIndex), args.activityId.trim(), dayIndex(args.toDayIndex),
      args.position !== undefined ? args.position : undefined,
    )),
  });

  const reorderDay = defineTool({
    name: 'reorder_day',
    description: '重排某一天的活动顺序：必须给出当天全部活动 id 的新顺序（不能漏、不能加）。',
    parameters: obj({
      dayIndex: int({ description: '第几天' }),
      activityIds: arr(str({ description: '活动 id' }), { description: '当天全部活动 id 的新顺序' }),
    }),
    execute: async (args) => reply(draft.reorderDay(dayIndex(args.dayIndex), args.activityIds)),
  });

  const addDay = defineTool({
    name: 'add_day',
    description: '在行程末尾增加一天（空日程）。需要具体安排时再用 add_activity 填。',
    parameters: obj({ title: opt(str({ description: '当天主题，如「西湖环湖」；缺省「第N天」' })) }),
    execute: async (args) => reply(draft.addDay(args.title)),
  });

  const updateDay = defineTool({
    name: 'update_day',
    description: '修改某一天的主题标题。',
    parameters: obj({
      dayIndex: int({ description: '第几天' }),
      title: str({ description: '新主题（≤30 字）' }),
    }),
    execute: async (args) => reply(draft.updateDay(dayIndex(args.dayIndex), args.title)),
  });

  const deleteDay = defineTool({
    name: 'delete_day',
    description: '删除整天（含当天所有活动），后面的天数会自动前移。用户明确要求减少天数时才用。',
    parameters: obj({ dayIndex: int({ description: '第几天' }) }),
    execute: async (args) => reply(draft.deleteDay(dayIndex(args.dayIndex))),
  });

  const updateTrip = defineTool({
    name: 'update_trip',
    description: '修改行程整体信息：标题、出发日期、人数、预算、偏好、备注、出行方式。只传要改的字段。',
    parameters: obj({
      title: opt(str({ description: '行程标题（≤60 字）' })),
      startDate: opt(str({ description: '出发日期 YYYY-MM-DD；空串表示清空' })),
      partySize: opt(int({ description: '出行人数 1–50' })),
      budgetLevel: opt(str({ description: '预算档位：经济 / 舒适 / 豪华' })),
      totalBudget: opt(num({ description: '总预算（元）' })),
      preferences: opt(arr(str({ description: '偏好' }), { description: '偏好标签，≤10 个，如 美食、文化、亲子' })),
      extraNotes: opt(str({ description: '补充备注（≤200 字），如忌口、同行老人' })),
      transportMode: opt(str({ description: '主要出行方式：walk / cycle / transit / drive' })),
    }),
    execute: async (args) => reply(draft.updateTrip({
      ...(args.title !== undefined ? { title: args.title } : {}),
      ...(args.startDate !== undefined ? { startDate: args.startDate } : {}),
      ...(args.partySize !== undefined ? { partySize: args.partySize } : {}),
      ...(args.budgetLevel !== undefined ? { budgetLevel: args.budgetLevel } : {}),
      ...(args.totalBudget !== undefined ? { totalBudget: args.totalBudget } : {}),
      ...(args.preferences !== undefined ? { preferences: args.preferences } : {}),
      ...(args.extraNotes !== undefined ? { extraNotes: args.extraNotes } : {}),
      ...(args.transportMode !== undefined ? { transportMode: args.transportMode } : {}),
    })),
  });

  return [addActivity, updateActivity, deleteActivity, moveActivity, reorderDay, addDay, updateDay, deleteDay, updateTrip];
}
