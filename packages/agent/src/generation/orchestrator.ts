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
import { db } from '@tripweaver/core/db/client';
import { getTripWeather } from '@tripweaver/services/tripWeatherService';
import { finalizeGenerationTask } from './taskStore';
import { appendTaskCompletion } from '../tasks/completionMessage';
import { deliverTaskResult } from '../tasks/taskCompletion';
import type { DelegatedTaskResult } from '../tasks/delegatedTask';
import type { LlmConfig } from '@tripweaver/core/settingsService';
import { searchBudgetRemaining } from '@tripweaver/core/quotaService';
import { createTrip, getTrip } from '@tripweaver/services/tripService';
import { recordGenerationNotification, getGenerationResult } from '@tripweaver/services/notificationService';
import { publishNotification, type NotificationEvent } from '@tripweaver/services/notificationStream';
import { poiBudgetRemaining, resolvePoiSourceForUser } from '@tripweaver/integrations/geoProvider';
import { getNullPoiSource } from '@tripweaver/integrations/nullPoiSource';
import { POI_MAX_PER_TASK, createTaskPoiGate, createTaskPoiSource, type TaskPoiStats } from '@tripweaver/integrations/poiTaskSource';
import {
  SEARCH_MAX_PER_TASK,
  createTaskSearchSource,
  getNullSearchSource,
  resolveSearchSourceForUser,
} from '@tripweaver/integrations/websearch/searchSource';
import { DraftTrip } from './draft';
import { ensureMealCoverage, isFoodFocused } from './mealPlanning';
import { createGeoSession } from './geoPipeline';
import { enrichMealAnchors, MEAL_ENRICH_MAX_CALLS } from './mealEnrichment';
import { repairLongHaulMixedDays, verifiedFixNotes, type AppliedFixMove } from './longHaulFixer';
import { optimizeCrossDayGrouping, orderUntimedDayRoutes } from './routeCoherence';
import { buildModel } from './model';
import { emitLive, type LiveRun } from './liveRun';
import type { GenerationAgentKey, GenerationTaskRef } from './provenance';
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
import { createAmapPoiPhotoLookup } from '@tripweaver/integrations/amap/poiPhotos';
import { env } from '@tripweaver/core/env';

import { buildTitleTool } from './tools/titleTool';
import { retrieveContext } from './retrieveContext';
import { prepareResearchContext } from './researchContext';
import { prepareTripAdviceEvidence, runTripAdviceWriter } from './tripAdvice';
import { runPlannerAgent, plannerSeeds } from './planner/plannerAgent';
import { buildAreas } from './planner/tools';
import { searchAreaPois } from '@tripweaver/integrations/amap/placeArea';
import { ScheduleDateConflictError, scheduleClosureConflicts } from './closureConflict';
import { scheduleDays } from '@tripweaver/services/itinerary/schedule';
import { applyTrimRemovals, planOverpackedTrim } from './dayTrim';
import {
  WRITER_SYSTEM_PROMPT,
  writerUserPrompt,
} from './prompts';
import { cityCoverage, searchWebMaxFor } from '@tripweaver/services/cityCoverageService';

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
  /** 子 Agent 创建 durable conversation 后登记 id（供主时间线条目打开子页面）。 */
  onAgentConversation?: (key: GenerationAgentKey, conversationId: string) => Promise<void>;
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
  console.log(`[generation-task] 🚀 任务启动: jobId=${run.jobId}, 目的地=${form.destination}, 天数=${form.days}天, 交通=${form.transportMode ?? 'transit'}, 模型=${cfg.model}`);
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
    onThought: (text) => {
      console.log(`[generation-task] 💭 [${phase}] 思考: ${text.slice(0, 80).replace(/\n/g, ' ')}...`);
      emitLive(run, { type: 'thought', phase, text });
    },
    onToolStart: (toolCallId, tool, label, args) => {
      const at = timing.startTask(toolCallId, tool);
      console.log(`[generation-task] 🛠️ [${phase}] 工具开始: ${label} (${tool}) 参数: ${JSON.stringify(args ?? {}).slice(0, 100)}`);
      emitLive(run, { type: 'tool_start', phase, toolCallId, tool, label, args: JSON.stringify(args ?? {}).slice(0, 200), at });
    },
    onToolEnd: (toolCallId, tool, label, summary, isError) => {
      const ended = timing.endTask(toolCallId);
      console.log(`[generation-task] 🏁 [${phase}] 工具完成: ${label} (${tool}) -> ${summary} (${ended.durationMs ?? 0}ms)${isError ? ' ❌' : ' ✅'}`);
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
    onLlmResponse: (info) => {
      console.log(`[generation-task] 🤖 [${phase}] LLM 响应: turn=${info.turn}, stop=${info.stopReason ?? 'unknown'}, in=${info.usage?.input ?? 0}, out=${info.usage?.output ?? 0}${info.errorMessage ? ` [错误: ${info.errorMessage}]` : ''}`);
      emitLive(run, {
        type: 'llm_response',
        phase,
        turn: info.turn,
        stopReason: info.stopReason,
        tokensIn: info.usage?.input,
        tokensOut: info.usage?.output,
        errorMessage: info.errorMessage,
      });
    },
  });

  const startPhase = (phase: GenerationPhase, round: number, note?: string) => {
    const at = timing.startPhase(phase, round);
    console.log(`[generation-task] 📌 ====== 阶段开始: ${phase} (第 ${round} 轮) ${note ? `[${note}]` : ''} ======`);
    emitLive(run, { type: 'phase_start', phase, round, note, at });
  };
  const endPhase = (phase: GenerationPhase, round: number, summary?: string) => {
    const ended = timing.endPhase(phase, round);
    console.log(`[generation-task] 🎯 ====== 阶段结束: ${phase} (第 ${round} 轮) 耗时: ${ended.durationMs ?? 0}ms ${summary ? `[${summary}]` : ''} ======`);
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
      const trip = await getTrip(run.userId, committed.tripId).catch(() => null);
      if (trip) {
        await deliverTaskResult({
          userId: run.userId,
          conversationId: run.provenance.conversationId,
          result: {
            id: run.jobId,
            kind: 'trip_generation',
            status: 'completed',
            artifacts: { tripId: trip.id, title: trip.title, days: trip.days.length, destination: form.destination },
          },
          cfg,
          signal,
        });
      }
      await finalizeTask('done', committed.tripId);
      emitLive(run, { type: 'job_done', tripId: committed.tripId, usedXhs: false, dataSources: [], reviewNotes: [], at: Date.now(), durationMs: Date.now() - run.createdAt });
      terminalStatus = 'done';
      return { status: 'done', tripId: committed.tripId, reviewNotes: [], dataSources: [], warnings: [] };
    }

    assertAlive(signal);
    // 两条安全校验尽早并行，拒绝也立即被观察，避免初始化提前退出后的游离 rejection。
    const modelPromise = buildModel(cfg).then(
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
      return (opts) => runDurablePhaseAgent({
        host,
        phaseKey,
        modelRef,
        opts,
        onConversationCreated: (conversationId) => {
          if (options.onAgentConversation) {
            void options.onAgentConversation(phaseKey as GenerationAgentKey, conversationId).catch(() => {});
          }
        },
      });
    };
    const explorationRunner = phaseRunner('exploration');
    const routingRunner = phaseRunner('routing');
    const inspectionRunner = phaseRunner('inspection');

    // ---------- 阶段 1：采风灵感调研（可 checkpoint） ----------
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
      startPhase('exploration', 1, '复用上次调研结果');
      for (const poi of research.pool) emitLive(run, { type: 'candidate', poi });
      endPhase('exploration', 1, `候选 ${research.pool.length} 个｜复用上次调研`);
    } else {
      startPhase('exploration', 1, researchNote(enabledSources));
      emitLive(run, {
        type: 'highlight',
        stage: 'exploration',
        text: `采风灵感：翻阅 ${form.destination} 当季精华游玩路线与宝藏点位…`,
        kind: 'tip',
      });
      // R3（09-25）：未覆盖城市放宽 search_web 上限（2→6），SEARCH_DAILY_BUDGET 日预算闸门不受影响
      const searchWebMax = searchWebMaxFor(await cityCoverage(form.destination));
      const verifiedPlaces = await runSystemTask('exploration', 'prefetch_verified_places', '筛选行程地点', () =>
        prepareResearchContext(form, retrieveContext, signal));
      assertAlive(signal);
      // 封面来源接线（2026-11-05 收敛）：只用高德 POI 图片 —— search_pois 旁路 → 库内回写 → 实时查询。
      const storedPlaces = createStoredPlaceLookups(form.destination);
      let candidateHighlightCount = 0;
      const { research: outcome, result: researchRun } = await runResearchPhase({
        form, model, apiKey: cfg.apiKey, signal, verifiedPlaces, searchWebMax,
        runAgent: explorationRunner,
        poiSource: poi.source, searchSource: search.source,
        amapPhotos: createAmapPoiPhotoLookup(env.amapKey, env.amapPhotoMaxPerTask),
        storedAmapPhoto: storedPlaces.amapPhotoFor,
        saveAmapPhoto: (name, url) => {
          void saveAmapPhoto(form.destination, name, url).catch((error: unknown) =>
            console.warn(`[amap-photo] 回写失败（不影响生成）：${error instanceof Error ? error.message : String(error)}`));
        },
        onCandidate: (candidate) => {
          emitLive(run, { type: 'candidate', poi: candidate });
          if (candidateHighlightCount < 5 && candidate.category === 'attraction' && candidate.name) {
            candidateHighlightCount += 1;
            emitLive(run, {
              type: 'highlight',
              stage: 'exploration',
              text: `✨ 甄选灵感：${candidate.name}${candidate.intro ? ` · ${candidate.intro.slice(0, 32)}` : ''}`,
              kind: 'poi',
            });
          }
        },
        sink: sinkFor('exploration'),
        recorder: createLlmRequestRecorder({ jobId: run.jobId, userId: run.userId, phase: 'exploration', round: 1 }),
      });
      usage.tokensIn += researchRun.tokensIn;
      usage.tokensOut += researchRun.tokensOut;
      if (researchRun.conversationId) {
        await options.onAgentConversation?.('exploration', researchRun.conversationId);
      }
      assertAlive(signal, researchRun.errorMessage);
      endPhase('exploration', 1, `候选 ${outcome.pool.length} 个｜${outcome.summary.slice(0, 160)}`);
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
    const resolveGeoAndSimulate = async (sink: PhaseEventSink): Promise<void> => {
      try {
        sink.onThought('正在解析坐标与通勤…');
        await runSystemTask('routing', 'geo_geocode_all', '解析活动坐标', () => geo.geocodeAll(draft, sink.onThought, signal));
        assertAlive(signal);
        await runSystemTask('routing', 'optimize_day_routes', '调整顺路顺序', async () => orderUntimedDayRoutes(draft, form.destination));
        if (isFoodFocused(form.preferences)) {
          await runSystemTask('routing', 'meal_repair', '补齐午晚餐', async () =>
            ensureMealCoverage(draft.mutableDays(), form.destination));
        }
        emitLive(run, {
          type: 'highlight',
          stage: 'routing',
          text: '🍲 正在就近甄选顺路特色美食…',
          kind: 'food',
        });
        const mealPoi = createTaskPoiSource(poiBase, { stats: poiStats, maxCalls: MEAL_ENRICH_MAX_CALLS }).source;
        await runSystemTask('routing', 'meal_enrich', '充实餐次推荐', () => enrichMealAnchors({
          draft, poi: mealPoi, destination: form.destination, startDate: form.startDate, signal,
          maxCalls: MEAL_ENRICH_MAX_CALLS,
          onProgress: sink.onThought,
        }));
        await runSystemTask('routing', 'geo_compute_legs', '估算通勤路线', () => geo.computeLegs(draft, sink.onThought, signal));
        assertAlive(signal);
      } catch (err) {
        if (signal.aborted) throw err;
      }
      await runSystemTask('routing', 'simulate_feasibility', '检查时空可行性', () => draft.feasibility());
    };

    // ---------- 阶段 2：点位画像与口碑避坑 ----------
    startPhase('profiling', 1, '甄选避坑');
    emitLive(run, {
      type: 'highlight',
      stage: 'profiling',
      text: '💡 正在核实真实口碑与排队避坑…',
      kind: 'tip',
    });
    let seeds = plannerSeeds({
      candidates: research.pool,
      pointOf: (name, id) => {
        const located = (id ? research.locations.get(id) : undefined) ?? research.locations.get(name);
        if (located) return { lat: located.lat, lng: located.lng };
        const facts = placeFacts.get(name.trim());
        return facts?.lat !== undefined && facts.lng !== undefined ? { lat: facts.lat, lng: facts.lng } : undefined;
      },
    });
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
    let areas = buildAreas(seeds);
    if (!areas.length) {
      const center = await geo.resolvePlace(form.destination).catch(() => null);
      if (!center) {
        throw new GenerationFailure(`无法定位目的地「${form.destination}」，暂时不能规划；请检查地图服务后重试`);
      }
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
    endPhase('profiling', 1, `构建片区 ${areas.length} 个｜种子地点 ${seeds.length} 个`);

    // ---------- 阶段 3：天候与开放日历感知 ----------
    startPhase('climate', 1, '天候日历');
    emitLive(run, {
      type: 'highlight',
      stage: 'climate',
      text: '☀️ 正在校准出行天气与开闭馆…',
      kind: 'tip',
    });
    endPhase('climate', 1, '天候日历已就绪');

    // ---------- 阶段 4：慢游顺路排程与地道美食 ----------
    startPhase('routing', 1, '顺路排程');
    const poiAreaGate = createTaskPoiGate(poiStats);
    const planner = await runSystemTask('routing', 'agent_plan', '规划每日顺路行程', () => runPlannerAgent({
      model,
      apiKey: cfg.apiKey,
      signal,
      sink: sinkFor('routing'),
      form,
      draft,
      areas,
      runAgent: routingRunner,
      searchArea: async (query, plannerSignal) => {
        if (!env.amapKey) return [];
        return poiAreaGate(() => searchAreaPois(env.amapKey, { city: form.destination, ...query }, plannerSignal));
      },
      webSearch: async (query, plannerSignal, options) => {
        const hits = await search.source.search(query, plannerSignal, options);
        return hits.map((hit) => ({ title: hit.title, url: hit.url, summary: hit.summary }));
      },
      recorder: createLlmRequestRecorder({ jobId: run.jobId, userId: run.userId, phase: 'routing', round: 2 }),
      onDayPlanned: (day) => {
        emitLive(run, { type: 'plan_day', ...day });
        const topStops = day.stops.map((s) => s.name).slice(0, 3).join(' ⭢ ');
        emitLive(run, {
          type: 'highlight',
          stage: 'routing',
          text: `🗺️ 第 ${day.dayIndex} 天动线已串联：${topStops}，顺路不绕远`,
          kind: 'route',
        });
      },
    }));
    usage.tokensIn += planner.result.tokensIn;
    usage.tokensOut += planner.result.tokensOut;
    if (planner.result.conversationId) {
      await options.onAgentConversation?.('routing', planner.result.conversationId);
    }
    assertAlive(signal, planner.result.errorMessage);
    if (!planner.submitted) {
      throw new GenerationFailure(`规划未完成（候选 ${research.pool.length} 个）：${planner.result.errorMessage ?? '模型未调用 submit_plan'}。请重试`);
    }

    // 地理解析与真实通勤计算（顺路重排 + 补餐）
    await resolveGeoAndSimulate(sinkFor('routing'));
    endPhase(
      'routing',
      1,
      `活动 ${draft.mutableDays().reduce((sum, day) => sum + day.activities.length, 0)} 个｜候选 ${research.pool.length} 个｜顺路排程完成`,
    );

    // ---------- 阶段 5：资深规划师自省审查 ----------
    startPhase('inspection', 1, '自检推演');
    emitLive(run, {
      type: 'highlight',
      stage: 'inspection',
      text: '🔍 规划师正在全盘推演节奏舒缓不赶路…',
      kind: 'tip',
    });
    const review: { submitted: boolean; notes: string[] } = { submitted: false, notes: [] };
    const writerOpts = {
      model,
      apiKey: cfg.apiKey,
      systemPrompt: WRITER_SYSTEM_PROMPT,
      tools: [buildTitleTool(draft, (notes) => { review.submitted = true; review.notes = notes; })],
      userPrompt: writerUserPrompt(form, draft.render()),
      signal,
      sink: sinkFor('inspection'),
      maxTurns: 3,
      recorder: createLlmRequestRecorder({ jobId: run.jobId, userId: run.userId, phase: 'inspection', round: 1 }),
    };
    const writerPromise = runDurablePhaseAgent({
      host: options.agent,
      phaseKey: 'inspection',
      modelRef: agentModelRef(cfg.model),
      opts: writerOpts,
      onConversationCreated: (conversationId) => {
        if (options.onAgentConversation) {
          void options.onAgentConversation('inspection', conversationId).catch(() => {});
        }
      },
    }).catch((err: unknown) => {
      console.warn(`[writer] 文案阶段异常：${err instanceof Error ? err.message : String(err)}`);
      return {
        tokensIn: 0,
        tokensOut: 0,
        aborted: signal.aborted,
        turnLimitExceeded: false,
        errorMessage: err instanceof Error ? err.message : String(err),
        conversationId: undefined,
      };
    });

    try {
      const inspectSink = sinkFor('inspection');
      const fix = await runSystemTask('inspection', 'repair_long_haul', '优化远郊行程', () =>
        repairLongHaulMixedDays(draft, {
          mode: form.transportMode ?? 'transit',
          recomputeLegs: (dayIndexes) => geo.computeLegs(draft, inspectSink.onThought, signal, dayIndexes),
          onProgress: inspectSink.onThought,
          signal,
        }),
      );
      if (fix.applied.length > 0) {
        autoFixMoves.push(...fix.applied);
      }
    } catch (err) {
      if (signal.aborted) throw err;
    }

    // 文案收口（并行段结束）：启动时已记 startPhase，此处只等结果
    const writerRun = await writerPromise;
    usage.tokensIn += writerRun.tokensIn;
    usage.tokensOut += writerRun.tokensOut;
    if (writerRun.conversationId) {
      await options.onAgentConversation?.('inspection', writerRun.conversationId);
    }
    if (writerRun.errorMessage) {
      console.warn(`[writer] 文案阶段失败，按已有内容落库：${writerRun.errorMessage.slice(0, 200)}`);
      reviewNotes = ['文案生成未完成，活动说明沿用候选简介。'].slice(0, 5);
    } else {
      assertAlive(signal);
      reviewNotes = writerRun.turnLimitExceeded
        ? [...review.notes, '文案模型达到单阶段轮次上限，系统按已写内容落库。'].slice(0, 5)
        : review.notes;
    }

    const finalSink = sinkFor('inspection');

    // 落库前全量重算一次（文案阶段不动结构，但远郊修复器已换过天）：geoSession memo
    // 会复用未变化的高德路径，只有新相邻对才消耗路由额度。异常时清空 legs，宁缺勿持久化假路线。
    try {
      await runSystemTask('inspection', 'geo_geocode_review_changes', '解析改动地点坐标', () =>
        geo.geocodeAll(draft, finalSink.onThought, signal, true),
      );
      assertAlive(signal);
      await runSystemTask('inspection', 'geo_recompute_final_legs', '复核最终通勤路线', () =>
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
      const grouping = await runSystemTask('inspection', 'optimize_cross_day_grouping', '优化跨天路线', () =>
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

    // 换天与餐次补齐后的最终邻接关系再校验：对已有初排时刻的天进行顺路拓扑重排（餐次固定，重排顺路景点）。
    const reorderedDays = orderUntimedDayRoutes(draft, form.destination, { forceReorderTimed: true });
    if (reorderedDays.length) {
      try {
        await runSystemTask('inspection', 'route_recompute_ordered_days', '复核顺路通勤', () =>
          geo.computeLegs(draft, finalSink.onThought, signal, reorderedDays));
      } catch (err) {
        if (signal.aborted) throw err;
        for (const dayIndex of reorderedDays) delete draft.mutableDays()[dayIndex - 1]!.legs;
      }
    }

    // 按最终 legs 顺延每个活动的到达/离开时刻：规划 Agent 预览用的是启发式时长，
    // 真实路线重算后必须再校准一次，否则会出现「17 分钟间隔走 26 分钟路程」的可行性冲突。
    runSystemTask('inspection', 'retime_days', '按真实通勤校准时刻', () => scheduleDays(draft.mutableDays(), form.pace ?? 'moderate'));

    // 真实 legs + 餐次可能把个别天推到 14h 以上：落库前确定性移除超载日最长的非首站景点，
    // 只重算受影响天的 legs，再校准一次时刻。保证最终产物可执行，而不是把硬冲突留到详情页。
    const trim = planOverpackedTrim(draft.mutableDays());
    if (trim.removals.length) {
      const touched = applyTrimRemovals(draft.mutableDays(), trim.removals);
      try {
        await runSystemTask('inspection', 'trim_overpacked_days', '精简超载日安排', () =>
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
      const evidence = await runSystemTask('inspection', 'prepare_trip_advice', '整理行程相关资料', () =>
        prepareTripAdviceEvidence(completedDraft, retrieveContext, signal));
      assertAlive(signal);
      const adviceRun = await runTripAdviceWriter(completedDraft, evidence, {
        model, apiKey: cfg.apiKey, signal, sink: finalSink,
        recorder: createLlmRequestRecorder({ jobId: run.jobId, userId: run.userId, phase: 'inspection', round: 2 }),
      }, inspectionRunner);
      usage.tokensIn += adviceRun.result.tokensIn;
      usage.tokensOut += adviceRun.result.tokensOut;
      if (adviceRun.result.conversationId) {
        await options.onAgentConversation?.('inspection', adviceRun.result.conversationId);
      }
      assertAlive(signal);
      if (adviceRun.advice) completedDraft.meta.advice = adviceRun.advice;
    } catch (err) {
      if (signal.aborted) throw err;
      logger?.info({ jobId: run.jobId, errorType: err instanceof Error ? err.name : 'unknown' }, 'trip advice writing degraded');
    }
    endPhase('inspection', 1, completedDraft.meta.advice ? '旅行建议与注意事项已撰写' : '专属建议暂未生成，保留基础提醒');
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
      // 任务行在“主 Agent 完成回合”之后再收口，保证任务卡变完成时会话里已有最终回答。
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
    // 子 Agent 结果作为任务通知交回主 Agent 生成最终回答，再落任务终态；失败时内部退回固定完成消息。
    await deliverTaskResult({
      userId: run.userId,
      conversationId: run.provenance.conversationId,
      result: {
        id: run.jobId,
        kind: 'trip_generation',
        status: 'completed',
        ...(research.summary ? { summary: research.summary } : {}),
        notes: reviewNotes,
        artifacts: { tripId: trip.id, title: trip.title, days: trip.days.length, destination: form.destination },
      } satisfies DelegatedTaskResult,
      cfg,
      signal,
    });
    await finalizeTask('done', trip.id, { summary: research.summary, reviewNotes, dataSources });
    emitLive(run, { type: 'job_done', tripId: trip.id, usedXhs: false, dataSources, reviewNotes, at: Date.now(), durationMs: Date.now() - run.createdAt });
    console.log(`[generation-task] 🎉 任务完成: jobId=${run.jobId}, tripId=${trip.id}, 总耗时=${Date.now() - run.createdAt}ms`);
    publishNotification(run.userId, doneNotification!);
    terminalStatus = 'done';
    return { status: 'done', tripId: trip.id, summary: research.summary, reviewNotes, dataSources, warnings: runWarnings };
  } catch (err) {
    let failureMessage: string | undefined;
    if (signal.aborted) {
      emitLive(run, { type: 'job_cancelled', reason: run.cancelReason });
      terminalStatus = 'cancelled';
      console.log(`[generation-task] ⏹️ 任务已取消: jobId=${run.jobId}, reason=${run.cancelReason}`);
    } else {
      failureMessage = err instanceof GenerationFailure || err instanceof ScheduleDateConflictError ? err.message : '生成失败，请稍后重试';
      emitLive(run, { type: 'job_error', message: failureMessage });
      terminalStatus = 'error';
      console.error(`[generation-task] ❌ 任务异常: jobId=${run.jobId}, message=${failureMessage}`, err);
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
      await appendTaskCompletion({
        userId: run.userId,
        conversationId: run.provenance.conversationId,
        result: {
          id: run.jobId,
          kind: 'trip_generation',
          status: 'failed',
          error: failureMessage,
          artifacts: { destination: form.destination, days: form.days },
        },
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
