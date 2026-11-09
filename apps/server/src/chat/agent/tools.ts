// 行程详情「主 Agent」的全量工具：读行程、查地点、搜全网、查天气、找餐厅、结构化追问、
// 更新出行条件、请求重新生成，以及改行程的写工具。子 Agent 只能拿到 toolPolicy 里的只读白名单。
// 每次请求的工具都是新闭包，绑定当轮的 trip、带预算的数据源与本回合状态。
import { arr, obj, opt, str } from '@earendil-works/pi-schema';
import { defineTool } from '@earendil-works/pi-durable';
import type { ToolExecutionApi, ToolRegistration } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import { Type } from '@sinclair/typebox';
import type { AgentQuestion, AgentQuestionAnswer, PlanningBriefPatch, Trip } from '@tripweaver/shared';
import { POI_CATEGORIES, PlanningBriefPatchSchema, type PoiCategory } from '@tripweaver/shared';
import type { DetailSources } from '../detailSources';
import type { DetailKnowledge } from '../detailKnowledge';
import type { WebSearchHit } from '../../integrations/websearch/searchSource';
import type { SourcedPoi } from '../../integrations/geoContracts';
import { searchAreaPlacesCore, webSearchCore, type AreaAccess, type WebAccess } from '../../agent/tools/dataTools';
import { searchFood } from '../foodSearch';
import { classifySubPoi } from '../../services/geofenceImport';
import { createTripWriteTools } from './writeTools';
import type { TripDraft } from './tripDraft';
import { createPlacePointCache, type PlacePointCache } from './placePoints';
import { createAgentTurnState, mergeBriefPatch, type AgentTurnState } from './turnState';
import { DEFAULT_DELEGATED_TASK_KIND, isDelegatedTaskKind, type DelegatedTaskKind } from '../../tasks/delegatedTask';

export interface WeatherQueryOptions {
  trip?: Trip | null;
  city?: string;
}

export interface TripToolDeps {
  trip?: Trip | null;
  sources: DetailSources;
  signal: AbortSignal;
  getWeather?: (options: WeatherQueryOptions) => Promise<unknown>;
  /** 本回合的行程草稿：主 Agent 始终是读写模式，读工具也统一读草稿。无行程时为 undefined/null */
  draft?: TripDraft | null;
  /** 目的地兜底（行前无行程时） */
  destination?: string;
  /** 新活动定位（高德）；未注入时新增活动按「位置待核实」处理 */
  resolvePlace?: (name: string) => Promise<{ lat: number; lng: number } | null>;
  /**
   * 本回合的可信点位缓存。不传则内部新建；子代理提交的坐标由调用方写进同一份缓存，
   * 于是「子代理查到的地点」再 add_activity 时不需要重新解析。
   */
  points?: PlacePointCache;
  /** 本回合跨工具状态：美食候选、追问、Brief 增量、生成结果 */
  state?: AgentTurnState;
  /**
   * 通用后台委派（对齐 openmuse 的 delegate_task：立即返回任务 id，worker 持续跑）。
   * 由 turn 注入（需要 job / 凭据 / 事务），工具只负责调用与把任务引用写回 state。
   */
  delegateTask?: (kind: DelegatedTaskKind, api: ToolExecutionApi, context: Context) => Promise<{ taskId?: string; error?: string }>;
  /** 当前/最近一次后台任务的状态与阶段进度（供主 Agent 回答「任务到哪了」）。 */
  taskStatus?: () => unknown | Promise<unknown>;
  /** 当前对话范围（前端选中的某一天）；美食检索默认用它 */
  scopeDayId?: string;
  /** HITL：暂停 Agent，等待用户通过独立接口回答；返回 null 表示超时/取消 */
  askUser?: (questions: AgentQuestion[]) => Promise<AgentQuestionAnswer[] | null>;
  /** 问答记录写入 state 后回调：index 为第一条记录，count 为同一次 ask_user 的问题数。 */
  onQuestionRecorded?: (index: number, count: number) => void;
}

const text = (value: string) => [{ type: 'text' as const, text: value }];

/** 搜索结果原样给模型：不按字数截断，上下文增长交给 compaction（见 spec 的“不截断”约定）。 */
export function webSearchPayload(hits: readonly WebSearchHit[]) {
  return hits.map((hit) => ({
    title: hit.title,
    url: hit.url,
    summary: hit.summary,
    site: hit.siteName,
    date: hit.datePublished || undefined,
  }));
}

/** 地点结果不做条数裁剪：一次搜索最多 10 条，交给模型自己挑。商业信息原样带上（v5 business）。 */
export function searchPlacesPayload(hits: readonly SourcedPoi[]) {
  return hits.map((hit) => ({
    name: hit.name,
    type: hit.type,
    address: hit.address,
    lat: hit.location?.lat,
    lng: hit.location?.lng,
    opentime: hit.opentime,
    rating: hit.rating,
    cost: hit.cost,
    tel: hit.tel,
  }));
}

/**
 * 行程快照：给模型的完整事实，不做内容裁剪。
 * 描述、费用、开放时间、通勤段、住宿都原样保留；只剔除与问答无关的机器字段（polyline、坐标来源、来源链接、封面元数据）。
 */
export function tripSnapshot(trip: Trip, dayIndex?: number) {
  return {
    destination: trip.destination,
    startDate: trip.startDate,
    transportMode: trip.transportMode ?? 'transit',
    budgetLevel: trip.budgetLevel,
    totalBudget: trip.totalBudget,
    partySize: trip.partySize,
    preferences: trip.preferences,
    extraNotes: trip.extraNotes,
    lodging: trip.lodging,
    // 生成结果摘要与候选：让主 Agent 能解释「为什么这么排 / 有什么要注意」，不用再翻任务表。
    meta: {
      reviewNotes: trip.meta.reviewNotes,
      dataSources: trip.meta.dataSources ?? [],
      ...(trip.meta.advice ? { advice: trip.meta.advice } : {}),
    },
    ...(trip.overview?.length ? { overview: trip.overview.slice(0, 20).map((poi) => poi.name) } : {}),
    days: trip.days
      .filter((day) => dayIndex === undefined || day.dayIndex === dayIndex)
      .map((day) => ({
        day: day.dayIndex,
        title: day.title,
        lodging: day.lodging,
        activities: day.activities.map((activity) => ({
          id: activity.id,
          name: activity.name,
          category: activity.category,
          startTime: activity.startTime,
          endTime: activity.endTime,
          durationMin: activity.durationMin,
          description: activity.description,
          cost: activity.cost,
          openTime: activity.openTime,
          lat: activity.lat,
          lng: activity.lng,
        })),
        legs: day.legs?.map((leg) => ({
          from: leg.fromActivityId,
          to: leg.toActivityId,
          mode: leg.mode,
          durationMin: leg.durationMin,
          distanceM: leg.distanceM,
        })),
      })),
  };
}

function normalizeCategory(value: string | undefined): PoiCategory {
  return (POI_CATEGORIES as readonly string[]).includes(value ?? '') ? value as PoiCategory : 'attraction';
}

/** 条件更新 + 通用后台委派 + 任务状态：行程内对话与行前回合共用同一实现。 */
function delegationTools(
  state: AgentTurnState,
  deps: Pick<TripToolDeps, 'delegateTask' | 'taskStatus'>,
) {
  const updateBrief = defineTool({
    name: 'update_brief',
    description: '更新「下一次完整生成」使用的出行条件（目的地、日期、天数、人数、节奏、偏好、约束、住宿、备注）。修改当前行程本身请用 update_trip，不要用它。',
    parameters: PlanningBriefPatchSchema,
    execute: async (args) => {
      // merge 而不是覆盖：一轮里模型可能多次 update_brief（先改日期、再补约束），
      // 标量字段仅当本次有定义才覆盖；约束增删按数组拼接去重（见 mergeBriefPatch）。
      state.briefPatch = mergeBriefPatch(state.briefPatch, args as PlanningBriefPatch);
      return { output: text('已记录出行条件更新') };
    },
  });

  // 通用后台委派：任务立即返回 id，用户在任务页看进度，完成后由任务结果通知主 Agent。
  // 主 Agent 不阻塞，也不假装结果已经出来。
  const delegateTask = defineTool({
    name: 'delegate_task',
    description: '把较长的后台工作委派给子 Agent，立即返回任务 id（通常需要几分钟）。当前支持 kind=trip_generation：按当前出行条件生成或重新规划整份行程，有当前行程时生成它的新版本、不覆盖旧版本。仅当用户明确要求生成整份行程时调用；调用后告诉用户已在后台开始，不要等结果、不要说已完成。其他咨询或小修改不要调用。',
    // 同一回合重跑时按 requestId 幂等拿到同一个任务，不会重复建 job。
    replay: 'safe',
    parameters: obj({
      kind: opt(str({ description: `任务类型，目前支持 ${DEFAULT_DELEGATED_TASK_KIND}（缺省）` })),
      reason: opt(str({ description: '一句话说明为什么委派这次任务' })),
    }),
    execute: async (args, api, context) => {
      if (!deps.delegateTask) return { output: text('错误：当前会话未启用任务委派'), isError: true };
      if (args.kind && !isDelegatedTaskKind(args.kind)) {
        return { output: text(`不支持的任务类型：${args.kind}`), isError: true };
      }
      const kind: DelegatedTaskKind = isDelegatedTaskKind(args.kind) ? args.kind : DEFAULT_DELEGATED_TASK_KIND;
      const result = await deps.delegateTask(kind, api, context);
      if (!result.taskId) return { output: text(result.error ?? '任务没有启动'), isError: true };
      state.delegatedTask = { id: result.taskId, kind };
      return { output: text(JSON.stringify({ ok: true, taskId: result.taskId, kind, status: 'running', note: '后台任务已开始。告诉用户可以在任务页查看进度；完成时会通知。不要声称任务已经完成。' })) };
    },
  });

  const taskStatus = defineTool({
    name: 'task_status',
    description: '读取当前或最近一次后台任务的状态、阶段与已完成步骤。用于回答「任务到哪了 / 好了吗」；不要用它代替用户打开任务页，也不要在没有任务时编造进度。',
    parameters: obj({}),
    execute: async () => {
      if (!deps.taskStatus) return { output: text(JSON.stringify({ running: false })) };
      return { output: text(JSON.stringify(await deps.taskStatus())) };
    },
  });

  return { updateBrief, delegateTask, taskStatus };
}

export function createTripTools(deps: TripToolDeps): ToolRegistration[] {
  const { sources, signal } = deps;
  // 读工具一律读「当前草稿」：本回合的写入立即对后续读取可见。无行程时为 null。
  const view = (): Trip | null => deps.draft?.current() ?? deps.trip ?? null;
  const getCity = (): string | null => {
    const city = view()?.destination ?? deps.destination ?? deps.state?.briefPatch?.destination;
    return typeof city === 'string' && city.trim() ? city.trim() : null;
  };
  // 本回合核验过的坐标（search_places 结果 + 子代理结构化提交）：写工具改名/新增时优先用，
  // 避免把已经查准的地点再交给模糊解析（实测「人民公园东门」会被解到 30km 外的同名点）。
  const points = deps.points ?? createPlacePointCache();
  const state = deps.state ?? createAgentTurnState();

  const getTrip = defineTool({
    name: 'get_trip',
    description: '读取当前行程的完整结构：每天的标题与活动（含活动 id、时间、类目、简介）。回答行程安排类问题前先调用。',
    parameters: obj({}),
    execute: async () => {
      const trip = view();
      if (!trip) {
        return {
          output: text(JSON.stringify({
            hasTrip: false,
            message: '当前会话尚未生成行程；需要规划整份行程时请调用 delegate_task。',
          })),
        };
      }
      return { output: text(JSON.stringify(tripSnapshot(trip))) };
    },
  });

  const getDay = defineTool({
    name: 'get_day',
    description: '只读取某一天的安排，行程较长、只需要看一天时用。',
    parameters: obj({ dayIndex: str({ description: '第几天，从 1 开始' }) }),
    execute: async (args) => {
      const trip = view();
      if (!trip) {
        return {
          output: text(JSON.stringify({
            hasTrip: false,
            message: '当前会话尚未生成行程。',
          })),
        };
      }
      const dayIndex = Number.parseInt(args.dayIndex, 10);
      const day = trip.days.find((item) => item.dayIndex === dayIndex);
      if (!day) return { output: text(`没有第 ${args.dayIndex} 天；当前行程共 ${trip.days.length} 天`) };
      return { output: text(JSON.stringify(tripSnapshot(trip, day.dayIndex))) };
    },
  });

  const searchPlaces = defineTool({
    name: 'search_places',
    description: '按关键词核实真实地点（景点/餐饮/住宿），返回名称、地址、坐标与营业时间。可指定目标城市，缺省使用当前会话或行程城市。',
    parameters: obj({
      keyword: str({ description: '地点关键词，如「断桥残雪」「西湖」「故宫博物院」' }),
      category: opt(str({ description: 'attraction / food / hotel，缺省 attraction' })),
      city: opt(str({ description: '地点所在城市（如杭州、北京、成都），缺省使用当前会话或行程城市' })),
    }),
    execute: async (args) => {
      signal.throwIfAborted();
      const targetCity = args.city?.trim() || getCity();
      if (!targetCity) {
        return { output: text('请在参数中指定地点所在城市（city），或先向用户确认目的地城市。') };
      }
      const category = normalizeCategory(args.category);
      const hits = await sources.poi.searchPois(category, args.keyword, targetCity, signal);
      if (!hits.length) return { output: text(`在${targetCity}未查到「${args.keyword}」相关地点`) };
      for (const hit of hits) {
        if (hit.location) points.remember(hit.name, hit.location);
        if (hit.photoUrls.length) points.rememberPhotos(hit.name, hit.photoUrls);
      }
      return { output: text(JSON.stringify(searchPlacesPayload(hits))) };
    },
  });

  // 片区检索与全网搜索：核心实现与规划子代理共用（agent/tools/dataTools），这里只做 SDK 包装与依赖适配。
  const chatAreaAccess: AreaAccess = {
    signal,
    async resolve({ area, areaId, city }) {
      if (areaId) return { ok: false, error: '错误：对话里请用片区名称（area）' };
      const name = area?.trim();
      if (!name) return { ok: false, error: '错误：需要片区名称（area）' };
      const targetCity = city?.trim() || getCity();
      if (!targetCity) return { ok: false, error: '错误：请在参数中指定片区所在城市（city），或先向用户确认目的地城市' };
      const centers = await sources.poi.searchPois('attraction', name, targetCity, signal);
      const center = centers.find((hit) => hit.location)?.location;
      if (!center) return { ok: false, error: `在${targetCity}未找到「${name}」的中心点，先用 search_places 查一次` };
      return { ok: true, area: { name, center, radiusM: 2500 } };
    },
    async search({ center, radiusM, keywords }) {
      try {
        return { ok: true, pois: await sources.searchArea({ center, radiusM, ...(keywords ? { keywords } : {}) }) };
      } catch (error) {
        return { ok: false, error: `片区检索失败：${error instanceof Error ? error.message : '未知错误'}` };
      }
    },
    accept(pois) {
      for (const hit of pois) {
        if (hit.location) points.remember(hit.name, hit.location);
        if (hit.photoUrls.length) points.rememberPhotos(hit.name, hit.photoUrls);
      }
    },
  };
  const areaCore = searchAreaPlacesCore(chatAreaAccess);
  const searchAreaPlaces = defineTool({
    name: areaCore.name,
    description: areaCore.description,
    parameters: areaCore.parameters as never,
    execute: async (args) => {
      const result = await areaCore.run(args as Record<string, unknown>);
      return {
        output: text(result.text),
        ...(result.details ? { details: result.details } : {}),
        ...(result.isError ? { isError: true } : {}),
      };
    },
  });

  const chatWebAccess: WebAccess = {
    signal,
    async search(query) {
      try {
        const hits = await sources.search.search(query);
        return hits.length
          ? { ok: true, hits: hits.map(({ title, url, summary }) => ({ title, url, summary })) }
          : { ok: false, error: `未搜到「${query}」的相关资料` };
      } catch (error) {
        return { ok: false, error: `联网检索失败：${error instanceof Error ? error.message : '未知错误'}` };
      }
    },
  };
  const webCore = webSearchCore(chatWebAccess);
  const webSearch = defineTool({
    name: webCore.name,
    description: webCore.description,
    parameters: webCore.parameters as never,
    execute: async (args) => {
      const result = await webCore.run(args as Record<string, unknown>);
      return {
        output: text(result.text),
        ...(result.details ? { details: result.details } : {}),
        ...(result.isError ? { isError: true } : {}),
      };
    },
  });

  const getWeather = defineTool({
    name: 'get_weather',
    description: '查询指定城市或当前行程的天气预报（由和风天气官方提供 15 天真实数据）。可自由指定城市（city）；缺省时自动使用当前会话或行程城市。',
    parameters: obj({
      city: opt(str({ description: '要查询天气的城市名称（如「成都」「杭州」「北京」），缺省时使用当前会话或行程城市' })),
    }),
    execute: async (args) => {
      if (!deps.getWeather) return { output: text('天气服务不可用') };
      const trip = view();
      const requestedCity = args.city?.trim();
      const targetCity = requestedCity || getCity();

      if (requestedCity || !trip) {
        if (!targetCity) {
          return { output: text('请在参数中指定要查询天气的城市名称（city），如「成都」「北京」。') };
        }
        const data = await deps.getWeather({ city: targetCity });
        return { output: text(JSON.stringify(data)) };
      }

      const data = await deps.getWeather({ trip, city: targetCity ?? undefined });
      return { output: text(JSON.stringify(data)) };
    },
  });

  const searchFoodTool = defineTool({
    name: 'search_food',
    description: '查找当前行程附近可添加的真实餐厅，返回候选卡片（名称/地址/就近活动/人均等）。用户问当前行程中的美食、餐厅、午餐/晚餐推荐时使用；卡片会显示在回答下方。若查询其他城市或通用美食，可直接使用 search_places。',
    parameters: obj({
      query: str({ description: '用餐需求，如「川菜」「清淡」「人民公园附近」' }),
      city: opt(str({ description: '目标城市，若不是当前行程城市，建议直接使用 search_places(category="food") 查找' })),
      dayIndex: opt(str({ description: '限定第几天，缺省用当前对话范围；整趟行程可省略' })),
      meal: opt(str({ description: 'lunch 或 dinner，缺省 lunch' })),
    }),
    execute: async (args) => {
      signal.throwIfAborted();
      const trip = view();
      const targetCity = args.city?.trim();
      // 如果明确指定了非当前行程的城市，自动平滑按 search_places 检索并返回真实餐饮 POI
      if (targetCity && (!trip || trip.destination !== targetCity)) {
        const hits = await sources.poi.searchPois('food', args.query, targetCity, signal);
        if (!hits.length) return { output: text(`在${targetCity}未查到「${args.query}」相关餐厅`) };
        return { output: text(JSON.stringify(searchPlacesPayload(hits))) };
      }
      if (!trip) {
        const fallbackCity = getCity();
        if (fallbackCity) {
          const hits = await sources.poi.searchPois('food', args.query, fallbackCity, signal);
          if (hits.length) return { output: text(JSON.stringify(searchPlacesPayload(hits))) };
        }
        return { output: text('当前尚未生成行程；查询特定城市餐饮美食请使用 search_places(category="food", city="城市名")。') };
      }
      const dayIndex = args.dayIndex ? Number.parseInt(args.dayIndex, 10) : undefined;
      if (dayIndex !== undefined && !trip.days.some((day) => day.dayIndex === dayIndex)) {
        return { output: text(`没有第 ${args.dayIndex} 天；当前行程共 ${trip.days.length} 天`) };
      }
      const dayId = dayIndex !== undefined
        ? trip.days.find((day) => day.dayIndex === dayIndex)?.id
        : deps.scopeDayId;
      const meal = args.meal === 'dinner' ? 'dinner' : 'lunch';
      const knowledge: DetailKnowledge = { places: [], web: [], references: [], notes: [] };
      const result = await searchFood(knowledge, sources, trip, dayId, args.query, state.excludedFoodKeys, signal, meal);
      for (const candidate of result.candidates) {
        state.excludedFoodKeys.add(candidate.poiKey);
        points.remember(candidate.name, candidate);
        if (!state.foodCandidates.some((item) => item.poiKey === candidate.poiKey)) state.foodCandidates.push(candidate);
      }
      state.foodNotes.push(...result.notes);
      if (!result.candidates.length) {
        return { output: text(`没有找到符合条件且有完整位置资料的具体餐厅${result.notes.length ? `：${result.notes.join(' ')}` : ''}`) };
      }
      return {
        output: text(JSON.stringify(result.candidates.map((candidate) => ({
          name: candidate.name,
          address: candidate.address,
          dayIndex: candidate.dayIndex,
          nearby: candidate.nearby,
          meal: candidate.meal,
          reason: candidate.reason,
          cuisine: candidate.cuisine,
          openTime: candidate.openTime,
        })))),
      };
    },
  });

  const askUser = defineTool({
    name: 'ask_user',
    description: '需要用户做选择、确认改动或取舍方案时必须使用：暂停当前回合，向用户展示问题卡；禁止在回复末尾用文字问「要不要/你希望/可以吗」。用户回答后你会拿到答案并继续本轮。问题要具体、可直接回答；有推荐选项时放在第一个。',
    parameters: Type.Object({
      questions: Type.Array(Type.Object({
        id: Type.Optional(Type.String({ maxLength: 100, description: '稳定问题 id，缺省自动生成' })),
        question: Type.String({ minLength: 1, maxLength: 160, description: '只写一句要用户决定的事（建议 ≤60 字），不要复述诊断' }),
        header: Type.Optional(Type.String({ maxLength: 40, description: '短标题，如「确认」「选择范围」' })),
        options: Type.Optional(Type.Array(Type.Object({
          label: Type.String({ minLength: 1, maxLength: 40 }),
          description: Type.Optional(Type.String({ maxLength: 100 })),
        }), { maxItems: 6, description: '可点击选项；用户始终可以自行输入答案' })),
        multiSelect: Type.Optional(Type.Boolean({ description: '是否允许多选，缺省单选' })),
      }), { minItems: 1, maxItems: 3 }),
    }),
    execute: async (rawArgs) => {
      const args = rawArgs as {
        questions: Array<{
          id?: string; question: string; header?: string;
          options?: Array<{ label: string; description?: string }>;
          multiSelect?: boolean;
        }>;
      };
      if (!deps.askUser) return { output: text('当前环境不支持交互提问'), isError: true };
      const ids = new Set<string>();
      const questions: AgentQuestion[] = [];
      for (const [index, item] of args.questions.entries()) {
        const question = item.question.trim().slice(0, 300);
        if (!question) return { output: text('问题不能为空'), isError: true };
        let id = item.id?.trim().slice(0, 100) || `q${index + 1}`;
        if (ids.has(id)) id = `${id}-${index + 1}`;
        ids.add(id);
        const options = (item.options ?? [])
          .map((option) => ({
            label: option.label.trim().slice(0, 80),
            ...(option.description?.trim() ? { description: option.description.trim().slice(0, 200) } : {}),
          }))
          .filter((option) => option.label)
          .slice(0, 6);
        questions.push({
          id,
          question,
          ...(item.header?.trim() ? { header: item.header.trim().slice(0, 60) } : {}),
          options,
          ...(item.multiSelect ? { multiSelect: true } : {}),
        });
      }
      const answers = await deps.askUser(questions);
      if (!answers) {
        state.questionExpired = true;
        return { output: text('用户未在时限内回答，本轮结束；不要重复询问同一个问题'), isError: true, control: { terminate: true } };
      }
      const firstIndex = state.questions.length;
      for (const question of questions) {
        const answer = answers.find((item) => item.id === question.id);
        state.questions.push({
          question: question.question.slice(0, 500),
          options: question.options.map((option) => option.label.slice(0, 200)).slice(0, 12),
          selected: (answer?.selected ?? []).map((s) => s.slice(0, 200)).slice(0, 12),
          ...(answer?.custom ? { custom: answer.custom.slice(0, 500) } : {}),
        });
      }
      // 同一次 ask_user 的多个问题是一组：前端合并成一个问答气泡，而不是每个问题各占一个。
      deps.onQuestionRecorded?.(firstIndex, questions.length);
      return { output: text(JSON.stringify({ answers })) };
    },
  });

  const { updateBrief, delegateTask, taskStatus } = delegationTools(state, deps);

  return [
    getTrip,
    getDay,
    searchPlaces,
    searchAreaPlaces,
    webSearch,
    getWeather,
    searchFoodTool,
    askUser,
    updateBrief,
    delegateTask,
    taskStatus,
    ...createTripWriteTools({ draft: deps.draft, signal, resolvePlace: deps.resolvePlace, cachedPoint: (name) => points.find(name) }),
  ];
}