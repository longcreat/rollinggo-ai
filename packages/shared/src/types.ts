import type { Static } from '@sinclair/typebox';
import type { GenerationJobViewSchema } from './notifications';
import type {
  ActivitySchema,
  RouteOptionsRequestSchema,
  RouteOptionsResponseSchema,
  GenerateFormSchema,
  LodgingSchema,
  LoginBodySchema,
  RegisterBodySchema,
  EmailCodeBodySchema,
  PasswordResetBodySchema,
  EMAIL_CODE_PURPOSES,
  ResearchPoiSchema,
  PoiPhotoSchema,
  SettingsPutSchema,
  TravelPreferencesSchema,
  SourceNoteSchema,
  TripDaySchema,
  TripExportSchema,
  TripMetaSchema,
  TripSchema,
  TripShareImageRequestSchema,
  TripShareImageResponseSchema,
  TripShareImageStyleSchema,
  TransitLegSchema,
} from './schemas';
import type {
  ChatMessageSchema,
  ConversationDetailSchema,
  ConversationSchema,
  ConversationTripRefSchema,
  PlanningBriefDataSchema,
  PlanningBriefPatchSchema,
  PlanningBriefViewSchema,
  SendMessageResultSchema,
  TripConstraintDraftSchema,
  TripConstraintSchema,
} from './chat';
import type {
  ACTIVITY_CATEGORIES,
  BRIEF_MISSING_FIELDS,
  BRIEF_STATUSES,
  BUDGET_LEVELS,
  CHAT_MESSAGE_ROLES,
  CONVERSATION_STATUSES,
  CHAT_INTENTS,
  CONSTRAINT_CATEGORIES,
  CONSTRAINT_POLARITIES,
  COORD_SOURCES,
  COORD_SYSTEMS,
  DATA_SOURCE_KINDS,
  GENERATION_KINDS,
  LEG_MODES,
  LEG_SOURCES,
  POI_CATEGORIES,
  RESERVATION_STATUSES,
  TRANSPORT_MODES,
  PACE_OPTIONS,
} from './constants';

// 全部领域类型从 TypeBox schema 派生 —— schema 是唯一事实源
export type SourceNote = Static<typeof SourceNoteSchema>;
export type TravelPreferences = Static<typeof TravelPreferencesSchema>;
export type Activity = Static<typeof ActivitySchema>;
export type RouteOptionsRequest = Static<typeof RouteOptionsRequestSchema>;
export type RouteOptionsResponse = Static<typeof RouteOptionsResponseSchema>;
export type TransitLeg = Static<typeof TransitLegSchema>;
export type Lodging = Static<typeof LodgingSchema>;
export type TripDay = Static<typeof TripDaySchema>;
export type TripMeta = Static<typeof TripMetaSchema>;
export type ResearchPoi = Static<typeof ResearchPoiSchema>;
export type PoiPhoto = Static<typeof PoiPhotoSchema>;
export type Trip = Static<typeof TripSchema>;
export type TripShareImageRequest = Static<typeof TripShareImageRequestSchema>;
export type TripShareImageStyle = Static<typeof TripShareImageStyleSchema>;
export type TripShareImageResponse = Static<typeof TripShareImageResponseSchema>;
export type TripExport = Static<typeof TripExportSchema>;
export type GenerateForm = Static<typeof GenerateFormSchema>;
export type RegisterBody = Static<typeof RegisterBodySchema>;
export type LoginBody = Static<typeof LoginBodySchema>;
export type EmailCodeBody = Static<typeof EmailCodeBodySchema>;
export type PasswordResetBody = Static<typeof PasswordResetBodySchema>;
export type EmailCodePurpose = (typeof EMAIL_CODE_PURPOSES)[number];
export type SettingsPut = Static<typeof SettingsPutSchema>;

// ---------- 问答式行程生成入口（09-23） ----------
export type TripConstraint = Static<typeof TripConstraintSchema>;
export type TripConstraintDraft = Static<typeof TripConstraintDraftSchema>;
export type PlanningBriefData = Static<typeof PlanningBriefDataSchema>;
export type PlanningBriefView = Static<typeof PlanningBriefViewSchema>;
export type PlanningBriefPatch = Static<typeof PlanningBriefPatchSchema>;
export type ChatMessage = Static<typeof ChatMessageSchema>;
export type Conversation = Static<typeof ConversationSchema>;
export type ConversationDetail = Static<typeof ConversationDetailSchema>;
export type ConversationTripRef = Static<typeof ConversationTripRefSchema>;
export type SendMessageResult = Static<typeof SendMessageResultSchema>;

export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
export type ChatMessageRole = (typeof CHAT_MESSAGE_ROLES)[number];
export type BriefStatus = (typeof BRIEF_STATUSES)[number];
export type TripPace = (typeof PACE_OPTIONS)[number];
export type ConstraintCategory = (typeof CONSTRAINT_CATEGORIES)[number];
export type ConstraintPolarity = (typeof CONSTRAINT_POLARITIES)[number];
export type BriefMissingField = (typeof BRIEF_MISSING_FIELDS)[number];
export type GenerationKind = (typeof GENERATION_KINDS)[number];
export type ChatIntent = (typeof CHAT_INTENTS)[number];

export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];
export type BudgetLevel = (typeof BUDGET_LEVELS)[number];
export type CoordSource = (typeof COORD_SOURCES)[number];
export type CoordSystem = (typeof COORD_SYSTEMS)[number];
export type LegMode = (typeof LEG_MODES)[number];
export type LegSource = (typeof LEG_SOURCES)[number];
export type PoiCategory = (typeof POI_CATEGORIES)[number];
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];
export type DataSourceKind = (typeof DATA_SOURCE_KINDS)[number];
export type TransportMode = (typeof TRANSPORT_MODES)[number];

// 派生数据（useMemo/服务端即时计算，不持久化）
// 行程列表条目（服务端冗余列）
export interface TripListItem {
  id: string;
  title: string;
  destination: string;
  daysCount: number;
  activityCount: number;
  totalCost: number;
  usedXhs: boolean;   // 历史兼容：小红书时代旧行程可为 true，新生成恒 false（前端已不再展示）
  /** 版本链上的序号（09-23）：1 = 首版；列表只返回每条链的最新版 */
  version: number;
  createdAt: number;
  updatedAt: number;
}

/** 行程列表排序键（10-03 服务端分页）：与列表页「排序」下拉一一对应 */
export const TRIP_LIST_SORTS = ['updated', 'created', 'name'] as const;
export type TripListSort = (typeof TRIP_LIST_SORTS)[number];

/**
 * 行程列表一页（10-03）：筛选、排序、计数都在服务端算。
 * `destinations` 是该用户全部行程的目的地去重升序，不受筛选影响（供「目的地」下拉）。
 */
export interface TripListPage {
  items: TripListItem[];
  total: number;
  destinations: string[];
}

/** 版本链上的一版（详情页版本切换用） */
export interface TripVersionItem {
  id: string;
  version: number;
  title: string;
  createdAt: number;
  summary?: string;
}

export interface TripVersionChain {
  rootId: string;
  versions: TripVersionItem[];
}

// 用量视图
export interface UsageView {
  usedToday: number;
  dailyLimit: number;
  remaining: number;
  resetAt: number; // 次日零点时间戳（服务器时区）
}

// 已覆盖城市列表（09-26 城市选择首页）：知识库 verified 条数达阈值的城市
export interface CoveredCitiesView {
  cities: string[];
}

// ---------- 智能生成（C2 服务端 / C3 前端共用协议） ----------

export type GenerationPhase = 'exploration' | 'profiling' | 'climate' | 'routing' | 'inspection';
export type GenerationJobStatus = 'running' | 'done' | 'error' | 'cancelled';
/** 取消来源：用户主动取消 vs 整任务超时被系统自动取消（reason 可选以兼容旧事件） */
export type GenerationCancelReason = 'user' | 'timeout';

/** 生成事件载荷；事件由实时层转成投影帧，客户端按 seq 水位补增量或重发快照
 *  兼容说明：xhsEnabled / xhsCalls / usedXhs 为小红书时代的旧前端兼容字段——
 *  xhsEnabled 现语义为「有任一外部调研数据源可用」，xhsCalls 恒 0，usedXhs 恒 false */
export type GenerationEventPayload =
  | { type: 'job_start'; destination: string; /** 任务天数（标题回显用）；旧事件与重放可能缺失，缺失时前端退回 URL 草稿值 */ days?: number; /** 起始日期：直播页合成行程用于日期/天气展示，旧事件可能缺失 */ startDate?: string; xhsEnabled: boolean; dataSources: DataSourceKind[] }
  | { type: 'phase_start'; phase: GenerationPhase; round: number; note?: string }
  | { type: 'phase_end'; phase: GenerationPhase; round: number; summary?: string; durationMs?: number }
  | { type: 'thought'; phase: GenerationPhase; text: string }
  | { type: 'tool_start'; phase: GenerationPhase; toolCallId: string; tool: string; label: string; args: string }
  | { type: 'tool_end'; phase: GenerationPhase; toolCallId: string; tool: string; label: string; summary: string; isError: boolean; durationMs?: number }
  | { type: 'candidate'; poi: ResearchPoi }   // 调研 Agent 每写入一条候选即推送（概览卡片实时长出）
  // 规划 Agent 每排完一天即推送（直播页逐日长出行程与地图点位）；不替代最终落库的 Trip
  | { type: 'plan_day'; dayIndex: number; title?: string; stops: PlanDayEventStop[] }
  | { type: 'highlight'; stage: string; text: string; kind?: 'poi' | 'tip' | 'route' | 'food' }
  // 每次 API 请求结束的轻量结果（不含 prompt 正文）；评测链路用它记录 turn / stopReason / httpStatus
  | { type: 'llm_response'; phase: GenerationPhase; turn: number; stopReason?: string; tokensIn?: number; tokensOut?: number; errorMessage?: string }
  | { type: 'usage'; tokensIn: number; tokensOut: number; xhsCalls: number; amapCalls: number; searchCalls: number }
  | { type: 'job_done'; tripId: string; usedXhs: boolean; dataSources: DataSourceKind[]; reviewNotes: string[]; durationMs?: number }
  | { type: 'job_error'; message: string; durationMs?: number }
  | { type: 'job_cancelled'; reason?: GenerationCancelReason; durationMs?: number };

export interface PlanDayEventStop {
  name: string;
  lat: number;
  lng: number;
  startTime: string;
  endTime: string;
  category: ActivityCategory;
}

/** 服务端事件时间（Unix ms）用于稳定重放耗时；可选以兼容旧事件。 */
export type GenerationEvent = GenerationEventPayload & { at?: number };

/** GET /api/generations/:jobId 快照（刷新恢复用） */
export type GenerationJobView = Static<typeof GenerationJobViewSchema>;
