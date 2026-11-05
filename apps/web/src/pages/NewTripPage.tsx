// 新建行程（09-27 收尾）：首页已完成全部信息收集并带 autostart=1 直达，本页不再渲染表单，
// 只负责「发起生成 → 生成中 / 启动失败」这一段；缺 autostart 或参数不完整时回首页重选
// （首页是唯一的收集入口，见 .trellis/tasks/archive/2026-10/09-27-home-followups/prd.md）。
// 提交链路：惰性建会话 → PATCH 写入 Brief 快照（编辑器内嵌对话靠会话关联反查）→ POST /api/generations。
// Brief → GenerateForm 的映射复用 shared 的 briefToGenerateForm，前端不另写一套。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import {
  MAX_TRIP_DAYS,
  PACE_OPTIONS,
  PREFERENCE_OPTIONS,
  TRANSPORT_MODES,
  briefToGenerateForm,
  requiredBriefFields,
  type PlanningBriefData,
  type PlanningBriefPatch,
  type TransportMode,
  type TripPace,
} from '@tripweaver/shared';
import { useCoveredCities, useCreateConversation, useSaveBriefSnapshot, useUsage } from '../api/hooks';
import { useActiveGeneration } from '../components/GenerationProvider';
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

  const covered = useCoveredCities();
  const usage = useUsage();
  const createConversation = useCreateConversation();
  const patchBrief = useSaveBriefSnapshot();

  const draft = useMemo(() => parseDraft(params), [params]);
  // 到站时是否带了 autostart。守卫会把该参数从 URL 里清掉，所以后续渲染必须靠快照判断，
  // 否则清参数的瞬间就把自己判成「非直达访问」踢回首页（start 还在建会话/写 Brief）。
  const autostartRequested = useRef(params.get('autostart') === '1').current;
  const [error, setError] = useState<string | null>(null);
  const run = useActiveGeneration();
  const completedAtEntry = useRef(run.completed?.jobId);
  const doneTripId = run.completed && run.completed.jobId !== completedAtEntry.current ? run.completed.tripId : null;

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
  const busy = createConversation.isPending || patchBrief.isPending || run.starting;
  /** 挡住自动发起的原因；有值时把原因本身当提示文案用 */
  const blocked = !ready
    ? '选择信息不完整，没有可选的目的地或节奏，请回首页重新选择。'
    : generationExhausted
      ? '今日生成次数已用完，明天再来（已有行程仍可继续编辑）。'
      : null;

  const submit = async () => {
    if (!ready || busy || generationExhausted) return;
    setError(null);
    try {
      const conversation = await createConversation.mutateAsync(`${draft.city} · ${draft.days}天行程`);
      // Brief 快照：整包写入（一次 PATCH = 一条对话记录，留档生成输入）
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
      await patchBrief.mutateAsync({ id: conversation.id, patch });
      run.start({ ...briefToGenerateForm(briefData), conversationId: conversation.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败，请稍后重试');
    }
  };

  // autostart 守卫：到站即提交，不再让用户点第二次开始生成；提交后清掉该参数，
  // 避免刷新页面又跑一次生成。restoring 期间先等快照（上次任务的恢复可能直接跳走），
  // 否则会与恢复流程抢着发一次生成。（无依赖数组：每渲染后只做一次很轻的守卫检查）
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || run.restoring || run.discovering || run.running || doneTripId) return;
    if (params.get('autostart') !== '1') return;
    if (blocked || busy) return;
    autoStarted.current = true;
    setSearchParams(
      (prev) => {
        prev.delete('autostart');
        return prev;
      },
      { replace: true },
    );
    void submit();
  });

  // ---------- 生成中 / 恢复 ----------
  if (run.restoring || run.discovering) {
    return (
      <div className={"page w-full [max-width:880px] [margin:0_auto] [padding:20px_16px_48px]"}>
        <div className={"page-loading [padding:20vh_16px] text-center [color:var(--color-muted)]"}>正在恢复生成进度…</div>
      </div>
    );
  }

  // 生成成功直接进详情页：doneTripId 一置就不再渲染进度面板，下面的 Navigate 接管
  if (run.running && run.jobId) return <Navigate to={`/generations/${encodeURIComponent(run.jobId)}`} replace />;

  // 生成成功即接管：实时 SSE 与快照恢复两条路都落在这里，不再显示进度面板的终态卡片。
  if (doneTripId) return <Navigate to={`/trips/${doneTripId}`} replace />;

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
  const failure = error ?? run.errorMessage ?? blocked;
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
