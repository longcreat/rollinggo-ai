import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { TravelPreferences } from '@tripweaver/shared';
import { keys, useCurrentGeneration, type GenerationRequest, type MeView } from '../api/hooks';
import { useGenerationRun, type GenerationRun } from '../hooks/useGenerationRun';
import { useTravelPreferencesDraft } from './TravelPreferencesProvider';

interface GenerationContext extends GenerationRun {
  running: boolean;
  discovering: boolean;
  destination: string;
  days: number;
}
const Context = createContext<GenerationContext | null>(null);

export function GenerationProvider({ userId, children }: { userId: string; children: ReactNode }) {
  const qc = useQueryClient();
  const preferences = useTravelPreferencesDraft();
  const pendingPreference = useRef<TravelPreferences | undefined>(undefined);
  const submitted = useRef(new Map<string, TravelPreferences>());
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const run = useGenerationRun({
    enabled: Boolean(userId),
    onStarted: (id) => {
      if (pendingPreference.current) submitted.current.set(id, pendingPreference.current);
      pendingPreference.current = undefined;
      // 清掉可能残留的「旧任务仍在运行」快照：查询在跟踪期间被禁用，缓存会停在上一次
      // running 的值；不清的话新任务 onSuccess 后 adopt effect 又会把 jobId 改回旧任务。
      qc.setQueryData(keys.currentGeneration(userId), null);
      void qc.invalidateQueries({ queryKey: keys.currentGeneration(userId) });
    },
    onDone: (_tripId, jobId) => {
      const snapshot = submitted.current.get(jobId);
      submitted.current.delete(jobId);
      if (snapshot) void preferences.persist(snapshot);
      void qc.invalidateQueries({ queryKey: keys.notifications(userId) });
      void qc.invalidateQueries({ queryKey: keys.currentGeneration(userId) });
    },
  });
  // 已有任务在跟踪时不再查：该查询只用于发现「重新进入页面时的孤儿任务」，见下方 adopt effect
  const current = useCurrentGeneration(userId, !run.jobId);
  const terminal = run.events.some((event) => event.type === 'job_done' || event.type === 'job_error' || event.type === 'job_cancelled');
  // 用 isLoading 而非 isPending：查询被禁用时（已有任务在跟踪）isPending 仍为 true，会让加载态永远不结束。
  const discovering = current.isLoading;
  const running = Boolean(run.jobId && !terminal && run.completed?.jobId !== run.jobId);
  const runRef = useRef(run); runRef.current = run;
  useEffect(() => {
    if (run.restoring || run.starting) return;
    // 已在跟踪某个任务时忽略快照：SSE 才是它的权威源。否则新任务刚启动、starting
    // 转 false 的瞬间，若 current 读回上一条「旧任务仍在运行」的缓存，会把 jobId 改回旧任务，
    // 接着重放旧任务的 job_done → 直接跳上一次的行程详情页。
    if (runRef.current.jobId) return;
    const snapshot = current.data;
    if (snapshot?.status === 'running') runRef.current.adopt(snapshot.jobId);
  }, [current.data, run.restoring, run.starting]);
  useEffect(() => {
    if (!terminal) return;
    void qc.invalidateQueries({ queryKey: keys.notifications(userId) });
    void qc.invalidateQueries({ queryKey: keys.currentGeneration(userId) });
  }, [terminal, userId, qc]);
  const start = (form: GenerationRequest) => {
    // 建会话／写 Brief 期间可能切页或退出；迟到调用不能借新账号启动任务。
    if (!mounted.current || qc.getQueryData<MeView>(keys.me)?.id !== userId || running || run.starting) return;
    // 以实际提交的表单为准；生成完成时不能误存用户刚在首页修改的新草稿。
    pendingPreference.current = {
      preferences: [...new Set(form.preferences)], transportMode: form.transportMode ?? 'transit',
      pace: form.pace ?? 'moderate', partySize: form.partySize, extraNotes: form.extraNotes,
    };
    run.start(form);
  };
  const startEvent = run.events.find((event) => event.type === 'job_start');
  return <Context.Provider value={{ ...run, start, running, discovering,
    destination: startEvent?.destination ?? current.data?.destination ?? '',
    days: startEvent?.days ?? current.data?.days ?? 0,
  }}>{children}</Context.Provider>;
}

export function useActiveGeneration() {
  const value = useContext(Context);
  if (!value) throw new Error('GenerationProvider is required');
  return value;
}
