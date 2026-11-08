// 新建行程（P0 收口）：首页收集完条件后带 autostart=1 直达。本页不再直接开 job，
// 而是「建会话 → 写 Brief → 把首条消息交给主 Agent（POST /planning）」；Agent 调 generate_trip 委派后台生成。
// 刷新恢复：会话与 requestId 存在 sessionStorage，重发同一 requestId 由服务端幂等裁决。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  MAX_TRIP_DAYS,
  PACE_OPTIONS,
  PREFERENCE_OPTIONS,
  TRANSPORT_MODES,
  requiredBriefFields,
  uid,
  type PlanningBriefData,
  type PlanningBriefPatch,
  type TransportMode,
  type TripPace,
} from '@tripweaver/shared';
import {
  keys,
  useCoveredCities,
  useCreateConversation,
  useCurrentGeneration,
  useMe,
  useSaveBriefSnapshot,
  useStartPlanning,
  useUsage,
} from '../api/hooks';
import { useTravelPreferencesDraft } from '../components/TravelPreferencesProvider';
import { clearPlanningEntry, readPlanningEntry, resolvePlanningEntry, writePlanningEntry } from '../lib/planningEntry';
import { daysBetween, isISODate, isoDateAfter } from '../lib/dates';

type Preference = (typeof PREFERENCE_OPTIONS)[number];

interface TripDraft {
  city: string;
  startDate: string;
  endDate: string;
  days: number;
  pace: TripPace | null;
  preferences: Preference[];
  partySize: number;
  transportMode: TransportMode | null;
  extraNotes: string;
}

/** 从 URL 解析草稿：预览参数一律不可信，逐项校验后回落到默认值 */
function parseDraft(params: URLSearchParams): TripDraft {
  const city = params.get('city')?.trim() ?? '';
  const rawStart = params.get('start');
  const rawEnd = params.get('end');
  const startDate = rawStart && isISODate(rawStart) ? rawStart : isoDateAfter(1);
  let endDate = isoDateAfter(3);
  if (rawStart && rawEnd && isISODate(rawStart) && isISODate(rawEnd)) {
    const span = daysBetween(rawStart, rawEnd);
    if (span >= 1 && span <= MAX_TRIP_DAYS) endDate = rawEnd;
  }
  const rawPace = params.get('pace');
  const pace = (PACE_OPTIONS as readonly string[]).includes(rawPace ?? '') ? (rawPace as TripPace) : null;
  const preferences = (params.get('preferences') ?? '')
    .split(',')
    .filter((p): p is Preference => (PREFERENCE_OPTIONS as readonly string[]).includes(p));
  const rawParty = Number(params.get('partySize'));
  const partySize = Number.isInteger(rawParty) && rawParty >= 1 && rawParty <= 20 ? rawParty : 2;
  const rawTransport = params.get('transport');
  const transportMode = (TRANSPORT_MODES as readonly string[]).includes(rawTransport ?? '')
    ? (rawTransport as TransportMode)
    : null;
  const extraNotes = (params.get('extraNotes') ?? '').slice(0, 200);
  return { city, startDate, endDate, days: daysBetween(startDate, endDate), pace, preferences, partySize, transportMode, extraNotes };
}

export function NewTripPage() {
  const [params, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const covered = useCoveredCities();
  const usage = useUsage();
  const me = useMe();
  const userId = me.data?.id ?? '';
  const createConversation = useCreateConversation();
  const patchBrief = useSaveBriefSnapshot();
  const startPlanning = useStartPlanning();
  const current = useCurrentGeneration(userId, Boolean(userId));
  const preferences = useTravelPreferencesDraft();

  const draft = useMemo(() => parseDraft(params), [params]);
  const text = (params.get('text') ?? '').trim().slice(0, 1000);
  // 到站时是否带了 autostart。守卫会把该参数从 URL 里清掉，所以后续渲染必须靠快照判断，
  // 否则清参数的瞬间就把自己判成「非直达访问」踢回首页。
  const autostartRequested = useRef(params.get('autostart') === '1').current;
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const paramsKey = useMemo(() => {
    const p = new URLSearchParams(params);
    p.delete('autostart');
    return p.toString();
  }, [params]);

  const briefData = useMemo<PlanningBriefData>(
    () => ({
      destination: draft.city,
      constraints: [],
      extraNotes: draft.extraNotes,
      startDate: draft.startDate,
      endDate: draft.endDate,
      days: draft.days,
      ...(draft.pace ? { pace: draft.pace } : {}),
      ...(draft.preferences.length > 0 ? { preferences: draft.preferences } : {}),
      partySize: draft.partySize,
      ...(draft.transportMode ? { transportMode: draft.transportMode } : {}),
    }),
    [draft],
  );

  const ready = requiredBriefFields(briefData).length === 0;
  const generationExhausted = usage.data?.remaining === 0;
  /** 挡住自动发起的原因；有值时把原因本身当提示文案用 */
  const blocked = !ready
    ? '选择信息不完整，没有可选的目的地或节奏，请回首页重新选择。'
    : generationExhausted
      ? '今日生成次数已用完，明天再来（已有行程仍可继续编辑）。'
      : null;
  const busy = starting || createConversation.isPending || patchBrief.isPending || startPlanning.isPending;
  const runningJobId = current.data?.status === 'running' ? current.data.jobId : null;

  const start = async (action: 'fresh' | 'resume') => {
    if (busy) return;
    setStarting(true);
    setError(null);
    try {
      const stored = action === 'resume' ? readPlanningEntry() : null;
      const reusable = stored && stored.params === paramsKey ? stored : null;
      let conversationId = reusable?.conversationId ?? '';
      let requestId = reusable?.requestId ?? uid();
      if (!conversationId) {
        const conversation = await createConversation.mutateAsync(`${draft.city} · ${draft.days}天行程`);
        conversationId = conversation.id;
        requestId = uid();
      }
      writePlanningEntry({ conversationId, requestId, params: paramsKey });

      const patch: PlanningBriefPatch = {
        destination: draft.city,
        startDate: draft.startDate,
        endDate: draft.endDate,
        days: draft.days,
        partySize: draft.partySize,
        extraNotes: draft.extraNotes,
      };
      if (draft.pace) patch.pace = draft.pace;
      if (draft.preferences.length > 0) patch.preferences = draft.preferences;
      if (draft.transportMode) patch.transportMode = draft.transportMode;
      await patchBrief.mutateAsync({ id: conversationId, patch });

      // 留一份表单参数：生成失败后「重新生成」直接回本页自动重发，不用重填。
      const replay = new URLSearchParams(params);
      replay.delete('autostart');
      sessionStorage.setItem('tw.lastTripDraftParams', replay.toString());

      // 标准 harness 流程：首页消息先进入主 Agent 回合，由主 Agent 回复并调用子 Agent。
      const result = await startPlanning.mutateAsync({
        id: conversationId,
        input: { requestId, text: text || `规划${draft.city}${draft.days}天行程`, autostart: true },
      });
      if (result.startedGenerationJobId) {
        // 首页选择只在生成真正开始后记忆；存的是本次提交的快照，不误存用户之后的新草稿。
        void preferences.persist({
          preferences: draft.preferences,
          transportMode: draft.transportMode ?? 'transit',
          pace: draft.pace,
          partySize: draft.partySize,
          extraNotes: draft.extraNotes,
        });
        clearPlanningEntry();
        void qc.invalidateQueries({ queryKey: keys.currentGeneration(userId) });
        navigate(`/agent/${encodeURIComponent(result.startedGenerationJobId)}`, { replace: true });
        return;
      }
      setError(result.replyMessage.content || '生成没有启动，请回首页重试。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '启动失败，请稍后重试');
    } finally {
      setStarting(false);
    }
  };

  // autostart 守卫：每渲染后只做一次很轻的检查；等 covered / 当前任务快照就绪再决定接管还是新提交。
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current) return;
    if (!covered.data || current.isPending) return;
    if (params.get('autostart') !== '1') return;
    autoStarted.current = true;
    setSearchParams(
      (prev) => {
        prev.delete('autostart');
        return prev;
      },
      { replace: true },
    );
    if (blocked) return;
    const action = resolvePlanningEntry({ stored: readPlanningEntry(), params: paramsKey, runningJobId });
    if (action === 'adopt' && runningJobId) {
      clearPlanningEntry();
      navigate(`/agent/${encodeURIComponent(runningJobId)}`, { replace: true });
      return;
    }
    void start(action === 'adopt' ? 'fresh' : action);
  });

  if (covered.isPending) {
    return (
      <div className={"page w-full [max-width:880px] [margin:0_auto] [padding:20px_16px_48px]"}>
        <div className={"page-loading [padding:20vh_16px] text-center [color:var(--color-muted)]"}>加载中…</div>
      </div>
    );
  }

  // 本页不再是收集入口：不是直达访问、或城市缺失/未覆盖 → 回首页重选
  if (!autostartRequested || !draft.city || (covered.data && !covered.data.cities.includes(draft.city))) {
    return <Navigate to="/" replace />;
  }

  // ---------- 启动中 / 启动失败 ----------
  const failure = error ?? blocked;
  return (
    <div className={"page w-full [max-width:880px] [margin:0_auto] [padding:20px_16px_48px]"}>
      <div className={"page-head flex items-center justify-between [gap:12px] [margin-bottom:16px] flex-wrap"}>
        <h1>{draft.city}之旅</h1>
      </div>
      {failure ? (
        <>
          <p className={"form-error [color:var(--color-danger)] [font-size:0.85rem] m-0"}>{failure}</p>
          <div className={"page-head-actions flex [gap:8px]"}>
            <Link to="/" className={"btn [border:1px_solid_transparent] [border-radius:var(--radius)] [padding:8px_14px] [font-size:0.9rem] cursor-pointer inline-flex items-center [gap:4px] [&:disabled]:[opacity:0.55] [&:disabled]:[cursor:not-allowed] btn-primary [background:var(--color-primary)] [color:var(--color-btn-primary-color-3)] [&:not(:disabled):hover]:[background:var(--color-primary-dark)]"}>
              回首页重新选择
            </Link>
          </div>
        </>
      ) : (
        <div className={"page-loading [padding:20vh_16px] text-center [color:var(--color-muted)]"}>正在启动生成…</div>
      )}
    </div>
  );
}
