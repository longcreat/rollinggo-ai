import { Type } from '@sinclair/typebox';
import { TripWeatherSchema } from './weather';
import { PersonalTripAdviceSchema } from './tripAdvice';
import { StringEnum } from './typebox';
import {
  ACTIVITY_CATEGORIES,
  BUDGET_LEVELS,
  COORD_SOURCES,
  COORD_SYSTEMS,
  DATA_SOURCE_KINDS,
  LEG_MODES,
  LEG_SOURCES,
  MAX_OVERVIEW_POIS,
  MAX_SOURCE_NOTES,
  MAX_TRIP_DAYS,
  PACE_OPTIONS,
  PHOTO_SOURCES,
  POI_CATEGORIES,
  PREFERENCE_OPTIONS,
  RESERVATION_STATUSES,
  TRANSPORT_MODES,
  TRIP_EXPORT_VERSION,
} from './constants';

// 字符串枚举辅助：字面量 Union（标准 TypeBox 构造，类型收窄为字面量联合）
// 定义见 ./typebox（chat.ts 共用同一构造，避免两套字面量 Union 写法漂移）

// ---------- 行程领域 ----------

export const SourceNoteSchema = Type.Object({
  title: Type.String({ maxLength: 100 }),
  url: Type.String({ maxLength: 300 }),
});

export const ActivitySchema = Type.Object({
  id: Type.String(),
  canonicalPlaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  poiKey: Type.Optional(Type.String({ maxLength: 200 })),
  name: Type.String({ minLength: 1, maxLength: 100 }),
  startTime: Type.String({ maxLength: 5 }),   // "09:00"，允许空串
  endTime: Type.String({ maxLength: 5 }),
  description: Type.String({ maxLength: 500 }),
  lat: Type.Number({ minimum: -90, maximum: 90 }),
  lng: Type.Number({ minimum: -180, maximum: 180 }),
  coordSource: StringEnum(COORD_SOURCES),
  coordSystem: Type.Optional(StringEnum(COORD_SYSTEMS)),   // 缺省 = wgs84（旧数据兼容），新生成一律 gcj02
  cost: Type.Optional(Type.Number({ minimum: 0 })),   // 人均粗估档位值（ST3 预算区间化）：免费=0，不确定缺省；旧数据带值照读，读取方 ?? 0 兜底
  category: StringEnum(ACTIVITY_CATEGORIES),
  openTime: Type.Optional(Type.String({ maxLength: 60 })),   // 高德营业时间原文（仅 attraction；闭馆日检测用，非展示文案）
  sourceNotes: Type.Array(SourceNoteSchema, { maxItems: MAX_SOURCE_NOTES }),
});

// 住宿锚点（ST3）：仅作通勤锚点（非酒店推荐）。名称修改后坐标视为失效，需清空并丢弃相关住宿 leg
export const LodgingSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 60 }),
  area: Type.Optional(Type.String({ maxLength: 40 })),
  lat: Type.Optional(Type.Number({ minimum: -90, maximum: 90 })),
  lng: Type.Optional(Type.Number({ minimum: -180, maximum: 180 })),
  coordSystem: Type.Optional(StringEnum(COORD_SYSTEMS)),
});

// 活动间通勤段（v0.5）：以 from/to activityId 关联，活动重排/删除后失配的 leg 视为过期，由消费方过滤
// 哨兵约定（ST3）：fromActivityId/toActivityId 允许哨兵值 'lodging'（leg 挂在 day 上，作用域限当天）——
// {from:'lodging', to:<首活动id>} 表示「从住宿出发」，{from:<末活动id>, to:'lodging'} 表示「返回住宿」
export const TransitLegSchema = Type.Object({
  fromActivityId: Type.String(),
  toActivityId: Type.String(),
  mode: StringEnum(LEG_MODES),
  durationMin: Type.Number({ minimum: 0 }),
  distanceM: Type.Number({ minimum: 0 }),
  source: StringEnum(LEG_SOURCES),                              // amap 真实路径规划 / heuristic 启发式估算
  polyline: Type.Optional(Type.String({ maxLength: 4000 })),    // 「lng,lat;lng,lat…」抽稀后串，超长丢弃
});

export const RouteOptionsRequestSchema = Type.Object({
  mode: Type.Optional(StringEnum(LEG_MODES)),
  refresh: Type.Optional(Type.Boolean()),
  from: ActivitySchema,
  to: ActivitySchema,
  destination: Type.String({ minLength: 1, maxLength: 100 }),
});

export const RouteOptionSchema = Type.Union([
  Type.Object({ status: Type.Literal('available'), leg: TransitLegSchema }),
  Type.Object({ status: Type.Literal('unavailable'), mode: StringEnum(LEG_MODES), reason: Type.String() }),
]);
export const RouteOptionsResponseSchema = Type.Object({
  options: Type.Array(RouteOptionSchema, { minItems: 1, maxItems: 4 }),
});

export const TripDaySchema = Type.Object({
  id: Type.String(),
  dayIndex: Type.Integer({ minimum: 1 }),
  title: Type.String({ maxLength: 30 }),
  activities: Type.Array(ActivitySchema),
  legs: Type.Optional(Type.Array(TransitLegSchema)),   // 可选：旧行程无此字段
  lodging: Type.Optional(LodgingSchema),               // day 级住宿覆盖（多城市场景）；缺省用 Trip 级
});

// 调研候选（行程概览卡片）。照片按图源协议使用本地副本或官方外链；高德图片仍不转存。
export const PhotoAttributionSchema = Type.Object({
  source: StringEnum(PHOTO_SOURCES),
  photographer: Type.String({ minLength: 1, maxLength: 300 }),
  photographerUrl: Type.Optional(Type.String({ maxLength: 1500, pattern: '^https://' })),
  sourceUrl: Type.String({ maxLength: 1500, pattern: '^https://' }),
  license: Type.String({ minLength: 1, maxLength: 80 }),
  licenseUrl: Type.String({ maxLength: 300, pattern: '^https://' }),
  changes: Type.String({ maxLength: 120 }),
});

export const PoiPhotoSchema = Type.Object({
  url: Type.String({ minLength: 1, maxLength: 300, pattern: '^(https?://|/[^/])' }),
  attribution: Type.Optional(PhotoAttributionSchema),
});

export const ResearchPoiSchema = Type.Object({
  id: Type.String(),
  canonicalPlaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  name: Type.String({ minLength: 1, maxLength: 100 }),
  category: StringEnum(POI_CATEGORIES),
  coverUrl: Type.Optional(Type.String({ maxLength: 300 })),        // 预览图热链，可能失效（前端 onerror 兜底）
  coverAttribution: Type.Optional(PhotoAttributionSchema),
  photos: Type.Optional(Type.Array(PoiPhotoSchema, { minItems: 1, maxItems: 3 })), // 含首选封面，按选片顺序；旧行程仍可仅有 coverUrl
  intro: Type.String({ maxLength: 200 }),
  reservation: StringEnum(RESERVATION_STATUSES),                    // 预约三态，「以官方为准」
  reservationNote: Type.Optional(Type.String({ maxLength: 120 })),  // 预约渠道说明
  openTime: Type.Optional(Type.String({ maxLength: 60 })),          // 高德营业时间原文（add_candidate 自动回填，仅 attraction 用于闭馆日检测）
  sourceLinks: Type.Array(SourceNoteSchema, { maxItems: MAX_SOURCE_NOTES }),
});

export const TripMetaSchema = Type.Object({
  usedXhs: Type.Boolean(),   // 历史兼容：小红书时代旧行程可为 true，新生成恒 false
  reviewNotes: Type.Array(Type.String({ maxLength: 200 })),
  advice: Type.Optional(PersonalTripAdviceSchema),
  // 本次生成实际用到的外部数据源（可选：旧行程无此字段）
  dataSources: Type.Optional(Type.Array(StringEnum(DATA_SOURCE_KINDS), { maxItems: 2 })),
});

export const TripSchema = Type.Object({
  id: Type.String(),
  title: Type.String({ minLength: 1, maxLength: 60 }),
  destination: Type.String({ minLength: 1, maxLength: 40 }),
  startDate: Type.String({ maxLength: 10 }),  // "2026-07-10" 或 ''
  budgetLevel: StringEnum(BUDGET_LEVELS),
  totalBudget: Type.Number({ minimum: 0 }),
  preferences: Type.Array(Type.String({ maxLength: 10 }), { maxItems: 10 }),
  partySize: Type.Integer({ minimum: 1, maximum: 50 }),
  extraNotes: Type.String({ maxLength: 200 }),
  transportMode: Type.Optional(StringEnum(TRANSPORT_MODES)),   // 出行方式基调（缺省 transit；持久化供未来重排复用）
  lodging: Type.Optional(LodgingSchema),                       // Trip 级住宿锚点（day 级可覆盖）
  days: Type.Array(TripDaySchema, { maxItems: MAX_TRIP_DAYS }),
  // 调研候选池（行程概览页数据；可选：旧行程无此字段）
  overview: Type.Optional(Type.Array(ResearchPoiSchema, { maxItems: MAX_OVERVIEW_POIS })),
  weather: Type.Optional(TripWeatherSchema),
  meta: TripMetaSchema,
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});

// JSON 导出/导入格式
export const TripExportSchema = Type.Object({
  version: Type.Literal(TRIP_EXPORT_VERSION),
  trip: TripSchema,
});

export const TripShareImageStyleSchema = StringEnum(['journal', 'ink'] as const);
export const TripShareImageRequestSchema = Type.Object({
  trip: TripSchema,
  // 缺省 journal：旧前端/旧请求行为不变
  style: Type.Optional(TripShareImageStyleSchema),
  // 仅显式重新生成时绕过成品缓存，仍合并同一张图的进行中请求。
  regenerate: Type.Optional(Type.Boolean()),
});
// 成品已落盘并由 /media/ 托管：默认返回站内路径，`MEDIA_BASE_URL` 指向 CDN 时返回其绝对地址。
// 文件名是图片内容的 sha256，浏览器可长期缓存，前端也能直接用 <img src>；下载要自己取字节（跨域下 a[download] 会被忽略）。
export const SHARE_POSTER_URL_PATTERN = '^(?:https?://[A-Za-z0-9.-]+(?::\\d+)?)?/media/share-posters/[a-f0-9]{64}\\.(png|jpg|webp)$';
export const TripShareImageResponseSchema = Type.Object({
  url: Type.String({ maxLength: 256, pattern: SHARE_POSTER_URL_PATTERN }),
  mimeType: StringEnum(['image/png', 'image/jpeg', 'image/webp'] as const),
});
// 缺省 journal：与 POST 生成请求的风格缺省保持一致
export const TripShareImageQuerySchema = Type.Object({
  style: Type.Optional(TripShareImageStyleSchema),
});

// ---------- 生成表单 ----------

export const GenerateFormSchema = Type.Object({
  destination: Type.String({ minLength: 1, maxLength: 40 }),
  days: Type.Integer({ minimum: 1, maximum: MAX_TRIP_DAYS }),
  startDate: Type.String({ maxLength: 10, default: '' }),
  budgetLevel: StringEnum(BUDGET_LEVELS),
  totalBudget: Type.Number({ minimum: 0, default: 0 }),
  preferences: Type.Array(StringEnum(PREFERENCE_OPTIONS), { maxItems: 7, default: [] }),
  partySize: Type.Integer({ minimum: 1, maximum: 20 }),
  extraNotes: Type.String({ maxLength: 200, default: '' }),
  transportMode: Type.Optional(StringEnum(TRANSPORT_MODES)),         // 出行方式基调（缺省 transit）
  pace: Type.Optional(StringEnum(PACE_OPTIONS)),                     // 旅行节奏（缺省 moderate，决定每日景点密度）
  lodging: Type.Optional(Type.String({ maxLength: 60 })),            // 住宿位置（可选，酒店名或大致区域）；留空时由规划 Agent 建议一个区域
});

// ---------- 认证与设置 ----------

export const TravelPreferencesSchema = Type.Object({
  preferences: Type.Array(StringEnum(PREFERENCE_OPTIONS), { maxItems: 7, uniqueItems: true }),
  transportMode: StringEnum(TRANSPORT_MODES),
  pace: Type.Union([StringEnum(PACE_OPTIONS), Type.Null()], { default: null }),  // 最近一次选的旅行节奏；null = 还没选过
  partySize: Type.Integer({ minimum: 1, maximum: 20, default: 2 }),             // 最近一次的同行人数
  extraNotes: Type.String({ maxLength: 200 }),
}, { additionalProperties: false });

/** 邮箱格式：后端 schema 与前端表单共用一个正则，避免两处写法漂移。
 * 只做基本形状校验（本地部分@域名.后缀），不验证可达性。 */
export const EMAIL_PATTERN = '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$';
export const EMAIL_MAX_LENGTH = 100;
const EmailSchema = Type.String({
  pattern: EMAIL_PATTERN,
  maxLength: EMAIL_MAX_LENGTH,
});

export const RegisterBodySchema = Type.Object({
  email: EmailSchema,
  password: Type.String({ minLength: 8, maxLength: 72 }),
  inviteCode: Type.Optional(Type.String({ maxLength: 64 })),   // 仅 REGISTRATION_MODE=invite 时服务端校验
  code: Type.Optional(Type.String({ pattern: '^\\d{6}$' })),     // 仅 REGISTRATION_MODE=open 时必填（邮箱验证码）
});

export const LoginBodySchema = Type.Object({
  email: EmailSchema,
  password: Type.String({ minLength: 1, maxLength: 72 }),
});

/** 邮箱验证码用途：注册 / 重置密码。两种用途的验证码互不通用。 */
export const EMAIL_CODE_PURPOSES = ['register', 'reset'] as const;

/** 发送邮箱验证码（10-18）：open 模式注册与找回密码共用 */
export const EmailCodeBodySchema = Type.Object({
  email: EmailSchema,
  purpose: StringEnum(EMAIL_CODE_PURPOSES),
});

/** 凭验证码重置密码；成功后该用户全部会话作废 */
export const PasswordResetBodySchema = Type.Object({
  email: EmailSchema,
  code: Type.String({ pattern: '^\\d{6}$' }),
  password: Type.String({ minLength: 8, maxLength: 72 }),
});

export const SettingsPutSchema = Type.Object({
  byokEnabled: Type.Boolean(),
  baseUrl: Type.Optional(Type.String({ maxLength: 200 })),
  apiKey: Type.Optional(Type.String({ maxLength: 200 })),   // 不传 = 保留原 Key
  model: Type.Optional(Type.String({ maxLength: 100 })),
  amapApiKey: Type.Optional(Type.String({ maxLength: 200 })), // 不传或空串 = 保留个人高德 Key
  clearAmapApiKey: Type.Optional(Type.Boolean()),             // 显式清除，避免空输入语义歧义
  searchApiKey: Type.Optional(Type.String({ maxLength: 200 })), // 不传或空串 = 保留个人搜索 Key
  searchApiBaseUrl: Type.Optional(Type.String({ maxLength: 200 })),
  clearSearchConfig: Type.Optional(Type.Boolean()),             // 显式同时清除个人搜索 Key 与 Base URL
});

export const RenameTripSchema = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 60 }),
});
