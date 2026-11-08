import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Conversation,
  ConversationDetail,
  CoveredCitiesView,
  EmailCodeBody,
  GenerateForm,
  GenerationJobView,
  GenerationJobStatus,
  NotificationPage,
  LoginBody,
  PasswordResetBody,
  PlanningBriefPatch,
  PlanningBriefView,
  RegisterBody,
  SettingsPut,
  Trip,
  TripExport,
  TripListPage,
  TripListSort,
  TripPace,
  TripVersionChain,
  TravelPreferences,
  UsageView,
} from '@tripweaver/shared';
import { TRIP_LIST_PAGE_SIZE, TravelPreferencesSchema, NotificationPageSchema, GenerationJobViewSchema, type HealthCheckView, type HealthDecisionsRequest } from '@tripweaver/shared';
import { Value } from '@sinclair/typebox/value';
import { api, resetAuthState, shouldRetryQuery } from './client';

export interface MeView {
  id: string;
  email: string;
}

export interface AuthConfigView {
  registrationMode: 'open' | 'invite' | 'closed';
  githubEnabled: boolean;
  emailCodeEnabled: boolean;   // 10-18：Resend 通道是否就绪，open 模式注册依赖它
}

export interface SettingsView {
  byokEnabled: boolean;
  baseUrl: string;
  model: string;
  apiKeyLast4: string;
  hasSiteKey: boolean;
  hasPersonalAmapKey: boolean;
  amapApiKeyLast4: string;
  hasSiteAmapKey: boolean;
  hasPersonalSearchKey: boolean;
  searchApiKeyLast4: string;
  searchApiBaseUrl: string;
  hasSiteSearchKey: boolean;
}

export const keys = {
  me: ['me'] as const,
  authConfig: ['auth-config'] as const,
  settings: ['settings'] as const,
  travelPreferences: (userId: string) => ['travel-preferences', userId] as const,
  sourcesStatus: ['sources-status'] as const,
  usage: ['usage'] as const,
  notifications: (userId: string) => ['notifications', userId] as const,
  currentGeneration: (userId: string) => ['current-generation', userId] as const,
  generationTask: (jobId: string) => ['generation-task', jobId] as const,
  coveredCities: ['covered-cities'] as const,
  trips: ['trips'] as const,
  trip: (id: string) => ['trips', id] as const,
  conversation: (id: string) => ['conversations', id] as const,
  healthCheck: (tripId: string) => ['health-check', tripId] as const,
  tripVersions: (id: string) => ['trips', id, 'versions'] as const,
};

export function useAuthConfig() {
  return useQuery({
    queryKey: keys.authConfig,
    queryFn: () => api.get<AuthConfigView>('/api/auth/config'),
    staleTime: 10 * 60_000,
  });
}

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    // 服务端对未登录返回 200 + null，避免 401 在浏览器控制台留下报错
    queryFn: ({ signal }) => api.get<MeView | null>('/api/auth/me', { auth: 'public', signal }),
    retry: shouldRetryQuery,
    staleTime: 5 * 60_000,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginBody) => api.post<MeView>('/api/auth/login', body, { auth: 'public' }),
    onSuccess: () => { resetAuthState(); return qc.invalidateQueries(); },
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RegisterBody) => api.post<MeView>('/api/auth/register', body, { auth: 'public' }),
    onSuccess: () => { resetAuthState(); return qc.invalidateQueries(); },
  });
}

/** 发送邮箱验证码（10-18）：注册与找回密码共用 */
export function useSendEmailCode() {
  return useMutation({
    mutationFn: (body: EmailCodeBody) => api.post<{ ok: boolean }>('/api/auth/email-code', body, { auth: 'public' }),
  });
}

/** 凭邮箱验证码重置密码；成功后该用户全部会话作废 */
export function usePasswordReset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PasswordResetBody) => api.post<{ ok: boolean }>('/api/auth/password-reset', body, { auth: 'public' }),
    onSuccess: () => { resetAuthState(); return qc.invalidateQueries(); },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ ok: true }>('/api/auth/logout'),
    onSuccess: async () => {
      await qc.cancelQueries();
      // 公共布局退出后仍挂载，显式发布访客快照以更新导航。
      qc.setQueryData(keys.me, null);
      qc.removeQueries({ predicate: (query) => query.queryKey[0] !== keys.me[0] });
    },
  });
}

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: () => api.get<SettingsView>('/api/settings') });
}

function parseTravelPreferences(value: unknown): TravelPreferences {
  if (!Value.Check(TravelPreferencesSchema, value)) throw new Error('偏好设置格式异常，请重试');
  return value;
}

export function useTravelPreferences(userId: string) {
  return useQuery({
    queryKey: keys.travelPreferences(userId),
    queryFn: async ({ signal }) => parseTravelPreferences(await api.get<unknown>('/api/settings/travel-preferences', { signal })),
    enabled: Boolean(userId),
    staleTime: Infinity,
  });
}

export function useSaveTravelPreferences(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    scope: { id: `travel-preferences-${userId}` },
    mutationFn: async (body: TravelPreferences) => {
      // 排队期间会话可能已失效；旧账号草稿不能借新账号的 cookie 发出。
      if (qc.getQueryData<MeView>(keys.me)?.id !== userId) throw new Error('账号已切换，请重新加载偏好');
      return parseTravelPreferences(await api.put<unknown>('/api/settings/travel-preferences', body));
    },
    onSuccess: (view) => {
      if (qc.getQueryData<MeView>(keys.me)?.id === userId) qc.setQueryData(keys.travelPreferences(userId), view);
    },
  });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsPut) => api.put<SettingsView>('/api/settings', body),
    onSuccess: (view) => {
      qc.setQueryData(keys.settings, view);
      qc.invalidateQueries({ queryKey: keys.sourcesStatus });
      qc.invalidateQueries({ queryKey: ['route-options'] });
    },
  });
}

export function useUsage(enabled = true) {
  return useQuery({ queryKey: keys.usage, enabled, queryFn: () => api.get<UsageView>('/api/usage') });
}

/** 已覆盖城市列表（09-26 首页城市选择）：只在离线采集导入时变化，长缓存 */
export function useCoveredCities() {
  return useQuery({
    queryKey: keys.coveredCities,
    queryFn: () => api.get<CoveredCitiesView>('/api/destinations/covered'),
    staleTime: 10 * 60_000,
  });
}

/** 列表页三个筛选条件（10-03）：在服务端生效，任一变化都会回到第一批 */
export interface TripListFilters {
  q: string;
  city: string;
  sort: TripListSort;
}

export function useTrips(filters: TripListFilters) {
  return useInfiniteQuery({
    queryKey: [...keys.trips, 'list', filters],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ offset: String(pageParam), limit: String(TRIP_LIST_PAGE_SIZE), sort: filters.sort });
      if (filters.q.trim()) params.set('q', filters.q.trim());
      if (filters.city) params.set('city', filters.city);
      return api.get<TripListPage>(`/api/trips?${params.toString()}`);
    },
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce((count, page) => count + page.items.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });
}

export function useTrip(id: string, enabled = true) {
  return useQuery({ queryKey: keys.trip(id), queryFn: () => api.get<Trip>(`/api/trips/${id}`), enabled: enabled && Boolean(id) });
}

/** 版本链（详情页版本切换）。只有一版时也要请求：用它判断要不要显示切换器 */
export function useTripVersions(id: string) {
  return useQuery({
    queryKey: keys.tripVersions(id),
    queryFn: () => api.get<TripVersionChain>(`/api/trips/${id}/versions`),
    enabled: Boolean(id),
  });
}

// ---------- 行程体检（行前精细化） ----------
export function useHealthCheck(tripId: string) {
  return useQuery({
    queryKey: keys.healthCheck(tripId),
    queryFn: () => api.get<HealthCheckView>(`/api/trips/${tripId}/health-check/latest`),
    enabled: Boolean(tripId),
    retry: false,   // 404 = 尚未体检，不重试
  });
}

export function useStartHealthCheck(tripId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<HealthCheckView>(`/api/trips/${tripId}/health-check`, {}),
    onSuccess: (view) => { qc.setQueryData(keys.healthCheck(tripId), view); },
  });
}

export function useVerifyFinding(tripId: string, checkId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (findingId: string) =>
      api.post<HealthCheckView>(`/api/trips/${tripId}/health-check/${checkId}/findings/${findingId}/verify`, {}),
    onSuccess: (view) => { qc.setQueryData(keys.healthCheck(tripId), view); },
  });
}

export function useResolveHealthCheck(tripId: string, checkId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: HealthDecisionsRequest) =>
      api.post<HealthCheckView>(`/api/trips/${tripId}/health-check/${checkId}/decisions`, body),
    onSuccess: (view) => {
      qc.setQueryData(keys.healthCheck(tripId), view);
      void qc.invalidateQueries({ queryKey: keys.trips });
      void qc.invalidateQueries({ queryKey: keys.tripVersions(tripId) });
    },
  });
}

export function useImportTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: TripExport) => api.post<Trip>('/api/trips', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.trips }),
  });
}

export function useSaveTrip() {
  const qc = useQueryClient();
  return useMutation({
    scope: { id: 'editor-trip-save' },
    mutationFn: (trip: Trip) => api.put<Trip>(`/api/trips/${trip.id}`, trip),
    onSuccess: (trip) => { qc.setQueryData(keys.trip(trip.id), trip); },
  });
}

export function useRenameTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      api.patch<{ ok: true }>(`/api/trips/${id}/title`, { title }),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: keys.trips });
      qc.invalidateQueries({ queryKey: keys.trip(id) });
    },
  });
}

export function useDeleteTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<{ ok: true }>(`/api/trips/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.trips }),
  });
}

// ---------- 智能生成（C3） ----------

/** 单个调研数据源自检状态（服务端 integrations/sourceStatus 同形状） */
export interface SourceStatusView {
  configured: boolean;
  checked: boolean;
  ok: boolean | null;   // null = 未配置（无从探测）
  message: string;
}

export interface SourcesStatusView {
  /** POI 搜索链：**固定天地图**（配额分工，与 Key 自动决策无关） */
  searchProvider: 'amap';
  /** 路线规划 + 地理编码链：高德优先，缺 AMAP_KEY 时降级天地图；'null' = 无凭据 */
  routeProvider: 'amap' | 'null';
  /** POI 搜索源自检（原字段名 `geo`，内容一直是 POI 源） */
  poi: SourceStatusView;
  websearch: SourceStatusView;
}

/**
 * 生成请求：既有表单 + 对话来源标注。
 * conversationId / kind / targetTripId 都是可选的（表单入口全不传）；
 * kind=revision 时必须带 targetTripId，服务端会校验行程归属。
 */
export type GenerationRequest = GenerateForm & {
  conversationId?: string;
  kind?: 'generation' | 'revision';
  targetTripId?: string;
};

export function useStartGeneration() {
  return useMutation({
    mutationFn: (form: GenerationRequest) => api.post<{ jobId: string }>('/api/generations', form),
  });
}

const CANCEL_STATUS_POLL_INTERVAL_MS = 250;
const CANCEL_STATUS_POLL_ATTEMPTS = 40;

interface CancelGenerationResponse {
  ok: boolean;
  status?: GenerationJobStatus;
}

function cancellationStatusError(status: GenerationJobStatus): Error {
  const statusLabel = status === 'done' ? '已完成' : status === 'error' ? '已失败' : status;
  return new Error(`任务${statusLabel}，无法取消`);
}

async function cancelGenerationAndWait(jobId: string): Promise<GenerationJobView> {
  const response = await api.post<CancelGenerationResponse>(`/api/generations/${jobId}/cancel`);
  if (!response.ok && response.status && response.status !== 'cancelled') {
    throw cancellationStatusError(response.status);
  }

  for (let attempt = 0; attempt < CANCEL_STATUS_POLL_ATTEMPTS; attempt += 1) {
    const snapshot = await fetchJobSnapshot(jobId);
    if (snapshot.status === 'cancelled') return snapshot;
    if (snapshot.status !== 'running') throw cancellationStatusError(snapshot.status);
    await new Promise<void>((resolve) => setTimeout(resolve, CANCEL_STATUS_POLL_INTERVAL_MS));
  }

  throw new Error('取消请求已接受，但状态确认超时，请重试');
}

export function useCancelGeneration() {
  return useMutation({
    mutationFn: cancelGenerationAndWait,
  });
}

/** 刷新恢复：查任务快照（404 = 任务过期） */
export async function fetchJobSnapshot(jobId: string): Promise<GenerationJobView> {
  const data = await api.get<unknown>(`/api/generations/${encodeURIComponent(jobId)}`);
  if (!Value.Check(GenerationJobViewSchema, data)) throw new Error('生成进度格式异常，请重试');
  return data;
}

export function useCurrentGeneration(userId: string, enabled = true) {
  return useQuery({
    queryKey: keys.currentGeneration(userId),
    queryFn: async ({ signal }) => {
      const data = await api.get<unknown>('/api/generations/current', { signal });
      if (data === null) return null;
      if (!Value.Check(GenerationJobViewSchema, data)) throw new Error('生成进度暂时无法读取');
      return data;
    },
    // 本查询的唯一用途是「首次发现并认领孤儿任务」；一旦已在跟踪某个任务（run.jobId 有值），
    // 它的数据不再被读取（消费条件要求 jobId 不一致），关掉可免去生成全程的无谓请求。
    enabled: Boolean(userId) && enabled,
    staleTime: 30_000,
    // 60 秒低频轮询作兜底：手动清缓存漏了也能在一个周期内自愈。有任务在跟踪时查询被禁用，
    // 轮询不生效，生成全程零请求。
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/** 任务卡的状态来源：运行中 3s 轮询，终态停止。 */
export function useGenerationTask(jobId: string | undefined) {
  return useQuery({
    queryKey: keys.generationTask(jobId ?? ''),
    queryFn: async ({ signal }) => {
      const data = await api.get<unknown>(`/api/generations/${encodeURIComponent(jobId!)}`, { signal });
      if (!Value.Check(GenerationJobViewSchema, data)) throw new Error('任务状态格式异常，请重试');
      return data;
    },
    enabled: Boolean(jobId),
    refetchInterval: (query) => (query.state.data?.status === 'running' || !query.state.data ? 3_000 : false),
  });
}

export interface GenerationAgentNode {
  stage: 'research' | 'plan' | 'review';
  label: string;
  status: 'running' | 'done' | 'error';
  total: number;
  completed: number;
  durationMs: number;
}

/** 主 Agent 对话里的子 Agent 节点：任务运行中轮询，终态后只读缓存。 */
export function useGenerationAgents(jobId: string | undefined, running: boolean) {
  return useQuery({
    queryKey: ['generation-agents', jobId ?? ''] as const,
    queryFn: ({ signal }) => api.get<{ agents: GenerationAgentNode[] }>(`/api/generations/${encodeURIComponent(jobId!)}/agents`, { signal }),
    enabled: Boolean(jobId),
    refetchInterval: running ? 3_000 : false,
    staleTime: 10_000,
  });
}

export function useNotifications(userId: string) {
  return useInfiniteQuery({
    queryKey: keys.notifications(userId), initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam, signal }): Promise<NotificationPage> => {
      const query = pageParam === undefined ? '' : `?before=${pageParam}`;
      const data = await api.get<unknown>(`/api/notifications${query}`, { signal });
      if (!Value.Check(NotificationPageSchema, data)) throw new Error('通知暂时无法读取，请重试');
      return data;
    },
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(userId), refetchInterval: 60_000, refetchOnWindowFocus: true,
  });
}

export function useReadNotifications(userId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: { id: string } | { through: number }) => 'id' in target
      ? api.post<{ ok: true }>(`/api/notifications/${encodeURIComponent(target.id)}/read`)
      : api.post<{ ok: true }>('/api/notifications/read-all', target),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.notifications(userId) }),
  });
}

// ---------- 会话（首页胶囊 / 编辑器内嵌对话） ----------

/** 会话详情（ChatPanel 读历史消息）：只读，写入走 detailChat 的流式接口 */
export function useConversation(id: string | null) {
  return useQuery({
    queryKey: keys.conversation(id ?? ''),
    queryFn: () => api.get<ConversationDetail>(`/api/conversations/${id}`),
    enabled: Boolean(id),
  });
}

/** 行程 → 来源会话反查（编辑器内嵌对话用）；无关联会话时 conversationId 为 null */
export function useTripConversation(tripId: string | null) {
  return useQuery({
    queryKey: ['trips', tripId ?? '', 'conversation'] as const,
    queryFn: () => api.get<{ conversationId: string | null }>(`/api/trips/${tripId}/conversation`),
    enabled: Boolean(tripId),
  });
}

/** 惰性建会话：只在真正要发第一条消息/发起表单生成时创建，不在页面挂载时就留下空会话行 */
export function useCreateConversation() {
  return useMutation({
    mutationFn: (title?: string) => api.post<Conversation>('/api/conversations', title ? { title } : {}),
  });
}

/** 首页发起生成前把整包 Brief 写进会话留档：只落 Brief，不产生对话消息 */
export function useSaveBriefSnapshot() {
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: PlanningBriefPatch }) =>
      api.patch<{ brief: PlanningBriefView }>(`/api/conversations/${id}/brief?snapshot=1`, patch),
  });
}

export function useSourcesStatus(enabled: boolean) {
  return useQuery({
    queryKey: keys.sourcesStatus,
    queryFn: () => api.get<SourcesStatusView>('/api/settings/sources-status', { timeoutMs: 90_000 }),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

export interface ParsedPromptResult {
  destination: string;
  days: number;
  startDate: string;
  endDate: string;
  pace: TripPace;
  partySize: number;
  preferences: string[];
  extraNotes: string;
  reply: string;
}

/** 首页自然语言意图理解：输入一句话自动抽取行程要素并返回顾问回复 */
export function useParsePrompt() {
  return useMutation({
    mutationFn: (body: { prompt: string; current?: Record<string, unknown> }) =>
      api.post<ParsedPromptResult>('/api/chat/parse-prompt', body, { auth: 'public' }),
  });
}
