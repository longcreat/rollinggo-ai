// 地理后处理流水线（v0.5，架构铁律：机械工作移出 LLM 循环）
// orchestrator 在每轮编排后、审校前调用（M0-A 时序前移）：geocodeAll 补全全量坐标（GCJ-02），computeLegs 生成相邻活动通勤段。
// 服务商失败/超额/无 Key 均静默降级（Nominatim 转换 / 启发式估算），生成流程永不因此失败。
// geocodeAll 出口统一过地理合理性校验（07-18，见 geoSanity.ts）：异地错配坐标弃用，宁缺毋错。
// 走哪家服务商由 integrations/geoProvider 决定（09-25）：本文件只认门面，不直接引用 amap/*。
import { LODGING_SENTINEL, effectiveLegMode, haversineMeters, type LegMode, type ResearchPoi, type TransitLeg } from '@tripweaver/shared';
import type { GeocodedPlace } from '@tripweaver/integrations/geoContracts';
import type { MapProvider } from '@tripweaver/core/env';
import { ROUTE_MAX_PER_TASK } from '@tripweaver/integrations/amap/route';
import { createNullGeoProvider, resolveGeoProvider, type GeoProvider } from '@tripweaver/integrations/geoProvider';
import { estimateLeg } from './legEstimator';
import { rejectFarGeocodes } from './geoSanity';
import type { DraftTrip } from './draft';
import { activityPlaceName, createResearchPlaceLookup, type DraftActivity, type PlaceLookupResult, type ResearchLocation } from './placeLookup';

export const GEOCODE_MAX_PER_TASK = 40;   // 单次生成 ≤40 次定位调用（服务商 POI text + v3 geocode 合计；含 lodging 解析）
const GEOCODE_PIPELINE_CONCURRENCY = 2;   // 仅重叠高德与 Nominatim 独立队列；各提供方内部仍严格串行限速

export interface GeoSession {
  /** 当前生效服务商的调用尝试次数（geocode + route 合计）：计入 usage 事件与 generations 的用量列 */
  stats: { calls: number };
  /** 路线/地理编码链实际生效的服务商（init 后才有值；'null' = 无凭据）。供用量列按家分流记账 ——
   *  POI 搜索固定天地图，与这条链各记各的，不能再靠单一开关判断。 */
  providerKind(): MapProvider | 'null';
  /** 异步初始化（09-18 PG 化后凭据与额度解析为 async）：须在任何其他方法前 await 一次 */
  init(): Promise<void>;
  /** 调研结束后注入任务内真实地点；坐标仍由 geocodeAll 暂存、校验后采纳。 */
  useResearchPlaces(pool: readonly ResearchPoi[], locations: ReadonlyMap<string, ResearchLocation>): void;
  /** 编排 Agent geocode_place 工具入口：走同一解析链与记账 */
  resolvePlace(name: string): Promise<GeocodedPlace | null>;
  /** 后处理 pass 1：补全 GCJ-02 坐标。changedOnly 仅重查上次解析后改变的地点/坐标状态，跳过未变化的失败项。 */
  geocodeAll(draft: DraftTrip, onProgress: (text: string) => void, signal?: AbortSignal, changedOnly?: boolean): Promise<void>;
  /** 后处理 pass 2：为每天相邻活动对生成通勤段（高德路径规划，降级启发式）；signal 中止时尽快抛出。
   *  onlyDayIndexes（从 1 开始）：只重算指定天 —— 层3 修复器换天后的定向重验，省额度省时延；缺省全量 */
  computeLegs(
    draft: DraftTrip,
    onProgress: (text: string) => void,
    signal?: AbortSignal,
    onlyDayIndexes?: readonly number[],
  ): Promise<void>;
}

export function createGeoSession(userId: string, destination: string, baseMode: LegMode = 'transit'): GeoSession {
  // 凭据与日额度在 init() 中异步解析（09-18：DB 访问 PG 化后全链路 async）；
  // 未配置凭据或日额度不足时的降级 provider：provider 级整级跳过，只留 Nominatim + 启发式
  let provider: GeoProvider = createNullGeoProvider();
  // 任务级熔断器在 init() 中随 provider 一起就位（凭据与目的地上下文绑定在 provider 实例内）
  let routeBreaker = provider.createRouteBreaker();

  const stats = { calls: 0 };
  let geocodeCalls = 0;
  let routeCalls = 0;
  // 任务级上限记账：调用尝试前占位（缓存命中同样计数，口径=接受的调用尝试，见 spec 集成规范）
  const tryGeocode = () => {
    if (geocodeCalls >= GEOCODE_MAX_PER_TASK) return false;
    geocodeCalls += 1;
    stats.calls += 1;
    return true;
  };
  const tryRoute = () => {
    if (routeCalls >= ROUTE_MAX_PER_TASK) return false;
    routeCalls += 1;
    stats.calls += 1;
    return true;
  };

  // 活动 id → adcode（transit 路径规划 city 入参）；目的地级 adcode 兜底
  const adcodes = new Map<string, string>();
  let lookupPlace: (activity: DraftActivity) => PlaceLookupResult = (activity) => ({ name: activityPlaceName(activity) });
  const rejectedResearchNames = new Set<string>();
  const lastResolutionStates = new Map<string, string>();
  let lastLodgingName: string | undefined;
  const resolutionState = (activity: DraftActivity) => JSON.stringify([
    activity.poiId ?? '', activityPlaceName(activity), activity.lat, activity.lng, activity.coordSource,
  ]);
  // 目的地城市级解析 memo（一次解析两用，跨轮共享）：adcode 供 transit 路径规划兜底，
  // 坐标供 geocodeAll 出口地理合理性校验的参照点①。undefined=未解析，null=解析失败
  // （不重试——geocodeActivity 内部已有多级降级与 24h 缓存；计入 tryGeocode 额度记账）
  let cityPlace: GeocodedPlace | null | undefined;
  const resolveCityPlace = async (): Promise<GeocodedPlace | null> => {
    if (cityPlace === undefined) {
      cityPlace = await provider.geocodeActivity(destination, '', tryGeocode);
    }
    return cityPlace;
  };
  const resolveCityAdcode = async (): Promise<string> => (await resolveCityPlace())?.adcode || '';

  // 通勤段跨轮记忆（时序前移 M0-A）：computeLegs 每轮编排后都跑，同一对端点+坐标的 amap leg 已算过就复用，
  // 不再第二次调用 tryRoute() —— 保证 ROUTE_MAX_PER_TASK 在修订轮不被未变动的段重复消耗（额度闸门仍成立）。
  // 启发式结果不记忆：多为一次性失败的降级产物，修订轮应在剩余额度内重试高德（真实路由永远好过启发式）。
  const legMemo = new Map<string, TransitLeg>();
  const legMemoKey = (from: { id: string; lat: number; lng: number }, to: { id: string; lat: number; lng: number }) =>
    `${from.id}:${to.id}:${from.lat.toFixed(5)},${from.lng.toFixed(5)}:${to.lat.toFixed(5)},${to.lng.toFixed(5)}`;

  return {
    stats,
    providerKind: () => provider.kind,

    async init() {
      // 高德每次外呼前按服务原子扣减；天地图保留任务级余额预检。
      const resolved = await resolveGeoProvider(userId);
      provider =
        resolved.enabled && (resolved.kind === 'amap' || (await resolved.budgetRemaining()) >= GEOCODE_MAX_PER_TASK + ROUTE_MAX_PER_TASK)
          ? resolved
          : createNullGeoProvider();
      routeBreaker = provider.createRouteBreaker();
    },

    useResearchPlaces(pool, locations) {
      lookupPlace = createResearchPlaceLookup(pool, locations);
    },

    resolvePlace(name) {
      return provider.geocodeActivity(name, destination, tryGeocode);
    },

    async geocodeAll(draft, onProgress, signal, changedOnly = false) {
      const all = draft.mutableDays().flatMap((d) => d.activities);
      const pending = all.filter((a) => ((a.lat === 0 && a.lng === 0) || a.coordSource !== 'geocoded')
        && (!changedOnly || lastResolutionStates.get(a.id) !== resolutionState(a)));
      // 编排 Agent 经 geocode_place 已解析的坐标即 GCJ-02，补上坐标系标注
      for (const a of all) {
        if (a.coordSource === 'geocoded') a.coordSystem = 'gcj02';
      }
      // 住宿锚点（ST3）是否待解析：与活动同链同记账，解析结果同过出口校验
      const lodging = draft.lodging;
      const lodgingPending = Boolean(lodging && !(typeof lodging.lat === 'number' && typeof lodging.lng === 'number')
        && (!changedOnly || lastLodgingName !== lodging.name));

      // 校验参照点①：目的地城市中心 —— 开始时先解析，城市名 AMAP 解析成功率最高、优先占用
      // geocode 额度；memo 跨轮共享且与 computeLegs 的 adcode 兜底同一次调用。无待解析项时不消耗。
      if (signal?.aborted) throw new Error('已取消');
      const cityCenter = pending.length || lodgingPending ? await resolveCityPlace() : null;

      // 解析结果先暂存不落坐标：出口统一过地理合理性校验后再采纳（校验只拒不改，宁缺毋错）
      interface StagedPlace {
        activity: DraftActivity;
        place: GeocodedPlace;
        name: string;
        reused: boolean;
      }
      const stagedByIndex: Array<StagedPlace | undefined> = new Array(pending.length);
      let nextIndex = 0;
      let done = 0;
      const worker = async () => {
        while (nextIndex < pending.length) {
          const index = nextIndex++;
          const activity = pending[index]!;
          // 最多两个工作槽；每个槽取下一项前检查，取消后不继续铺开剩余外呼。
          if (signal?.aborted) return;
          const lookup = lookupPlace(activity);
          adcodes.delete(activity.id);
          const reused = Boolean(lookup.point && !rejectedResearchNames.has(lookup.name));
          const place: GeocodedPlace | null = reused && lookup.point
            ? { ...lookup.point, origin: 'amap-poi' }
            : await provider.geocodeActivity(lookup.name, destination, tryGeocode);
          done += 1;
          if (place) stagedByIndex[index] = { activity, place, name: lookup.name, reused };
          // 全链失败：保留模型给的估算坐标（或 0,0），coordSource 维持 estimated 如实标注
          if (done % 4 === 0 || done === pending.length) {
            onProgress(`正在解析活动坐标 (${done}/${pending.length})`);
          }
        }
      };
      const workerCount = Math.min(GEOCODE_PIPELINE_CONCURRENCY, pending.length);
      await Promise.all(Array.from({ length: workerCount }, worker));
      if (signal?.aborted) throw new Error('已取消');
      // 工作槽完成顺序可能不同；校验和采纳必须恢复活动原顺序，保证结果与串行版本一致。
      let staged = stagedByIndex.filter((item): item is StagedPlace => item !== undefined);

      // 住宿锚点解析（ST3）：同一解析链与记账（计入 GEOCODE_MAX_PER_TASK）；失败静默 —— 无坐标即不生成住宿 leg
      let lodgingPlace: GeocodedPlace | null = null;
      if (lodging && lodgingPending) {
        if (signal?.aborted) throw new Error('已取消');
        onProgress('正在解析住宿位置…');
        lastLodgingName = lodging.name;
        adcodes.delete(LODGING_SENTINEL);
        lodgingPlace = await provider.geocodeActivity(lodging.name, destination, tryGeocode);
      }
      if (signal?.aborted) throw new Error('已取消');

      // ---- 出口地理合理性校验（07-18）：AMAP/Nominatim 结果统一按距参照点校验，与来源无关 ----
      // 中位互检池（参照点②候选）= 前轮已校验采纳的 geocoded 活动坐标 + 本次暂存坐标
      // （修订轮新增点少时，靠前轮坐标保住参照可得性）；住宿只受检、不进池（池按「活动坐标中位中心」定义），
      // 且以 kind:'lodging' 标注走专项更严阈值（live shanghai 同名近距错配漏网教训，见 geoSanity.LODGING_SANITY_MAX_KM）
      const validateStaged = (): Set<number> => {
        const medianPool = [
          ...all.filter((a) => !pending.includes(a) && a.coordSource === 'geocoded' && (a.lat !== 0 || a.lng !== 0))
            .map((a) => ({ lat: a.lat, lng: a.lng })),
          ...staged.map((s) => ({ lat: s.place.lat, lng: s.place.lng })),
        ];
        const checks = [
          ...staged.map((s) => ({ name: s.activity.name, lat: s.place.lat, lng: s.place.lng })),
          ...(lodging && lodgingPlace
            ? [{ name: `住宿 ${lodging.name}`, lat: lodgingPlace.lat, lng: lodgingPlace.lng, kind: 'lodging' as const }]
            : []),
        ];
        try {
          return rejectFarGeocodes(checks, cityCenter, medianPool);
        } catch {
          // 与既有可选校验的降级行为一致。
          return new Set();
        }
      };
      let rejected = validateStaged();
      const rejectedReused = staged.filter((item, index) => item.reused && rejected.has(index));
      if (rejectedReused.length) {
        const failed = new Set<StagedPlace>();
        for (const item of rejectedReused) {
          if (signal?.aborted) throw new Error('已取消');
          // A bad research match gets the original disambiguation chain, not automatic adoption.
          rejectedResearchNames.add(item.name);
          const place = await provider.geocodeActivity(item.name, destination, tryGeocode);
          if (place) item.place = place;
          else failed.add(item);
          item.reused = false;
        }
        staged = staged.filter((item) => !failed.has(item));
        rejected = validateStaged();
      }
      if (signal?.aborted) throw new Error('已取消');

      // 采纳未被拒的解析结果；被拒条目不置坐标 —— 与解析失败同路径（活动保持 estimated/无坐标，
      // 走既有 located 缺口/兜底），绝不试图「纠正」坐标
      staged.forEach(({ activity, place }, i) => {
        if (rejected.has(i)) return;
        activity.lat = place.lat;
        activity.lng = place.lng;
        activity.coordSource = 'geocoded';
        activity.coordSystem = 'gcj02';
        if (place.adcode) adcodes.set(activity.id, place.adcode);
      });
      for (const activity of pending) lastResolutionStates.set(activity.id, resolutionState(activity));
      // 住宿条目在 checks 中的下标 = staged.length；被拒则不置坐标 → 不生成住宿 leg（既有 ST3 降级）
      if (lodging && lodgingPlace && !rejected.has(staged.length)) {
        lodging.lat = lodgingPlace.lat;
        lodging.lng = lodgingPlace.lng;
        lodging.coordSystem = 'gcj02';
        if (lodgingPlace.adcode) adcodes.set(LODGING_SENTINEL, lodgingPlace.adcode);
      }
    },

    async computeLegs(draft, onProgress, signal, onlyDayIndexes) {
      // 定向重算（层3 修复器）：只处理指定天，缺省全量。amap leg 经 legMemo 复用，重算不重复烧 route 额度
      const filter = onlyDayIndexes?.length ? new Set(onlyDayIndexes) : null;
      const days = draft.mutableDays().filter((_, i) => !filter || filter.has(i + 1));
      const pairs = days.reduce((n, d) => n + Math.max(0, d.activities.length - 1), 0);
      let done = 0;

      // 单段估算：先高德路径规划（transit 需 adcode），失败/超额降级启发式 —— 相邻活动对与住宿 leg 共用
      // 跨轮复用：同端点同坐标的 amap leg 直接返回 memo，不重复占 route 额度；启发式（降级）结果不记忆，
      // 修订轮对失败过的段在剩余额度内重试高德（时序前移后修订轮多次 computeLegs）
      const estimatePair = async (
        from: { id: string; lat: number; lng: number },
        to: { id: string; lat: number; lng: number },
      ): Promise<TransitLeg> => {
        const memoKey = legMemoKey(from, to);
        const memoized = legMemo.get(memoKey);
        if (memoized) return memoized;
        const leg = await computePair(from, to);
        if (leg.source !== 'heuristic') legMemo.set(memoKey, leg);
        return leg;
      };

      const computePair = async (
        from: { id: string; lat: number; lng: number },
        to: { id: string; lat: number; lng: number },
      ): Promise<TransitLeg> => {
        // 模式由 effectiveLegMode 判定（按时长，非直线距离）：走不动就骑行，再远才上公交/驾车
        const mode: LegMode = effectiveLegMode(from, to, baseMode);
        // 熔断开启即整体跳过服务商分支（含城市标识兜底解析——省 geocode 额度与 10s 级等待），直接启发式
        if (provider.enabled && !routeBreaker.isOpen()) {
          // transit 需要起终点城市标识；活动级缺失时各自用目的地城市级兜底（不可互抄对端——
          // 跨区县时对端的区县 adcode 并非本端所属）。
          // 「是否真的可规划」交由熔断器的前置拦截判定（高德缺 adcode / 天地图缺城市名）：
          // 两家服务商缺的参数不同，判断权归适配器，这里不再抄一遍 gate。
          const city1 = mode === 'transit' ? adcodes.get(from.id) || (await resolveCityAdcode()) : '';
          const city2 = mode === 'transit' ? adcodes.get(to.id) || (await resolveCityAdcode()) : '';
          // 额度记账（tryRoute）由熔断器包装：熔断/缺参数拦截在扣额度之前，失败计数只数真实请求
          const route = await routeBreaker.estimate(from, to, mode, { city1, city2 }, tryRoute);
          if (route) {
            return {
              fromActivityId: from.id,
              toActivityId: to.id,
              mode,
              durationMin: route.durationMin,
              distanceM: route.distanceM,
              // 如实标注路由来源（高德单轨）
              source: 'amap',
              ...(route.polyline ? { polyline: route.polyline } : {}),
            };
          }
        }
        return { fromActivityId: from.id, toActivityId: to.id, mode, ...estimateLeg(from, to, mode) };
      };

      const hasCoord = (p: { lat: number; lng: number }) => !(p.lat === 0 && p.lng === 0);

      for (const day of days) {
        const legs: TransitLeg[] = [];
        for (let i = 0; i + 1 < day.activities.length; i++) {
          if (signal?.aborted) throw new Error('已取消');
          const from = day.activities[i]!;
          const to = day.activities[i + 1]!;
          done += 1;
          // 任一端无有效坐标：无法估算，跳过该段（消费方按缺失处理）
          if (!hasCoord(from) || !hasCoord(to)) continue;
          legs.push(await estimatePair(from, to));
          if (done % 4 === 0 || done === pairs) onProgress(`正在估算通勤时间 (${done}/${pairs})`);
        }
        // 住宿通勤不再生成（09-22 决策）：只算景点↔景点。住宿锚点只保留名称供展示，
        // 不进时间轴、也不进可行性引擎的通勤预算（否则每天凭空多两段远端通勤）。
        day.legs = legs;
      }
    },
  };
}
