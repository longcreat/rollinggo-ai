// 生成主流程：调研 Agent → 规划 Agent → 地理校准、标题与专属建议 → 原子落库。
// 唯一入口 runGeneration —— 路由只见任务号与 SSE，Agent 细节全部封装在此（架构 §2 单入口隔离）
//
// ┌─ 阅读顺序（建议从这里开始）────────────────────────────────┐
// │ 1. 先看 runGeneration 里 try 块的主干，按「阶段 N」注释往下走，          │
// │    走完一遍就是一次完整生成的全过程。                                     │
// │ 2. 三个辅助设施先扫一眼，后面到处在用：                                   │
// │      sinkFor()       把 Agent 内部事件翻译成 SSE 事件，推给前端时间线      │
// │      runSystemTask() 把「非 Agent 的校准步骤」（地理/补餐/远郊修复）也包装 │
// │                      成时间线上的一次工具调用，前端看起来和 Agent 工具一样 │
// │      assertAlive()   每个 await 之后的取消/超时检查点                     │
// │ 3. 三个阶段（11-06 起，范式 = 模型决策 + 代码校准）：                      │
// │      阶段 1 调研     = 调研 Agent 选点写简介（submit_research 提交协议）   │
// │      阶段 2 规划     = 规划 Agent 片区选点/分天/排序/时刻                  │
// │                       （planner/ 六工具，submit_plan 提交协议；            │
// │                        每天 plan_day 经 SSE 直播到前端）                  │
// │      阶段 3 文案/建议 = 有 LLM 但不改结构，只填文字                        │
// │   Agent 之后是确定性校准层（geocode→补餐→真实 legs→远郊修复→跨天优化      │
// │   →scheduleDays→闭馆硬检），旧 schedule.ts 排程引擎已退出生成主链。   │
// │ 4. 三条贯穿全文的原则，看到 catch 先想这个：                              │
// │      · 增强路径失败不改写任务成败（地理/文案/远郊修复，降级继续）           │
// │      · 核心路径失败必须终止（规划未提交/闭馆无解就没有行程，不能降级）       │
// │      · 取消/超时永远向外抛，不能被 catch 吞掉                              │
// └──────────────────────────────────────────────────────────────────────┘
//
// 几个反复出现的术语：
//   层3 兜底修复 = 排程后如果仍出现「远郊日混排」，代码级把市区活动挪到别的天（repairLongHaulMixedDays）
//   hard / soft 违规 = feasibility() 的两档结果；hard 是「排了但物理上做不到」（如闭馆日去了）
//   旁路坐标 = 调研 Agent 调检索工具时顺带捕获的坐标，优先于知识库坐标
import {
  feasibilityReviewNotes,
  GENERATION_TIMEOUT_MINUTES,
  type DataSourceKind,
  type GenerateForm,
  type GenerationJobStatus,
  type GenerationPhase,
  type GenerationWarning,
} from '@tripweaver/shared';
import type { FastifyBaseLogger } from 'fastify';
import { db } from '../db/client';
import { getTripWeather } from '../services/tripWeatherService';
import { finalizeGenerationTask } from './taskStore';
import { appendGenerationCompletion } from './completionMessage';
import type { LlmConfig } from '../services/settingsService';
import { searchBudgetRemaining } from '../services/quotaService';
import { createTrip } from '../services/tripService';
import { recordGenerationNotification, getGenerationResult } from '../services/notificationService';
import { publishNotification, type NotificationEvent } from '../services/notificationStream';
import { poiBudgetRemaining, resolvePoiSourceForUser } from '../integrations/geoProvider';
import { getNullPoiSource } from '../integrations/nullPoiSource';
import { POI_MAX_PER_TASK, createTaskPoiGate, createTaskPoiSource, type TaskPoiStats } from '../integrations/poiTaskSource';
import {
  SEARCH_MAX_PER_TASK,
  createTaskSearchSource,
  getNullSearchSource,
  resolveSearchSourceForUser,
} from '../integrations/websearch/searchSource';
import { DraftTrip } from './draft';
import { ensureMealCoverage, isFoodFocused } from './mealPlanning';
import { createGeoSession } from './geoPipeline';
import { enrichMealAnchors, MEAL_ENRICH_MAX_CALLS } from './mealEnrichment';
import { repairLongHaulMixedDays, verifiedFixNotes, type AppliedFixMove } from './longHaulFixer';
import { optimizeCrossDayGrouping, orderUntimedDayRoutes } from './routeCoherence';
import { buildModel } from './model';
import { emitLive, type LiveRun } from './liveRun';
import type { GenerationTaskRef } from './provenance';
import type { PhaseAgentRunner, PhaseEventSink } from './agents/phase';
import { runDurablePhaseAgent, type DurablePhaseHost } from './agents/durablePhase';
import { agentModelRef } from '../chat/agent/models';
import { GenerationPerformance } from './performance';
import { createLlmRequestRecorder } from './llmRequestLog';
import { runResearchPhase } from './researchPhase';
import { loadPlaceFacts, saveAmapPhoto } from './scheduling/placeFacts';
import { createStoredPlaceLookups } from './storedPlaceLookups';
import { serializeResearch, type ResearchCheckpoint } from './checkpoint';
import type { ResearchOutcome } from './tools/researchTools';
import type { PlaceFacts } from './scheduling/placeFacts';
import { createAmapPoiPhotoLookup } from '../integrations/amap/poiPhotos';
import { env } from '../env';

import { buildTitleTool } from './tools/titleTool';
import { retrieveContext } from './retrieveContext';
import { prepareResearchContext } from './researchContext';
import { prepareTripAdviceEvidence, runTripAdviceWriter } from './tripAdvice';
import { runPlannerAgent, plannerSeeds } from './planner/plannerAgent';
import { buildAreas } from './planner/tools';
import { searchAreaPois } from '../integrations/amap/placeArea';
import { ScheduleDateConflictError, scheduleClosureConflicts } from './closureConflict';
import { scheduleDays } from '../itinerary/schedule';
import { applyTrimRemovals, planOverpackedTrim } from './dayTrim';
import {
  WRITER_SYSTEM_PROMPT,
  writerUserPrompt,
} from './prompts';
import { cityCoverage, searchWebMaxFor } from '../services/cityCoverageService';

const JOB_TIMEOUT_MS = GENERATION_TIMEOUT_MINUTES * 60 * 1000;   // 整任务兜底超时（与前端提示文案同源）

class GenerationFailure extends Error {}

/** 调研阶段降级说明：数据源缺失/超额不阻断生成，仅在时间线上明示 */
function researchNote(sources: DataSourceKind[]): string | undefined {
  if (sources.length === 2) return undefined;
  const only = sources[0];
  if (only === undefined) return '地点数据源与全网搜索均不可用，本次基于模型知识调研';
  return only === 'websearch'
    ? '地点数据源不可用，本次基于全网搜索 + 模型知识调研'
    : `全网搜索不可用，本次基于高德地点数据 + 模型知识调研`;
}

export interface GenerationRunOptions {
  /** 上次运行保存的调研 checkpoint：有则跳过 LLM 调研，直接复用候选池与知识库事实。 */
  resume?: ResearchCheckpoint;
  /** 调研完成后保存 checkpoint（durable task 用它落 task state）。 */
  onCheckpoint?: (checkpoint: ResearchCheckpoint) => Promise<void>;
  /** durable 宿主：所有 LLM 阶段都在 pi-durable 会话上执行（唯一路径）。 */
  agent: DurablePhaseHost;
}

/** 生成结束时可回传给主 Agent / 任务视图的摘要（不改变行程本身）。 */
export interface GenerationRunSummary {
  status: GenerationJobStatus;
  tripId: string | null;
  summary?: string;
  reviewNotes: string[];
  dataSources: DataSourceKind[];
  warnings: GenerationWarning[];
  message?: string;
}

export async function runGeneration(
  run: LiveRun,
  form: GenerateForm,
  cfg: LlmConfig,
  logger: Pick<FastifyBaseLogger, 'info' | 'error'> | undefined,
  options: GenerationRunOptions,
): Promise<GenerationRunSummary> {
  const signal = run.abort.signal;
  const taskRef: GenerationTaskRef = run.ref;
  const usage = { tokensIn: 0, tokensOut: 0 };
  // 餐次/餐宿要求的开关（09-21 D3/D6）：只在偏好含「美食」时强制午晚餐与餐次兜底
  const timing = new GenerationPerformance(run.createdAt);
  let terminalStatus: GenerationJobStatus = 'error';
  /** 最终可行性检查的结构化告警：随任务结果持久化，供任务卡与主 Agent 展示。 */
  let runWarnings: GenerationWarning[] = [];
  /** 成功通知的推送事件：事务提交后再发，避免前端回查到未提交的行 */
  let doneNotification: NotificationEvent | undefined;
  let systemTaskSeq = 0;
  const timeout = setTimeout(() => {
    if (signal.aborted) return;
    run.cancelReason = 'timeout';   // 超时自动取消：事件携带 reason，前端区分展示
    run.abort.abort();
  }, JOB_TIMEOUT_MS);
  timeout.unref?.();

  // 先建立零调用统计，让初始化失败也能发布终态、记账和清理计时器。
  // POI 记账共用一份统计（amapCalls / dataSources），但调研、片区检索、补餐的额度各自独立计数。
  const poiStats: TaskPoiStats = { calls: 0, gotResults: false };
  let poi = createTaskPoiSource(getNullPoiSource(), { stats: poiStats });
  let search = createTaskSearchSource(getNullSearchSource());
  // 地理会话（v0.5）：geocode/route 统一服务商与凭据解析、任务上限与日额度记账；出行方式基调来自表单（ST3）
  const geo = createGeoSession(run.userId, form.destination, form.transportMode ?? 'transit');
  // 图片采集由独立后台任务处理，不计入本次生成的地理调用统计。
  // 地理调用按链分流计入各自用量列：POI 搜索固定天地图，路线 + 地理编码走另一条（高德优先）。
  // 两条链各自独立计数，不再靠单一开关二选一（高德缺 Key 时地理链自己降级到天地图，也要如实记到天地图列）。
  // 返回值必须现算 —— poi/geo 的统计在生成过程中持续增长。
  const providerCallCounts = () => {
    const geoCalls = geo.stats.calls;

    return {
      amapCalls: geoCalls + poi.stats.calls,
    };
  };

  // sinkFor 产出的 sink 被三层复用：调研 Agent、文案 Agent、以及各处 runSystemTask。
  // 它只做一件事：把 Agent 内部回调 → SSE 事件。前端时间线看到的「思考中」「调用了某工具」
  // 「工具返回了什么」全部来自这里，所以每个 emit 的字段要和前端 GenerationRunPanel 对得上。
  const sinkFor = (phase: GenerationPhase): PhaseEventSink => ({
    onThought: (text) => emitLive(run, { type: 'thought', phase, text }),
    onToolStart: (toolCallId, tool, label, args) => {
      const at = timing.startTask(toolCallId, tool);
      emitLive(run, { type: 'tool_start', phase, toolCallId, tool, label, args: JSON.stringify(args ?? {}).slice(0, 200), at });
    },
    onToolEnd: (toolCallId, tool, label, summary, isError) => {
      const ended = timing.endTask(toolCallId);
      emitLive(run, { type: 'tool_end', phase, toolCallId, tool, label, summary, isError, ...ended });
    },
    onUsage: (tokensIn, tokensOut) =>
      emitLive(run, {
        type: 'usage',
        tokensIn: usage.tokensIn + tokensIn,
        tokensOut: usage.tokensOut + tokensOut,
        xhsCalls: 0,   // 旧前端兼容字段（小红书已移除）
        ...providerCallCounts(),
        searchCalls: search.stats.calls,
      }),
    // LLM 请求上下文由 recorder 落库（llm_request_logs）供排查，不再经 SSE 推完整 prompt 到浏览器；
    // 只推轻量结果，评测链路依赖它记录 turn / stopReason / httpStatus。
    onLlmResponse: (info) =>
      emitLive(run, {
        type: 'llm_response',
        phase,
        turn: info.turn,
        stopReason: info.stopReason,
        tokensIn: info.usage?.input,
        tokensOut: info.usage?.output,
        errorMessage: info.errorMessage,
      }),
  });

  const startPhase = (phase: GenerationPhase, round: number, note?: string) => {
    const at = timing.startPhase(phase, round);
    emitLive(run, { type: 'phase_start', phase, round, note, at });
  };
  const endPhase = (phase: GenerationPhase, round: number, summary?: string) => {
    const ended = timing.endPhase(phase, round);
    emitLive(run, { type: 'phase_end', phase, round, summary, ...ended });
  };
  const runSystemTask = async <T>(
    phase: GenerationPhase,
    tool: string,
    label: string,
    action: () => Promise<T> | T,
    summary = '完成',
  ): Promise<T> => {
    const toolCallId = `system:${++systemTaskSeq}:${tool}`;
    const at = timing.startTask(toolCallId, tool);
    emitLive(run, { type: 'tool_start', phase, toolCallId, tool, label, args: '{}', at });
    try {
      const result = await action();
      const ended = timing.endTask(toolCallId);
      emitLive(run, { type: 'tool_end', phase, toolCallId, tool, label, summary, isError: false, ...ended });
      return result;
    } catch (error) {
      const ended = timing.endTask(toolCallId);
      emitLive(run, { type: 'tool_end', phase, toolCallId, tool, label, summary: '已降级', isError: true, ...ended });
      throw error;
    }
  };

  /** 任务行终态：原地更新 running 行，摘要/告警/用量一次写入。 */
  const finalizeTask = async (
    status: 'done' | 'error' | 'cancelled',
    tripId: string | null,
    details: { summary?: string; reviewNotes?: string[]; dataSources?: DataSourceKind[]; error?: string } = {},
    writer: Pick<typeof db, 'insert'> = db,
  ) => {
    await finalizeGenerationTask(taskRef, status, tripId, {
      ...details,
      destination: form.destination,
      days: form.days,
      warnings: runWarnings,
      usage: {
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        ...providerCallCounts(),
        searchCalls: search.stats.calls,
      },
      usedByok: cfg.byok,
    }, writer);
  };

  try {
    // 幂等：提交与「成功通知」在同一事务里落库（(userId, jobId) 唯一）。
    // 若进程在提交后、durable 记录终态前崩溃，重跑时这里直接复用已提交结果，绝不生成第二个版本。
    const committed = await getGenerationResult(run.userId, run.jobId);
    if (committed?.status === 'done' && committed.tripId) {
      await finalizeTask('done', committed.tripId);
      emitLive(run, { type: 'job_done', tripId: committed.tripId, usedXhs: false, dataSources: [], reviewNotes: [], at: Date.now(), durationMs: Date.now() - run.createdAt });
      terminalStatus = 'done';
      return { status: 'done', tripId: committed.tripId, reviewNotes: [], dataSources: [], warnings: [] };
    }

    assertAlive(signal);
    // 两条安全校验尽早并行，拒绝也立即被观察，避免初始化提前退出后的游离 rejection。
    const modelPromise = buildModel(cfg, { disableDeepSeekThinking: true }).then(
      (model) => ({ ok: true as const, model }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const poiSource = await resolvePoiSourceForUser(run.userId);
    const poiBase = (await poiBudgetRemaining()) >= POI_MAX_PER_TASK ? poiSource.source : getNullPoiSource();
    assertAlive(signal);
    poi = createTaskPoiSource(poiBase, { stats: poiStats });
    const searchBase = (await searchBudgetRemaining()) >= SEARCH_MAX_PER_TASK
      ? (await resolveSearchSourceForUser(run.userId)).source
      : getNullSearchSource();
    assertAlive(signal);
    search = createTaskSearchSource(searchBase);
    await geo.init();
    assertAlive(signal);
    const enabledSources: DataSourceKind[] = [
      ...(poi.source.kind === 'null' ? [] : ([poi.source.kind] as const)),
      ...(search.source.kind === 'websearch' ? (['websearch'] as const) : []),
    ];
    // xhsEnabled 为旧前端兼容字段，现语义 =「有任一外部调研数据源可用」
    emitLive(run, {
      type: 'job_start',
      destination: form.destination,
      days: form.days,
      ...(form.startDate ? { startDate: form.startDate } : {}),
      xhsEnabled: enabledSources.length > 0,
      dataSources: enabledSources,
      at: run.createdAt,
    });
    const modelResult = await modelPromise;
    assertAlive(signal);
    if (!modelResult.ok) throw modelResult.error;
    const { model } = modelResult;   // BYOK：使用时二次 ssrfGuard，失败即 job_error

    // 阶段运行器：有 durable 宿主时把工具型阶段跑在 pi-durable 会话上（每阶段独立会话与扩展）。
    const phaseRunner = (phaseKey: string): PhaseAgentRunner => {
      const host = options.agent;
      const modelRef = agentModelRef(cfg.model);
      return (opts) => runDurablePhaseAgent({ host, phaseKey, modelRef, opts });
    };
    const researchRunner = phaseRunner('research');
    const planRunner = phaseRunner('plan');
    const adviceRunner = phaseRunner('advice');

    // ---------- 阶段 1：调研（可 checkpoint） ----------
    // 调研是最耗时的 LLM 阶段：完成后把候选池/坐标旁路/知识库事实存进 task checkpoint，
    // 进程崩溃重启后直接复用，跳过这一步。
    let research: ResearchOutcome;
    let placeFacts: Map<string, PlaceFacts>;
    if (options?.resume) {
      research = {
        summary: options.resume.summary,
        pool: options.resume.pool,
        locations: new Map(options.resume.locations),
      };
      placeFacts = new Map(options.resume.placeFacts);
      geo.useResearchPlaces(research.pool, research.locations);
      // 重建直播：job_start 已发出，补发候选与调研阶段边界。
      startPhase('research', 1, '复用上次调研结果');
      for (const poi of research.pool) emitLive(run, { type: 'candidate', poi });
      endPhase('research', 1, `候选 ${research.pool.length} 个｜复用上次调研`);
    } else {
      startPhase('research', 1, researchNote(enabledSources));
      // R3（09-25）：未覆盖城市放宽 search_web 上限（2→6），SEARCH_DAILY_BUDGET 日预算闸门不受影响
      const searchWebMax = searchWebMaxFor(await cityCoverage(form.destination));
      const verifiedPlaces = await runSystemTask('research', 'prefetch_verified_places', '筛选行程地点', () =>
        prepareResearchContext(form, retrieveContext, signal));
      assertAlive(signal);
      // 封面来源接线（2026-11-05 收敛）：只用高德 POI 图片 —— search_pois 旁路 → 库内回写 → 实时查询。
      const storedPlaces = createStoredPlaceLookups(form.destination);
      const { research: outcome, result: researchRun } = await runResearchPhase({
        form, model, apiKey: cfg.apiKey, signal, verifiedPlaces, searchWebMax,
        runAgent: researchRunner,
        poiSource: poi.source, searchSource: search.source,
        amapPhotos: createAmapPoiPhotoLookup(env.amapKey, env.amapPhotoMaxPerTask),
        storedAmapPhoto: storedPlaces.amapPhotoFor,
        saveAmapPhoto: (name, url) => {
          void saveAmapPhoto(form.destination, name, url).catch((error: unknown) =>
            console.warn(`[amap-photo] 回写失败（不影响生成）：${error instanceof Error ? error.message : String(error)}`));
        },
        onCandidate: (candidate) => emitLive(run, { type: 'candidate', poi: candidate }),
        sink: sinkFor('research'),
        recorder: createLlmRequestRecorder({ jobId: run.jobId, userId: run.userId, phase: 'research', round: 1 }),
      });
      usage.tokensIn += researchRun.tokensIn;
      usage.tokensOut += researchRun.tokensOut;
      assertAlive(signal, researchRun.errorMessage);
      endPhase('research', 1, `候选 ${outcome.pool.length} 个｜${outcome.summary.slice(0, 160)}`);
      geo.useResearchPlaces(outcome.pool, outcome.locations);
      research = outcome;
      // 知识库事实（坐标/开放时间/类目）：规划 Agent 的片区种子与后续修复共用同一份，不重复查询。
      placeFacts = await loadPlaceFacts(research.pool.map((poi) => poi.name), form.destination);
      await options?.onCheckpoint?.(serializeResearch({
        summary: research.summary,
        pool: research.pool,
        locations: research.locations,
        placeFacts,
        enabledSources,
      }));
    }

    // ---------- 规划 Agent，随后并发运行地理增强与标题文案 ----------
    const draft = new DraftTrip(form);
    let reviewNotes: string[] = [];
    // 记录修复器的实际挪动；后续跨天优化可能再次换天，落库前验证注记仍然成立。
    const autoFixMoves: AppliedFixMove[] = [];

    // 地理解析 + 可行性模拟：后处理属增强路径，意外异常只损失坐标补全/通勤段，不失败整个任务（取消除外）。
    // 每次串行外呼前 geoPipeline 内部已按 signal 逐项中止（07-12 教训：AbortSignal 须逐迭代检查）。
    const resolveGeoAndSimulate = async (sink: PhaseEventSink): Promise<void> => {
      try {
        sink.onThought('正在解析坐标与通勤…');
        await runSystemTask('plan', 'geo_geocode_all', '解析活动坐标', () => geo.geocodeAll(draft, sink.onThought, signal));
        assertAlive(signal);
        await runSystemTask('plan', 'optimize_day_routes', '调整顺路顺序', async () => orderUntimedDayRoutes(draft, form.destination));
        // 餐次补齐（2026-11-06）：规划 Agent 只选景点，美食导向的行程必然缺午晚餐。
        // 与 draft.validate 的判定同口径：只有偏好里显式选了「美食」才强制午晚餐，其余行程不硬塞。
        // 先用确定性规则补锚点（找准时间窗、避开冲突、落在当日片区），再由下面的 enrich 换成真实餐厅。
        if (isFoodFocused(form.preferences)) {
          await runSystemTask('plan', 'meal_repair', '补齐午晚餐', async () =>
            ensureMealCoverage(draft.mutableDays(), form.destination));
        }
        // 餐次充实（2026-11-06）：合成锚点 → 真实餐厅。必须在 geocode 之后（邻居坐标可用）、
        // computeLegs 之前（替换带入新坐标，腿按真实餐厅算）。查不到保留锚点，不影响生成。
        // 走独立额度的包装源但并入同一份记账：原先直传 poiBase 会漏计 amapCalls 并绕过任务级上限。
        const mealPoi = createTaskPoiSource(poiBase, { stats: poiStats, maxCalls: MEAL_ENRICH_MAX_CALLS }).source;
        await runSystemTask('plan', 'meal_enrich', '充实餐次推荐', () => enrichMealAnchors({
          draft, poi: mealPoi, destination: form.destination, startDate: form.startDate, signal,
          maxCalls: MEAL_ENRICH_MAX_CALLS,
          onProgress: sink.onThought,
        }));
        await runSystemTask('plan', 'geo_compute_legs', '估算通勤路线', () => geo.computeLegs(draft, sink.onThought, signal));
        assertAlive(signal);
      } catch (err) {
        if (signal.aborted) throw err;
      }
      await runSystemTask('plan', 'simulate_feasibility', '检查时空可行性', () => draft.feasibility());
    };

    // ---------- 阶段 2：规划 Agent 选点与分天 ----------
    // 选点/分天/排序/时刻统一由规划 Agent 决定；距离、通勤与时刻仍由工具计算（计划里不出现模型算出来的数）。
    startPhase('plan', 1, 'Agent 规划');
    let seeds = plannerSeeds({
      candidates: research.pool,
      pointOf: (name, id) => {
        const located = (id ? research.locations.get(id) : undefined) ?? research.locations.get(name);
        if (located) return { lat: located.lat, lng: located.lng };
        const facts = placeFacts.get(name.trim());
        return facts?.lat !== undefined && facts.lng !== undefined ? { lat: facts.lat, lng: facts.lng } : undefined;
      },
    });
    // 知识库无覆盖、POI 搜索又不通时，候选只来自模型知识（没有坐标）。
    // 用地理编码补齐前几个景点：geocode 与 place 是两本额度，能避免整个生成因地点检索额度耗尽而失败。
    if (!seeds.length) {
      const geocoded: typeof seeds = [];
      for (const poi of research.pool.filter((item) => item.category === 'attraction').slice(0, 8)) {
        assertAlive(signal);
        const point = await geo.resolvePlace(poi.name).catch(() => null);
        if (!point) continue;
        geocoded.push({
          name: poi.name, lat: point.lat, lng: point.lng, category: 'attraction',
          ...(poi.intro ? { intro: poi.intro } : {}),
          ...(poi.openTime ? { openTime: poi.openTime } : {}),
          ...(poi.canonicalPlaceId ? { canonicalPlaceId: poi.canonicalPlaceId } : {}),
        });
      }
      seeds = geocoded;
    }
    // 城市在知识库里没有任何点位（或调研候选全被改名）时，用城市中心兜底一个片区，
    // 让 Agent 仍能通过 search_area_places 展开真实 POI，而不是直接判失败。
    let areas = buildAreas(seeds);
    if (!areas.length) {
      const center = await geo.resolvePlace(form.destination).catch(() => null);
      if (!center) {
        throw new GenerationFailure(`无法定位目的地「${form.destination}」，暂时不能规划；请检查地图服务后重试`);
      }
      // 知识库无覆盖城市：先用一次片区检索确认额度并拿到真实点位，避免 Agent 空跑 30–90 秒后才失败。
      let nearby: Awaited<ReturnType<typeof searchAreaPois>> = [];
      if (env.amapKey) {
        try {
          nearby = await searchAreaPois(env.amapKey, { city: form.destination, center, radiusM: 12_000 }, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          const message = error instanceof Error ? error.message : '';
          if (/预算已用完|额度不足|budget/i.test(message)) {
            throw new GenerationFailure('高德地点检索额度已用完，无法获取真实点位；请明天再试，或联系站长调整 AMAP_SEARCH_MONTHLY_BUDGET');
          }
        }
      }
      const fallbackSeeds = nearby
        .filter((poi) => poi.location)
        .map((poi) => ({ name: poi.name, lat: poi.location!.lat, lng: poi.location!.lng, category: 'attraction' as const, ...(poi.opentime ? { openTime: poi.opentime } : {}) }));
      areas = buildAreas(fallbackSeeds.length ? fallbackSeeds : [{ name: form.destination, lat: center.lat, lng: center.lng, category: 'attraction' }], 12_000);
    }
    // 片区面状检索也计入 POI 记账与任务级上限（此前直连 searchAreaPois，两处都绕过）。
    const poiAreaGate = createTaskPoiGate(poiStats);
    const planner = await runSystemTask('plan', 'agent_plan', 'Agent 规划每日行程', () => runPlannerAgent({
      model,
      apiKey: cfg.apiKey,
      signal,
      sink: sinkFor('plan'),
      form,
      draft,
      areas,
      runAgent: planRunner,
      searchArea: async (query, plannerSignal) => {
        if (!env.amapKey) return [];
        return poiAreaGate(() => searchAreaPois(env.amapKey, { city: form.destination, ...query }, plannerSignal));
      },
      webSearch: async (query, plannerSignal) => {
        const hits = await search.source.search(query, plannerSignal);
        return hits.map((hit) => ({ title: hit.title, url: hit.url, summary: hit.summary }));
      },
      recorder: createLlmRequestRecorder({ jobId: run.jobId, userId: run.userId, phase: 'plan', round: 2 }),
      onDayPlanned: (day) => emitLive(run, { type: 'plan_day', ...day }),
    }));
    usage.tokensIn += planner.result.tokensIn;
    usage.tokensOut += planner.result.tokensOut;
    assertAlive(signal, planner.result.errorMessage);
    if (!planner.submitted) {
      throw new GenerationFailure(`规划未完成（候选 ${research.pool.length} 个）：${planner.result.errorMessage ?? '模型未调用 submit_plan'}。请重试`);
    }

    // ---------- 阶段 3：标题与专属建议；标题先与下面的地理/修复并发 ----------
    // 文案只写行程和每天标题，不修改活动；与地理增强并发缩短关键路径。
    // 沿用 review 阶段名（前端与时间线契约不变）；专属建议在最终路线稳定后追加撰写。
    // 活动说明不归它写：research 的候选 intro 已按同一标准写成并直接复用到活动上。
    // 工具面只给 update_titles，成功即结束；改不动活动/顺序/说明。
    // 文案属增强路径：模型没写完也不算失败，草稿里已有候选简介兜底。
    startPhase('review', 1, '撰写说明文案');
    // 文案阶段的收尾状态：update_titles 成功提交即结束（原 reviewTools 的 ReviewOutcome，内联为本地类型）
    const review: { submitted: boolean; notes: string[] } = { submitted: false, notes: [] };
    const writerOpts = {
      model,
      apiKey: cfg.apiKey,
      systemPrompt: WRITER_SYSTEM_PROMPT,
      tools: [buildTitleTool(draft, (notes) => { review.submitted = true; review.notes = notes; })],
      userPrompt: writerUserPrompt(form, draft.render()),
      signal,
      sink: sinkFor('review'),
      maxTurns: 3,
      recorder: createLlmRequestRecorder({ jobId: run.jobId, userId: run.userId, phase: 'review', round: 1 }),
    };
    // 所有 LLM 阶段都在 durable 会话上执行。
    const writerPromise = runDurablePhaseAgent({ host: options.agent, phaseKey: 'writer', modelRef: agentModelRef(cfg.model), opts: writerOpts }).catch((err: unknown) => {
      // 并行段若因取消/排程异常先抛出，这个 Promise 仍会 settle：必须立刻挂 catch，
      // 否则它的 rejection 无人接收（Node 视为 unhandledRejection）。
      console.warn(`[writer] 文案阶段异常：${err instanceof Error ? err.message : String(err)}`);
      return {
        tokensIn: 0,
        tokensOut: 0,
        aborted: signal.aborted,
        turnLimitExceeded: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    });

    // 修复器使用真实坐标与通勤段；地理循环内部按 signal 逐项检查取消。
    await resolveGeoAndSimulate(sinkFor('plan'));

    // 层3 兜底：确定性修复器 —— 排程层若仍产出「远郊日混排」且 feasibility 报出 hard 违规，
    // 代码级把混排市区活动挪到别的天并重验证（hard 严格递减才采纳，否则回滚）。
    // 所谓「远郊日混排」= 同一天既去了市区景点又去了 60km 外的郊区景点，通勤时间吃掉半天。
    // 「hard 严格递减才采纳」是防止修复器越修越差：只有违规数真的变少才保留改动。
    // 修复器属增强路径：任何异常按「未修复」继续走文案（生成不失败原则，取消除外）；
    // legs 重算复用 geoSession 定向重算（额度控制与 amap memo 内置）。
    try {
      const planSink = sinkFor('plan');
      const fix = await runSystemTask('plan', 'repair_long_haul', '优化远郊行程', () =>
        repairLongHaulMixedDays(draft, {
          mode: form.transportMode ?? 'transit',
          recomputeLegs: (dayIndexes) => geo.computeLegs(draft, planSink.onThought, signal, dayIndexes),
          onProgress: planSink.onThought,
          signal,
        }),
      );
      if (fix.applied.length > 0) {
        autoFixMoves.push(...fix.applied);
      }
    } catch (err) {
      if (signal.aborted) throw err;
    }
    endPhase(
      'plan',
      1,
      `活动 ${draft.mutableDays().reduce((sum, day) => sum + day.activities.length, 0)} 个｜候选 ${research.pool.length} 个｜Agent 规划`,
    );

    // 文案收口（并行段结束）：启动时已记 startPhase，此处只等结果
    const writerRun = await writerPromise;
    usage.tokensIn += writerRun.tokensIn;
    usage.tokensOut += writerRun.tokensOut;
    if (writerRun.errorMessage) {
      console.warn(`[writer] 文案阶段失败，按已有内容落库：${writerRun.errorMessage.slice(0, 200)}`);
      reviewNotes = ['文案生成未完成，活动说明沿用候选简介。'].slice(0, 5);
    } else {
      assertAlive(signal);
      reviewNotes = writerRun.turnLimitExceeded
        ? [...review.notes, '文案模型达到单阶段轮次上限，系统按已写内容落库。'].slice(0, 5)
        : review.notes;
    }

    const finalSink = sinkFor('review');

    // 落库前全量重算一次（文案阶段不动结构，但远郊修复器已换过天）：geoSession memo
    // 会复用未变化的高德路径，只有新相邻对才消耗路由额度。异常时清空 legs，宁缺勿持久化假路线。
    try {
      await runSystemTask('review', 'geo_geocode_review_changes', '解析改动地点坐标', () =>
        geo.geocodeAll(draft, finalSink.onThought, signal, true),
      );
      assertAlive(signal);
      await runSystemTask('review', 'geo_recompute_final_legs', '复核最终通勤路线', () =>
        geo.computeLegs(draft, finalSink.onThought, signal),
      );
      assertAlive(signal);
    } catch (err) {
      if (signal.aborted) throw err;
      for (const day of draft.mutableDays()) delete day.legs;
    }

    // 跨天地理聚类兜底：只尝试高收益的同类地点交换；真实 legs 重算后若通勤未明显下降或 hard 增加，
    // 修复器会完整回滚。正常失败不影响生成，取消仍向外传播。
    try {
      const grouping = await runSystemTask('review', 'optimize_cross_day_grouping', '优化跨天路线', () =>
        optimizeCrossDayGrouping(draft, {
          mode: form.transportMode ?? 'transit',
          recomputeLegs: (dayIndexes) => geo.computeLegs(draft, finalSink.onThought, signal, dayIndexes),
          onProgress: finalSink.onThought,
          signal,
        }),
      );
      if (grouping.notes.length) reviewNotes = [...grouping.notes, ...reviewNotes].slice(0, 8);
    } catch (err) {
      if (signal.aborted) throw err;
    }

    // 换天修复后的最终邻接关系再校验；只重算真正改变的天，不持久化旧顺序的 legs。
    const reorderedDays = orderUntimedDayRoutes(draft, form.destination);
    if (reorderedDays.length) {
      try {
        await runSystemTask('review', 'route_recompute_ordered_days', '复核顺路通勤', () =>
          geo.computeLegs(draft, finalSink.onThought, signal, reorderedDays));
      } catch (err) {
        if (signal.aborted) throw err;
        for (const dayIndex of reorderedDays) delete draft.mutableDays()[dayIndex - 1]!.legs;
      }
    }

    // 按最终 legs 顺延每个活动的到达/离开时刻：规划 Agent 预览用的是启发式时长，
    // 真实路线重算后必须再校准一次，否则会出现「17 分钟间隔走 26 分钟路程」的可行性冲突。
    runSystemTask('review', 'retime_days', '按真实通勤校准时刻', () => scheduleDays(draft.mutableDays(), form.pace ?? 'moderate'));

    // 真实 legs + 餐次可能把个别天推到 14h 以上：落库前确定性移除超载日最长的非首站景点，
    // 只重算受影响天的 legs，再校准一次时刻。保证最终产物可执行，而不是把硬冲突留到详情页。
    const trim = planOverpackedTrim(draft.mutableDays());
    if (trim.removals.length) {
      const touched = applyTrimRemovals(draft.mutableDays(), trim.removals);
      try {
        await runSystemTask('review', 'trim_overpacked_days', '精简超载日安排', () =>
          geo.computeLegs(draft, finalSink.onThought, signal, touched));
      } catch (err) {
        if (signal.aborted) throw err;
        for (const dayIndex of touched) delete draft.mutableDays()[dayIndex - 1]!.legs;
      }
      scheduleDays(draft.mutableDays(), form.pace ?? 'moderate');
      reviewNotes = [...trim.notes, ...reviewNotes].slice(0, 8);
      assertAlive(signal);
    }

    // 只保留最终草稿中仍成立的换天说明。
    const verifiedAutoNotes = verifiedFixNotes(draft, autoFixMoves);
    if (verifiedAutoNotes.length) {
      reviewNotes = [...new Set([...verifiedAutoNotes, ...reviewNotes])].slice(0, 8);
    }

    // 最终草稿重算可行性：hard/soft 违规均如实汇入说明，不再交给模型修订结构。
    const finalFeasibility = draft.feasibility();
    const finalClosures = scheduleClosureConflicts(draft.mutableDays().map((day) => day.activities), form.startDate);
    if (finalClosures.length) throw new ScheduleDateConflictError(finalClosures, 'post_processing');
    runWarnings = finalFeasibility.violations.map(({ severity, code, dayIndex, message }) => ({ severity, code, dayIndex, message }));
    const feasibilityNotes = feasibilityReviewNotes(finalFeasibility);
    if (feasibilityNotes.length) {
      reviewNotes = [...new Set([...reviewNotes, ...feasibilityNotes])].slice(0, 8);
    }

    // 落库前最后一道完整性检查：结构性问题（天数不符、空天）仍然失败；餐次与跨天重复
    // 已在后续阶段做确定性修复，残留只记录并写成说明，不再让用户等完整个流程后功亏一篑。
    const completeness = draft.validate();
    const structuralProblems = completeness.filter((problem) =>
      problem.startsWith('天数不符') || problem.includes('没有任何活动'));
    if (structuralProblems.length) {
      const shape = draft.mutableDays().map((day, index) => `第${index + 1}天${day.activities.length}个`).join('｜');
      throw new GenerationFailure(`规划结果不完整（${shape}，候选 ${research.pool.length} 个）：${structuralProblems.join('；')}。请重试`);
    }
    if (completeness.length) {
      logger?.info({ jobId: run.jobId, problems: completeness.slice(0, 6) }, 'plan completeness advisory');
      reviewNotes = [...new Set([...completeness.slice(0, 3), ...reviewNotes])].slice(0, 8);
    }

    // ---------- 落库 ----------
    // 实际用到的数据源（该源真拿到过结果才标注）；候选池随 Trip JSON 持久化。
    // POI 搜索自 09-25 起固定天地图，必须按真实 kind 落库（与上方 job_start 的 enabledSources 同口径）——
    // 写死 'amap' 会把天地图结果错标成高德，污染 PrintView 的来源标注（11-03 审查实测 bug）。
    const dataSources: DataSourceKind[] = [
      ...(poi.stats.gotResults && poi.source.kind !== 'null' ? [poi.source.kind] : []),
      ...(search.stats.gotResults ? (['websearch'] as const) : []),
    ];
    // 修订（PR5）：targetTripId 存在时把新行程挂到同一版本链的下一版；否则就是全新行程
    const revisionOf = run.provenance.kind === 'revision' ? run.provenance.targetTripId : undefined;
    const completedDraft = draft.toTrip(reviewNotes, { overview: research.pool, dataSources });
    // 第三阶段的专属建议使用最终结构，避免并行路线修复让建议中的天序失真。
    try {
      assertAlive(signal);
      const evidence = await runSystemTask('review', 'prepare_trip_advice', '整理行程相关资料', () =>
        prepareTripAdviceEvidence(completedDraft, retrieveContext, signal));
      assertAlive(signal);
      const adviceRun = await runTripAdviceWriter(completedDraft, evidence, {
        model, apiKey: cfg.apiKey, signal, sink: finalSink,
        recorder: createLlmRequestRecorder({ jobId: run.jobId, userId: run.userId, phase: 'review', round: 2 }),
      }, adviceRunner);
      usage.tokensIn += adviceRun.result.tokensIn;
      usage.tokensOut += adviceRun.result.tokensOut;
      assertAlive(signal);
      if (adviceRun.advice) completedDraft.meta.advice = adviceRun.advice;
    } catch (err) {
      if (signal.aborted) throw err;
      logger?.info({ jobId: run.jobId, errorType: err instanceof Error ? err.name : 'unknown' }, 'trip advice writing degraded');
    }
    endPhase('review', 1, completedDraft.meta.advice ? '旅行建议与注意事项已撰写' : '专属建议暂未生成，保留基础提醒');
    completedDraft.weather = await getTripWeather(completedDraft);
    assertAlive(signal);
    const trip = await db.transaction(async (tx) => {
      assertAlive(signal);
      const saved = await createTrip(
        run.userId,
        completedDraft,
        revisionOf,
        tx,
      );
      assertAlive(signal);
      await finalizeTask('done', saved.id, { summary: research.summary, reviewNotes, dataSources }, tx);
      // publish: false —— 事务未提交时推送会让前端回查到空列表；提交后再发
      doneNotification = await recordGenerationNotification({
        userId: run.userId, jobId: run.jobId, kind: 'success', tripId: saved.id,
        destination: form.destination, days: form.days, title: `${form.destination} ${form.days} 天行程已生成`,
        message: '路线与每日安排已准备好。', jobCreatedAt: new Date(run.createdAt),
      }, tx, { publish: false });
      assertAlive(signal);
      return saved;
    });
    // COMMIT 是成功边界：事务内取消会回滚；提交成功后不再把已保存结果宣告取消。
    // 先补对话完成消息再发终态：直播页跳转/刷新时，会话里已经能看到结果。
    await appendGenerationCompletion({
      userId: run.userId,
      jobId: run.jobId,
      conversationId: run.provenance.conversationId,
      status: 'done',
      tripId: trip.id,
      tripTitle: trip.title,
      days: trip.days.length,
    }).catch(() => {});
    emitLive(run, { type: 'job_done', tripId: trip.id, usedXhs: false, dataSources, reviewNotes, at: Date.now(), durationMs: Date.now() - run.createdAt });
    publishNotification(run.userId, doneNotification!);
    terminalStatus = 'done';
    return { status: 'done', tripId: trip.id, summary: research.summary, reviewNotes, dataSources, warnings: runWarnings };
  } catch (err) {
    let failureMessage: string | undefined;
    if (signal.aborted) {
      emitLive(run, { type: 'job_cancelled', reason: run.cancelReason });
      terminalStatus = 'cancelled';
    } else {
      failureMessage = err instanceof GenerationFailure || err instanceof ScheduleDateConflictError ? err.message : '生成失败，请稍后重试';
      emitLive(run, { type: 'job_error', message: failureMessage });
      terminalStatus = 'error';
      logger?.error({
        jobId: run.jobId,
        errorType: err instanceof Error ? err.name : 'unknown',
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }, 'generation failed');
    }
    // 失败/取消先发布权威终态。审计异常必须可观测，但不能再次困住任务锁。
    if (terminalStatus === 'error' || run.cancelReason === 'timeout') {
      try {
        await recordGenerationNotification({
          userId: run.userId, jobId: run.jobId, kind: 'error', tripId: null,
          destination: form.destination, days: form.days, title: `${form.destination}行程暂未生成成功`,
          message: run.cancelReason === 'timeout' ? '生成超时，本次不计入配额。可回首页重新规划。' : '本次不计入配额，可回首页检查后重试。',
          jobCreatedAt: new Date(run.createdAt),
        });
      } catch { logger?.error({ jobId: run.jobId }, 'generation notification write failed'); }
    }
    if (failureMessage) {
      await appendGenerationCompletion({
        userId: run.userId,
        jobId: run.jobId,
        conversationId: run.provenance.conversationId,
        status: 'error',
        destination: form.destination,
        days: form.days,
        message: failureMessage,
      }).catch(() => {});
    }
    try {
      await finalizeTask(terminalStatus as Exclude<GenerationJobStatus, 'running'>, null, failureMessage ? { error: failureMessage } : {});
    } catch {
      logger?.error({ jobId: run.jobId, status: terminalStatus }, 'generation audit write failed');
    }
    return {
      status: terminalStatus as Exclude<GenerationJobStatus, 'running'>,
      tripId: null,
      reviewNotes: [],
      dataSources: [],
      warnings: runWarnings,
      ...(failureMessage ? { message: failureMessage } : {}),
    };
  } finally {
    clearTimeout(timeout);
    logger?.info(
      {
        jobId: run.jobId,
        ...timing.summary(terminalStatus),
        usage: {
          tokensIn: usage.tokensIn,
          tokensOut: usage.tokensOut,
          ...providerCallCounts(),
          searchCalls: search.stats.calls,
        },
      },
      'generation timing summary',
    );
  }
}

/** 取消或 LLM 错误时立刻终止流水线 */
function assertAlive(signal: AbortSignal, errorMessage?: string): void {
  if (signal.aborted) throw new GenerationFailure('已取消');
  if (errorMessage) throw new GenerationFailure(`模型调用异常：${errorMessage}`);
}
