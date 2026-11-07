import { bigserial, boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, vector } from 'drizzle-orm/pg-core';
import type { AgentQuestion, AgentQuestionAnswer, DataSourceKind, GenerationWarning, TripShareImageStyle } from '@tripweaver/shared';

export const amapServiceUsage = pgTable('amap_service_usage', {
  day: text('day').notNull(),
  service: text('service').notNull(),
  calls: integer('calls').notNull().default(0),
}, (table) => [primaryKey({ columns: [table.day, table.service] })]);

export const editorGeoUsage = pgTable('editor_geo_usage', {
  day: text('day').notNull(),
  source: text('source').notNull(),
  calls: integer('calls').notNull().default(0),
}, (table) => [primaryKey({ columns: [table.day, table.source] })]);

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),   // OAuth-only 用户为 ''（空串=禁用密码登录）
  githubId: text('github_id'),                     // GitHub 数字 id（唯一索引在 migrate 中建）
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

// 邮箱验证码（10-18）：注册与找回密码共用；purpose 区分用途，验证码互不通用
export const emailVerificationCodes = pgTable('email_verification_codes', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  purpose: text('purpose').notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  attempts: integer('attempts').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export const userSettings = pgTable('user_settings', {
  userId: text('user_id').primaryKey(),
  byokEnabled: boolean('byok_enabled').notNull().default(false),
  baseUrl: text('base_url').notNull().default(''),
  apiKeyCiphertext: text('api_key_ciphertext').notNull().default(''),
  apiKeyLast4: text('api_key_last4').notNull().default(''),
  model: text('model').notNull().default(''),
  amapApiKeyCiphertext: text('amap_api_key_ciphertext').notNull().default(''),
  amapApiKeyLast4: text('amap_api_key_last4').notNull().default(''),
  amapKeyRevision: integer('amap_key_revision').notNull().default(0),
  searchApiKeyCiphertext: text('search_api_key_ciphertext').notNull().default(''),
  searchApiKeyLast4: text('search_api_key_last4').notNull().default(''),
  searchApiBaseUrl: text('search_api_base_url').notNull().default(''),
  searchCredentialRevision: integer('search_credential_revision').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const userTravelPreferences = pgTable('user_travel_preferences', {
  userId: text('user_id').primaryKey(),
  data: jsonb('data').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

export const trips = pgTable('trips', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  title: text('title').notNull(),
  destination: text('destination').notNull(),
  daysCount: integer('days_count').notNull(),
  activityCount: integer('activity_count').notNull(),
  totalCost: integer('total_cost').notNull(),
  usedXhs: boolean('used_xhs').notNull().default(false),
  // 版本链（09-23）：全新生成 root_id = 自身 id / version = 1；对话内修订产出新行，parent_id 指向被修订版本。
  // /trips 列表只展示每条版本链的最新版，历史版本仍可按 id 访问。
  rootId: text('root_id').notNull(),
  version: integer('version').notNull().default(1),
  parentId: text('parent_id'),
  changeSummary: text('change_summary'),
  data: jsonb('data').notNull(),                  // Trip 全量 JSON（唯一事实源，冗余列由其重算）
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

// 账号站内通知独立于内存任务；生成完成与行程写入在同一事务提交。
export const generationNotifications = pgTable('generation_notifications', {
  id: text('id').primaryKey(),
  sequence: bigserial('sequence', { mode: 'number' }).notNull(),
  userId: text('user_id').notNull(),
  jobId: text('job_id').notNull(),
  kind: text('kind').$type<'success' | 'error'>().notNull(),
  tripId: text('trip_id'),
  destination: text('destination').notNull(),
  days: integer('days').notNull(),
  title: text('title').notNull(),
  message: text('message').notNull(),
  jobCreatedAt: timestamp('job_created_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  readAt: timestamp('read_at', { withTimezone: true }),
  shareImageStyle: text('share_image_style').$type<TripShareImageStyle>(),
}, (table) => [
  uniqueIndex('idx_generation_notifications_job').on(table.userId, table.jobId),
  index('idx_generation_notifications_user').on(table.userId, table.sequence),
]);

// 配额计数与用量核算的事实来源
export const generations = pgTable('generations', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  tripId: text('trip_id'),
  // 问答式入口（09-23）：来源会话 / 生成类型 / 修订目标。表单入口时代三列均为空/缺省值。
  conversationId: text('conversation_id'),
  kind: text('kind').notNull().default('generation'),   // generation | revision
  targetTripId: text('target_trip_id'),                 // kind=revision 时指向被修订的行程
  // 任务视图（11-07）：running 行在开始时就写入，重启后仍能读进度/结果。
  jobId: text('job_id'),
  requestId: text('request_id'),
  destination: text('destination'),
  days: integer('days'),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  error: text('error'),
  summary: text('summary'),
  reviewNotes: jsonb('review_notes').$type<string[]>(),
  dataSources: jsonb('data_sources').$type<DataSourceKind[]>(),
  warnings: jsonb('warnings').$type<GenerationWarning[]>(),
  status: text('status').notNull(),               // running | done | error | cancelled
  usedXhs: boolean('used_xhs').notNull().default(false),   // 小红书时代旧数据；新生成恒 false
  usedByok: boolean('used_byok').notNull().default(false),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  xhsCalls: integer('xhs_calls').notNull().default(0),     // 小红书时代旧数据；新生成恒 0
  amapCalls: integer('amap_calls').notNull().default(0),
  searchCalls: integer('search_calls').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

// ---------- RAG 地基（09-18）：已验证地点池 + 调研语料 ----------
// embedding 列：1024 维（站点网关 cf/bge-m3；更换模型需同步 EMBEDDING_DIMS 与重建列）。
// 维度与 EMBEDDING_DIMS 对齐；变更维度需 DROP COLUMN 重建（ALTER 维度不支持原地修改）。
// 本地 PG 未装 pgvector 时列不存在（migrate 降级跳过），字段始终为 null。

export const canonicalPlaces = pgTable(
  'canonical_places',
  {
    id: text('id').primaryKey(),
    city: text('city').notNull(),
    name: text('name').notNull(),
    category: text('category').notNull().default(''),
    lng: doublePrecision('lng'),
    lat: doublePrecision('lat'),
    source: text('source').notNull(),              // goldset | amap | manual ...
    verified: boolean('verified').notNull().default(false),
    embedding: vector('embedding', { dimensions: 1024 }),
    payload: jsonb('payload'),                     // 原始记录（快照活动对象/高德 POI 等）
    /** 景区/片区的子点指向父点；父点自身为 NULL */
    parentId: text('parent_id'),
    /** point = 单点；area = 面状围栏（可带多边形或半径） */
    geomKind: text('geom_kind').notNull().default('point'),
    areaPolygon: jsonb('area_polygon'),            // { ring: "lng,lat|lng,lat|…" }
    areaRadiusM: integer('area_radius_m'),
    centerLng: doublePrecision('center_lng'),
    centerLat: doublePrecision('center_lat'),
    junk: boolean('junk').notNull().default(false),
    /** 坐标去重键：round(lng,4)|round(lat,4)，约 11m 网格 */
    dedupeKey: text('dedupe_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('idx_canonical_places_city_verified').on(table.city, table.verified)],
);

export const researchEvidence = pgTable(
  'research_evidence',
  {
    id: text('id').primaryKey(),
    placeId: text('place_id'),                     // 可空：语料未必能挂到具体地点
    city: text('city').notNull(),
    kind: text('kind').notNull(),                  // 语料类型（攻略/点评/官方说明……）
    strength: text('strength').notNull().default(''), // 证据强度：direct / weak / risk_only（迁移按 kind 回填，外部管线可精细覆盖）
    content: text('content').notNull(),
    sourceUrl: text('source_url').notNull().default(''),
    embedding: vector('embedding', { dimensions: 1024 }),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_research_evidence_city_kind').on(table.city, table.kind),
    index('idx_research_evidence_place').on(table.placeId, table.fetchedAt.desc()),
  ],
);

// ---------- POI 关联对（09-27）：上游 xhs-pipeline 规则挖掘的「常在同天」地点对 ----------
// 无向存储（同一对只有一行，不表达先后）—— 上游 47292c6 明确「顺序由消费端决定」，
// 因此消费端只把它当「同天聚类」信号用（buildChain 距离折扣），绝不当先后硬约束。
// 只存 strength='direct'（≥2 篇笔记支持），见 scripts/seed-xhs-relations.ts。
export const placeRelations = pgTable(
  'place_relation',
  {
    id: text('id').primaryKey(),                  // sha256(city|from|to)[:32]，与导入脚本同算法
    city: text('city').notNull(),
    fromName: text('from_name').notNull(),
    toName: text('to_name').notNull(),
    strength: text('strength').notNull().default('direct'),  // direct | weak（本任务只导入 direct）
    noteCount: integer('note_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_place_relation_city').on(table.city),
    uniqueIndex('uq_place_relation_pair').on(table.city, table.fromName, table.toName),
  ],
);

// ---------- 导出导入记录（09-27）：让「磁盘上的最新版」与「库里已导入的版」可比较 ----------
// 上游是离线批处理，重跑后不会通知消费端；没有这张表就只能靠文件名猜库里是哪一版。
// 实测踩到：默认读 09-22 的导出文件，而上游已是 09-25，故宫博物院的社区分数静默停在旧值。
// 写入方：scripts/seed-xhs-places.ts / seed-xhs-relations.ts（与业务写入同事务）。
// 读取方：scripts/check-data-freshness.ts（只读，不进生成热路径）。
export const dataImports = pgTable(
  'data_import',
  {
    source: text('source').notNull(),            // xhs_places | xhs_relations
    city: text('city').notNull(),
    contentHash: text('content_hash').notNull(), // sha256(文件字节)[:32]，与 scripts/lib/exportFiles.ts 同算法
    filePath: text('file_path').notNull().default(''),  // 文件名（便于人工回查是哪份导出的）
    rowCount: integer('row_count').notNull().default(0),
    importedAt: timestamp('imported_at', { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.source, table.city] })],
);

// ---------- 问答式行程生成入口（09-23） ----------
// 对话只收集参数与更新 Brief，正式生成仍写 generations。
// 与项目其余表一致：不建外键，靠 user_id 谓词做所有权过滤（见 spec/server/backend/security-guidelines.md）。

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    title: text('title').notNull(),                 // 首条用户消息截断，可改名
    status: text('status').notNull().default('active'),   // active | archived
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('idx_conversations_user').on(table.userId, table.updatedAt)],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    conversationId: text('conversation_id').notNull(),
    userId: text('user_id').notNull(),              // 冗余以支持直接的所有权过滤，避免每次鉴权都要 join
    role: text('role').notNull(),                   // user | assistant
    content: text('content').notNull(),
    sequence: integer('sequence').notNull(),        // 会话内自增，前端据此稳定排序
    intake: jsonb('intake'),                        // 遗留列：追问控件已下线（10-17），历史消息仍可能带值
    relatedTripId: text('related_trip_id'),         // 该轮产出的行程（修订/生成结果卡片用）
    attachment: jsonb('attachment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('idx_chat_messages_conversation').on(table.conversationId, table.sequence)],
);

// HITL 问答审计：问题产生即落库，回答/超时原地更新。进程内的 Promise 仍只活在当前回合；
// 重启后 pending 行统一标 expired，用户不会看到一张永远答不上的问题卡。
export const agentQuestions = pgTable(
  'agent_questions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    requestId: text('request_id').notNull(),
    questions: jsonb('questions').$type<AgentQuestion[]>().notNull(),
    status: text('status').notNull(),                 // pending | answered | expired
    answers: jsonb('answers').$type<AgentQuestionAnswer[]>(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_agent_questions_conversation').on(table.conversationId, table.status),
    index('idx_agent_questions_user').on(table.userId, table.createdAt),
  ],
);

// 一个会话一份 Brief。missing_fields 不落库——由 shared 的 requiredBriefFields 从 data 派生，避免两处状态漂移。
export const planningBriefs = pgTable('planning_briefs', {
  conversationId: text('conversation_id').primaryKey(),
  userId: text('user_id').notNull(),
  status: text('status').notNull().default('collecting'),   // collecting | ready | submitted | discarded
  data: jsonb('data').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});

// 成功操作与其写入同事务落库；断线重试返回原结果，不重复生成版本或扣对话额度。
export const detailOperations = pgTable('detail_operations', {
  userId: text('user_id').notNull(),
  id: text('id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  result: jsonb('result').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.id] })]);

export const placeIdentityImports = pgTable('place_identity_imports', {
  id: text('id').primaryKey(),
  city: text('city').notNull(),
  contentHash: text('content_hash').notNull(),
  beforeState: jsonb('before_state').notNull(),
  afterState: jsonb('after_state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  rolledBackAt: timestamp('rolled_back_at', { withTimezone: true }),
}, table => [index('idx_place_identity_imports_city').on(table.city, table.createdAt)]);

export const placeRelationSnapshots = pgTable('place_relation_snapshots', {
  city: text('city').primaryKey(), manifest: jsonb('manifest').notNull(), relations: jsonb('relations'),
  availableIds: jsonb('available_ids').notNull().default([]),
});

export const independentPhotoAssignments = pgTable('independent_photo_assignments', {
  city: text('city').notNull(), imageKey: text('image_key').notNull(), inputHash: text('input_hash').notNull(),
  assetKey: text('asset_key').notNull(), entityId: text('entity_id'), entityRevision: integer('entity_revision'),
  revision: integer('revision').notNull(), changeKey: text('change_key').notNull(),
}, table => [primaryKey({ columns: [table.city, table.imageKey] }),
  index('idx_independent_photo_entity').on(table.city, table.entityId), index('idx_independent_photo_asset').on(table.city, table.assetKey)]);

export const independentPhotoChanges = pgTable('independent_photo_changes', {
  changeKey: text('change_key').primaryKey(), city: text('city').notNull(), request: jsonb('request').notNull(),
  beforeState: jsonb('before_state').notNull(), afterState: jsonb('after_state').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(), rolledBackAt: timestamp('rolled_back_at', { withTimezone: true }),
});

// ---------- LLM 请求上下文快照（09-20）：生成流水线每次 API 请求的完整落库 ----------
// 定位「模型不调工具/空响应」类问题的调试事实源；不含 API key（key 走 getApiKey 独立通道）。
export const llmRequestLogs = pgTable(
  'llm_request_logs',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id').notNull(),               // 内存 Job 号（非外键，Job 本身不落库）
    userId: text('user_id').notNull(),
    phase: text('phase').notNull(),                // research | plan | review
    round: integer('round').notNull().default(1),  // 编排-审校轮次（调研恒 1）
    turn: integer('turn').notNull(),               // 阶段内第几次 API 请求（从 1 开始）
    model: text('model').notNull(),
    systemPrompt: text('system_prompt').notNull(),
    messages: jsonb('messages').notNull(),         // 完整消息历史快照
    tools: jsonb('tools').notNull(),               // 完整工具定义快照
    response: jsonb('response'),                   // { stopReason, usage, errorMessage, text }
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('idx_llm_request_logs_job').on(table.jobId),
    index('idx_llm_request_logs_user_time').on(table.userId, table.createdAt),
  ],
);

// ---------- 分享海报成品（10-08）：图片落盘 data/media/share-posters，表只存索引 ----------
// 主键 (trip_id, style) 即「同一行程同一风格只留最新一张」；重新生成覆盖同一行并删掉旧文件。
// prompt_hash 变化说明行程内容已改，旧图不再回显，避免展示与当前行程不符的海报。
// style 取值与 shared 的 TripShareImageStyleSchema 一致（journal | ink）。
export const tripShareImages = pgTable('trip_share_images', {
  tripId: text('trip_id').notNull(),
  style: text('style').$type<'journal' | 'ink'>().notNull(),
  userId: text('user_id').notNull(),
  promptHash: text('prompt_hash').notNull(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, (table) => [primaryKey({ columns: [table.tripId, table.style] })]);

// ---------- 行程详情 Agent（P1）：durable 会话绑定 ----------
// 一个业务会话对应一个 pi-durable conversation；durable 侧的 transcript 才是 Agent 的上下文，
// 这里只存映射，避免把 SQLite 的内部 id 揉进业务表。
// ---------- 行程体检（行前精细化）：体检会话持久化 ----------
export const tripHealthChecks = pgTable('trip_health_checks', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  tripId: text('trip_id').notNull(),
  tripVersion: integer('trip_version').notNull(),
  status: text('status').$type<'pending' | 'completed' | 'expired'>().notNull(),
  findings: jsonb('findings').notNull(),
  decisions: jsonb('decisions'),
  result: jsonb('result'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
}, (table) => [index('idx_trip_health_checks_trip').on(table.userId, table.tripId)]);

export const agentConversations = pgTable('agent_conversations', {
  userId: text('user_id').notNull(),
  conversationId: text('conversation_id').notNull(),
  durableId: integer('durable_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
}, (table) => [primaryKey({ columns: [table.userId, table.conversationId] })]);
