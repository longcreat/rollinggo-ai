import { Button } from '../components/ui/Button';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useMatch, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Value } from '@sinclair/typebox/value';
import { keys, useGenerationTask, useHealthCheck, useMe, useLogout, useTrip, useTripConversation, useTripVersions } from '../api/hooks';
import { HealthCheckSheet } from '../components/editor/HealthCheckSheet';
import { api } from '../api/client';
import { useEditorSave } from '../hooks/useEditorSave';
import { useAppNavigation } from '../components/NavigationProvider';
import { HistoryPanel } from '../components/editor/HistoryPanel';
import { useEditorStore } from '../store/editorStore';
import { ChatPanel } from '../components/chat/ChatPanel';
import { DaySection } from '../components/editor/DaySection';
import { AutoRoutePlanner } from '../components/editor/AutoRoutePlanner';
import { MapView } from '../components/editor/MapView';
import { TripSchema, dateForDayIndex, type Trip, type TripOperationResult } from '@tripweaver/shared';
import { EditorIcon } from '../components/editor/EditorIcon';
import { ExportMenu } from '../components/ExportMenu';
import { matchOverview } from '../lib/tripDerive';
import { useTripWeather } from '../api/weather';
import { TripOverview } from '../components/editor/TripOverview';
import { NotificationCenter } from '../components/NotificationCenter';
import { BotIcon, SendIcon, PlusIcon } from '../components/home/HomeIcons';
import { Compass, PanelLeftClose } from 'lucide-react';
import { useLiveTrip } from '../hooks/useLiveTrip';
import { LiveAgentStream } from '../components/live/LiveAgentStream';

type MobileTab = 'chat' | 'list' | 'map';

export function TripEditorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const userId = me.data?.id;
  // 直播模式：/agent/:jobId 与 /trips/:id 共用同一个工作区，只切换数据源。
  const liveJobId = useMatch('/agent/:jobId')?.params.jobId;
  const live = Boolean(liveJobId);
  const liveState = useLiveTrip(liveJobId);
  // 投影在任务过期/重启后可能缺席；持久任务行仍能告诉我们终态与 tripId，交接不依赖内存。
  const liveTask = useGenerationTask(liveJobId);
  const completedTripId = liveState.completedTripId
    ?? (liveTask.data?.status === 'done' ? liveTask.data.tripId : null);
  const tripQuery = useTrip(id, !live);
  const weatherQuery = useTripWeather(live ? '' : id, tripQuery.data);
  const versions = useTripVersions(live ? '' : id);
  const latest = versions.data?.versions.reduce((a, b) => b.version > a.version ? b : a);
  const historyVersion = versions.data?.versions.find((v) => v.id === id);
  const readOnly = live || !latest || latest.id !== id;
  const conversationQuery = useTripConversation(live ? '' : id);
  const conversationId = live ? null : conversationQuery.data?.conversationId ?? null;
  const save = useEditorSave(live ? '' : id, readOnly, (saved) => navigate(`/trips/${saved.id}`, { replace: true }));
  const { register } = useAppNavigation();
  const flushRef = useRef(save.flush); flushRef.current = save.flush;
  useEffect(() => register(async () => {
    if (operation.current) throw new Error('行程仍在更新，请稍后再离开');
    if (Object.values(useEditorStore.getState().routeReplans).some((job) => job.status === 'pending')) throw new Error('路线仍在更新，请稍后再离开');
    await flushRef.current();
    if (operation.current || Object.values(useEditorStore.getState().routeReplans).some((job) => job.status === 'pending')) throw new Error('行程仍在更新，请稍后再离开');
  }), [register]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const [restoreId, setRestoreId] = useState<string>();
  const healthCheck = useHealthCheck(live ? '' : id);
  const healthHard = healthCheck.data?.findings.filter((f) => f.severity === 'hard').length ?? 0;
  const [busy, setBusy] = useState(false);
  const operation = useRef(false);
  const nextView = useRef<{ id: string; dayIndex: number | null; activityId?: string } | null>(null);
  const [conversationError, setConversationError] = useState('');

  // 助手面板收起/展开状态
  const [aiPanelOpen, setAiPanelOpen] = useState(true);

  const createChat = async () => {
    let acquired = false;
    try {
      const saved = await begin(); acquired = true; setConversationError('');
      const result = await api.post<{ conversationId: string }>(`/api/trips/${saved.id}/conversation`);
      qc.setQueryData(['trips', saved.id, 'conversation'], result);
    } catch (err) { setConversationError(err instanceof Error ? err.message : '对话关联失败'); }
    finally { if (acquired) end(); }
  };

  const trip = useEditorStore((s) => s.trip);
  const dayFilter = useEditorStore((s) => s.dayFilter);
  const load = useEditorStore((s) => s.load);
  const clear = useEditorStore((s) => s.clear);
  const addDay = useEditorStore((s) => s.addDay);

  const [mobileTab, setMobileTab] = useState<MobileTab>(live ? 'chat' : 'list');
  const scrollRef = useRef<HTMLDivElement>(null);
  const setDayFilter = useEditorStore((s) => s.setDayFilter);

  // 地图马克点与对话“查看编辑结果”共用：先切到那天，再滚到对应地点
  const jumpToActivity = useCallback((dayIndex: number, activityId: string) => {
    setMobileTab('list');
    setDayFilter(dayIndex);
    requestAnimationFrame(() => document.getElementById(`activity-${activityId}`)?.scrollIntoView({ block: 'center' }));
  }, [setDayFilter]);

  // 载入：仅在行程 id 变化时执行，避免自动保存回写触发重载覆盖本地编辑
  const loadedId = tripQuery.data?.id;
  useEffect(() => {
    if (tripQuery.data && useEditorStore.getState().trip?.id !== loadedId) {
      load(tripQuery.data);
      const view = nextView.current;
      if (view && view.id === loadedId) {
        if (view.activityId && view.dayIndex !== null) jumpToActivity(view.dayIndex, view.activityId);
        else setDayFilter(view.dayIndex);
        nextView.current = null;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedId]);
  useEffect(() => () => clear(), [clear]);

  // 直播：每天 plan_day 到达就整份替换合成行程，保留当前选中的天。
  useEffect(() => {
    const next = liveState.trip;
    if (!live || !next) return;
    const current = useEditorStore.getState();
    if (current.trip?.id === next.id && current.trip.updatedAt === next.updatedAt) return;
    const filter = current.dayFilter;
    load(next);
    if (filter !== null) useEditorStore.getState().setDayFilter(filter);
  }, [live, liveState.trip, load]);

  // 完成：先把正式行程写进缓存再原地切到 /trips/:id，避免闪屏。
  useEffect(() => {
    if (!live || !completedTripId) return;
    let alive = true;
    void qc.fetchQuery({
      queryKey: keys.trip(completedTripId),
      queryFn: () => api.get<unknown>(`/api/trips/${completedTripId}`),
    }).then((saved) => {
      if (!alive) return;
      // 校验失败只提示，不把用户永久困在直播页：字段轻微越界（如营业时间文本过长）
      // 不该阻断交接，详情页本身能正常渲染。
      if (!Value.Check(TripSchema, saved)) console.warn('[generation] 落库行程未通过 schema 校验，仍进入详情页');
      qc.setQueryData(keys.trip(completedTripId), saved);
      load(saved as Trip);
      navigate(`/trips/${completedTripId}`, { replace: true });
    }).catch(() => {});
    return () => { alive = false; };
  }, [live, completedTripId, qc, load, navigate]);

  useEffect(() => { useEditorStore.getState().setReadOnly(readOnly || busy); }, [readOnly, busy]);
  const begin = async () => {
    if (operation.current) throw new Error('请等待当前操作结束');
    if (Object.values(useEditorStore.getState().routeReplans).some((job) => job.status === 'pending')) throw new Error('路线仍在更新，请稍后重试');
    operation.current = true; setBusy(true); useEditorStore.getState().setReadOnly(true);
    try {
      await save.flush();
      const current = useEditorStore.getState().trip;
      if (!current) throw new Error('行程已切换');
      return current;
    } catch (err) { operation.current = false; setBusy(false); useEditorStore.getState().setReadOnly(readOnly); throw err; }
  };
  const end = () => { operation.current = false; setBusy(false); };
  const onTrip = async (targetId: string, result?: TripOperationResult) => {
    const target: unknown = result?.trip ?? await api.get<unknown>(`/api/trips/${targetId}`);
    if (!Value.Check(TripSchema, target)) throw new Error('版本内容读取失败');
    const selected = useEditorStore.getState().dayFilter;
    qc.setQueryData(keys.trip(targetId), target);
    qc.setQueryData(['trips', targetId, 'conversation'], { conversationId });
    await qc.invalidateQueries({ queryKey: keys.trips });
    if (conversationId) await qc.invalidateQueries({ queryKey: keys.conversation(conversationId) });
    const day = target.days.find((d) => result?.dayId ? d.id === result.dayId : d.dayIndex === selected);
    const view = { id: targetId, dayIndex: day?.dayIndex ?? null, activityId: result?.activityId };
    if (result?.activityId) setMobileTab('list');
    // 日期选择必须在 load 之后恢复，避免下一帧比路由 effect 更早导致选择被覆盖。
    if (targetId === id) {
      setDayFilter(view.dayIndex);
      if (view.activityId) requestAnimationFrame(() => document.getElementById(`activity-${view.activityId}`)?.scrollIntoView({ block: 'center' }));
    } else nextView.current = view;
    navigate(`/trips/${targetId}`);
  };

  const visibleDays = useMemo(() => {
    const days = trip?.days ?? [];
    return dayFilter === null ? days : days.filter((d) => d.dayIndex === dayFilter);
  }, [trip, dayFilter]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); }, [dayFilter]);

  // 概览并入行程：候选按名称匹配到活动（内嵌卡片），未命中的进「备选」抽屉；旧行程无 overview → 两者皆空
  const overviewMatch = useMemo(() => matchOverview(trip?.days ?? [], trip?.overview), [trip]);

  if (!live) {
    if (tripQuery.isPending) return <div className="page-loading p-12 text-center text-slate-400">加载中…</div>;
    if (tripQuery.isError) return <div className="page-loading p-12 text-center text-red-500">行程加载失败：{tripQuery.error.message}</div>;
    if (!trip) return <div className="page-loading p-12 text-center text-slate-400">准备编辑器…</div>;
  } else if (!trip) {
    return <div className="editor-page flex h-dvh items-center justify-center bg-[#f4f7fb] text-sm text-slate-400">正在启动生成…</div>;
  }
  const weatherSnapshot = weatherQuery.data ?? (weatherQuery.isError ? undefined : trip.weather);
  const weather = weatherSnapshot?.destination === trip.destination ? weatherSnapshot : undefined;

  const mobileTabs: [MobileTab, string][] = [
    ['chat', 'RollingGo AI'],
    ['list', '行程'],
    ['map', '地图'],
  ];

  // 直播终态：失败/停止后顶栏不该继续显示「正在生成」，标题里的「· 生成中」也要摘掉。
  const liveTerminal = live ? liveState.stream.terminal?.type : undefined;
  const liveStatus = liveTerminal === 'job_error'
    ? { label: '生成未完成', dot: 'bg-rose-500' }
    : liveTerminal === 'job_cancelled'
      ? { label: '已停止', dot: 'bg-slate-400' }
      : liveTerminal === 'job_done'
        ? { label: '已生成', dot: 'bg-emerald-500' }
        : { label: '正在生成', dot: 'bg-emerald-500 motion-safe:animate-pulse' };
  const displayTitle = liveTerminal ? trip.title.replace(/\s*·\s*生成中$/, '') : trip.title;

  const endDate = dateForDayIndex(trip.startDate, Math.max(1, trip.days.length));
  const dateLabel = trip.startDate && endDate
    ? `${trip.startDate.slice(5).replace('-', '月')}日—${endDate.slice(5).replace('-', '月')}日`
    : '';

  const itineraryPanel = (
    <div className="itinerary-panel">
      {dayFilter !== null && visibleDays.length === 0 && <p className="text-slate-400 text-sm day-empty text-center py-4">没有可显示的天数</p>}
      {dayFilter !== null && visibleDays.map((day) => (
        <DaySection
          key={day.id}
          day={day}
          allDays={trip.days}
          poiByActivityId={overviewMatch.poiByActivityId}
          weather={weather}
          weatherLoading={weatherQuery.isFetching}
          onSelectActivity={jumpToActivity}
        />
      ))}
      {dayFilter === null && (
        <TripOverview trip={trip} weather={weather} loading={weatherQuery.isFetching}
          onSelectDay={setDayFilter} onAddDay={addDay}
          readOnly={readOnly} busy={busy} pois={overviewMatch.poiByActivityId} />
      )}
    </div>
  );

  return (
    <div className="editor-page flex flex-col h-dvh max-h-dvh min-h-0 bg-[#f4f7fb] p-3 gap-2.5 overflow-hidden text-slate-800">
      {/* 顶部工具栏（严格复刻圆周旅迹风格：单栏置顶，彻底去除多余的全局外层导航） */}
      <header className="editor-toolbar flex items-center justify-between px-4 py-2 bg-white/95 backdrop-blur-md border border-slate-200/80 rounded-2xl shadow-xs shrink-0 z-20">
        <div className="flex items-center gap-3 min-w-0">
          <Link to="/trips" className="inline-flex items-center gap-1.5 text-slate-700 hover:text-slate-950 text-sm font-medium pr-3 border-r border-slate-200 transition-colors cursor-pointer" aria-label="返回行程列表">
            <EditorIcon name="back" />
            <span>返回</span>
          </Link>
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-base font-bold text-slate-900 truncate m-0 flex items-center gap-1.5" title={displayTitle}>
              <span>{displayTitle}</span>
            </h1>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100/90 text-xs text-slate-600 whitespace-nowrap">
              <EditorIcon name="calendar" />
              <span>{dateLabel || '添加日历'}</span>
              <span>·</span>
              <span>{trip.days.length}天</span>
              <span>{trip.partySize}人</span>
            </span>
            {save.state === 'error' && (
              <span className="text-red-500 text-xs flex items-center gap-1" role="alert">
                {save.error}
                <Button variant="ghost" type="button" onClick={() => void save.flush().catch(() => {})}>重试</Button>
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {live && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600">
              <span className={`h-1.5 w-1.5 rounded-full ${liveStatus.dot}`} aria-hidden="true" />
              {liveStatus.label}
            </span>
          )}
          {!live && <>
          <Button
            variant="secondary"
            onClick={() => setHealthOpen(true)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors cursor-pointer ${
              healthHard > 0 ? 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100' : 'border-slate-200 text-slate-700 hover:bg-slate-50'
            }`}
            title="行程体检：检查超载、闭馆日、排不下等硬冲突"
          >
            <Compass className="w-3.5 h-3.5" />
            <span>体检</span>
            {healthHard > 0 && (
              <span className="inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-rose-600 text-white text-[10px] leading-none font-bold">
                {healthHard}
              </span>
            )}
          </Button>
          <Button
            variant="secondary"
            onClick={() => { setRestoreId(undefined); setHistoryOpen(true); }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer"
            title="历史版本"
          >
            <EditorIcon name="history" />
            <span>历史版本</span>
          </Button>
          <ExportMenu trip={trip} />
          {userId && <NotificationCenter key={userId} userId={userId} />}
          </>}
          <HealthCheckSheet
            open={healthOpen}
            onClose={() => setHealthOpen(false)}
            tripId={id}
            tripUpdatedAt={trip.updatedAt}
            check={healthCheck.data}
          />
        </div>
      </header>

      {!live && latest && latest.id !== id && (
        <div className="flex items-center gap-2 rounded-xl bg-amber-50 border border-amber-200 px-4 py-2 text-xs text-amber-800 shrink-0" role="status">
          <span>正在查看历史版本 v{historyVersion?.version}</span>
          <Button disabled={busy} onClick={() => { void (async () => { await begin(); try { await onTrip(latest.id); } finally { end(); } })().catch(() => setHistoryOpen(true)); }}>返回最新版本</Button>
          <Button disabled={busy} onClick={() => { setRestoreId(id); setHistoryOpen(true); }}>恢复此版本</Button>
        </div>
      )}

      {/* 移动端页签切换 */}
      <div className="editor-mobile-tabs hidden max-[768px]:flex bg-white rounded-xl border border-slate-200 p-1 shrink-0">
        {mobileTabs.map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            className={`flex-1 py-1.5 text-xs font-medium rounded-lg transition-all ${mobileTab === tab ? 'bg-slate-900 text-white shadow-xs' : 'text-slate-500'}`}
            onClick={() => setMobileTab(tab)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 三栏工作台主体 */}
      <main className={`editor-body flex-1 flex min-h-0 gap-3 relative max-[768px]:flex-col mobile-${mobileTab}`}>
        {/* 左栏：RollingGo AI 对话面板 */}
        <aside
          className={`editor-chat w-[360px] lg:w-[380px] shrink-0 flex flex-col rounded-3xl bg-white border border-slate-200/80 shadow-[0_4px_24px_rgba(0,0,0,0.04)] overflow-hidden min-h-0 z-10 transition-all duration-200 max-[768px]:flex-1 max-[768px]:min-h-0 ${
            aiPanelOpen ? 'flex' : 'hidden'
          } max-[768px]:w-full max-[768px]:${mobileTab === 'chat' ? 'flex' : 'hidden'}`}
          aria-label="旅行AI助手"
        >
          {/* 头部：RollingGo AI + 收起按钮 */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-white/95 shrink-0">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-900 text-white shadow-2xs">
                <Compass className="h-4 w-4" />
              </span>
              <span className="text-[15px] font-semibold text-slate-800 tracking-tight">RollingGo AI</span>
            </div>
            <button
              type="button"
              onClick={() => setAiPanelOpen(false)}
              className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full border border-slate-200/90 text-xs font-medium text-slate-600 hover:bg-slate-50 hover:text-slate-900 transition-colors cursor-pointer"
              title="收起助手面板"
            >
              <PanelLeftClose className="h-3.5 w-3.5 text-slate-500" />
              <span>收起</span>
            </button>
          </div>

          {/* 对话内容与输入流 */}
          <div className="flex-1 min-h-0 flex flex-col">
            {live ? (
              <LiveAgentStream
                stream={liveState.stream}
                destination={liveState.trip?.destination ?? ''}
                days={liveState.trip?.days.length}
                cancelling={liveState.cancelling}
                error={liveState.cancellationError ?? liveState.error}
                lost={liveState.lost}
                onCancel={liveState.cancel}
                onHome={() => navigate('/')}
                onRetry={() => {
                  // 失败重试：复用手上这份表单参数回 /trips/new 自动再发起一次；
                  // 没有留档（比如从通知里恢复的任务）时退回首页，别把用户卡死在死路。
                  const saved = sessionStorage.getItem('tw.lastTripDraftParams');
                  navigate(saved ? `/trips/new?${saved}&autostart=1` : '/');
                }}
              />
            ) : conversationId ? (
              <ChatPanel
                conversationId={conversationId}
                trip={trip}
                dayId={trip.days.find((d) => d.dayIndex === dayFilter)?.id}
                readOnly={readOnly}
                busy={busy}
                begin={begin}
                end={end}
                onTrip={onTrip}
              />
            ) : (
              <div className="p-6 text-sm flex flex-col items-center justify-center flex-1 text-center text-slate-500 gap-3">
                <BotIcon className="w-10 h-10 text-slate-400 stroke-1" />
                <p className="m-0 leading-relaxed">
                  {conversationQuery.isPending
                    ? '正在加载对话…'
                    : conversationQuery.isError
                    ? '对话关联加载失败'
                    : '开启 AI 对话，随时微调行程、发掘沿途宝藏。'}
                </p>
                <Button
                  disabled={readOnly || busy || conversationQuery.isPending}
                  onClick={() => (conversationQuery.isError ? void conversationQuery.refetch() : void createChat())}
                  className="rounded-xl bg-slate-900 hover:bg-slate-800 text-white px-4 py-2"
                >
                  {conversationQuery.isError ? '重试' : '开启 AI 对话'}
                </Button>
                {conversationError && <p className="text-red-500 text-xs m-0" role="alert">{conversationError}</p>}
              </div>
            )}
          </div>
        </aside>

        {/* 中间栏：行程总览与时间轴 */}
        <section
          className={`editor-left flex-1 min-w-[320px] flex flex-col rounded-3xl bg-white border border-slate-200/80 shadow-[0_4px_24px_rgba(0,0,0,0.04)] overflow-hidden min-h-0 relative transition-all duration-200 ${
            mobileTab === 'list' ? 'flex' : 'max-[768px]:hidden'
          }`}
        >
          {/* 天数导航栏（总览、第1天、第2天... + 新增一天 + 助手开关） */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-100 bg-white/95 shrink-0 z-10 gap-2">
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar flex-1 min-w-0 py-0.5" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
              <button
                type="button"
                onClick={() => setDayFilter(null)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-all cursor-pointer whitespace-nowrap ${
                  dayFilter === null
                    ? 'bg-slate-900 text-white shadow-xs'
                    : 'bg-white border border-slate-200/90 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                总览
              </button>
              {trip.days.map((day) => (
                <button
                  key={day.id}
                  type="button"
                  onClick={() => setDayFilter(day.dayIndex)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-all cursor-pointer whitespace-nowrap ${
                    dayFilter === day.dayIndex
                      ? 'bg-slate-900 text-white shadow-xs'
                      : 'bg-white border border-slate-200/90 text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  第{day.dayIndex}天
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => addDay()}
                disabled={readOnly || busy}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-100 text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
                title="新增一天"
              >
                <span>＋</span><span>加一天</span>
              </button>
              {!aiPanelOpen && (
                <button
                  type="button"
                  onClick={() => setAiPanelOpen(true)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-700 hover:bg-slate-50 hover:text-slate-950 transition-colors cursor-pointer shadow-2xs"
                  title="展开 AI 伴游"
                >
                  <Compass className="h-3.5 w-3.5 text-slate-700" />
                  <span>AI 伴游</span>
                </button>
              )}
            </div>
          </div>

          {/* 行程列表滚动区 */}
          <div
            className={`flex-1 overflow-y-auto min-h-0 no-scrollbar px-6 py-4 ${
              !aiPanelOpen ? 'pb-20' : 'pb-8'
            }`}
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
            ref={scrollRef}
          >
            {itineraryPanel}
          </div>

          {/* 收起状态下：左下角常驻唤醒条 */}
          {!aiPanelOpen && (
            <div
              onClick={() => setAiPanelOpen(true)}
              className="absolute bottom-3 left-4 z-30 max-w-[calc(100%-32px)] bg-white/95 backdrop-blur-md rounded-2xl border border-slate-200/90 shadow-[0_8px_30px_rgba(0,0,0,0.12)] px-4 py-2.5 flex items-center gap-3 cursor-pointer hover:shadow-xl hover:border-slate-400 hover:scale-[1.01] transition-all group animate-in fade-in duration-200"
              role="button"
              tabIndex={0}
              aria-label="打开 RollingGo AI 助手"
            >
              <Compass className="w-4 h-4 text-slate-800 shrink-0 group-hover:scale-110 transition-transform" />
              <span className="text-slate-500 text-sm select-none truncate group-hover:text-slate-800">
                让 RollingGo 帮你微调行程…
              </span>
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-slate-900 text-white group-hover:bg-slate-800 transition-colors shadow-xs shrink-0">
                <SendIcon className="w-3.5 h-3.5" />
              </span>
            </div>
          )}
        </section>

        {/* 右栏：真实高德/Leaflet 交互地图（无冗余虚构浮层） */}
        <div
          className={`editor-map ${
            aiPanelOpen ? 'w-[40%] min-w-[340px]' : 'w-[44%] min-w-[380px]'
          } shrink-0 relative rounded-3xl border border-slate-200/80 bg-slate-50 overflow-hidden shadow-[0_4px_24px_rgba(0,0,0,0.04)] min-h-0 transition-all duration-200 ${
            mobileTab === 'map' ? 'flex' : 'max-[768px]:hidden'
          }`}
        >
          <MapView visible={true} onSelectActivity={jumpToActivity} />
        </div>
      </main>

      {!readOnly && !busy && <AutoRoutePlanner />}
      {historyOpen && <HistoryPanel currentId={id} chain={versions.data} loading={versions.isPending} failed={versions.isError} busy={busy} initialRestore={restoreId} refresh={() => void versions.refetch()} close={() => setHistoryOpen(false)} begin={begin} end={end} onTrip={onTrip} />}
    </div>
  );
}
