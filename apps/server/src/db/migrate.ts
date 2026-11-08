// 幂等建表 —— 启动时执行（KISS：本项目规模不引入 drizzle-kit 迁移链）
// PG 方言（09-18 迁移）：CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS；
// pgvector 扩展缺失时降级告警，不阻断启动（本地实例未装 pgvector 时仍可开发）。
import type { Pool } from 'pg';
import { AMAP_SERVICES, amapDay } from '../integrations/amap/services';

// 供受控运维仅迁移独立图库表；启动迁移复用同一组语句。
export const INDEPENDENT_PHOTO_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS independent_photo_assignments (
    city TEXT NOT NULL, image_key TEXT NOT NULL, input_hash TEXT NOT NULL, asset_key TEXT NOT NULL,
    entity_id TEXT, entity_revision INTEGER, revision INTEGER NOT NULL, change_key TEXT NOT NULL,
    PRIMARY KEY(city,image_key), CHECK (revision > 0),
    CHECK ((entity_id IS NULL AND entity_revision IS NULL) OR (entity_id IS NOT NULL AND entity_revision IS NOT NULL AND entity_revision > 0))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_independent_photo_entity ON independent_photo_assignments(city,entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_independent_photo_asset ON independent_photo_assignments(city,asset_key)`,
  `CREATE TABLE IF NOT EXISTS independent_photo_changes (
    change_key TEXT PRIMARY KEY, city TEXT NOT NULL, request JSONB NOT NULL,
    before_state JSONB NOT NULL, after_state JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL, rolled_back_at TIMESTAMPTZ
  )`,
];

export const PLACE_RELATION_SNAPSHOT_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS place_relation_snapshots (
    city TEXT PRIMARY KEY, manifest JSONB NOT NULL, relations JSONB, available_ids JSONB NOT NULL DEFAULT '[]'::jsonb
  )`,
  `ALTER TABLE place_relation_snapshots ADD COLUMN IF NOT EXISTS available_ids JSONB NOT NULL DEFAULT '[]'::jsonb`,
];

const STATEMENTS = [
  ...PLACE_RELATION_SNAPSHOT_STATEMENTS,
  ...INDEPENDENT_PHOTO_STATEMENTS,
  `CREATE TABLE IF NOT EXISTS place_identity_imports (
    id TEXT PRIMARY KEY, city TEXT NOT NULL, content_hash TEXT NOT NULL,
    before_state JSONB NOT NULL, after_state JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL, rolled_back_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_place_identity_imports_city ON place_identity_imports(city, created_at)`,
  `CREATE TABLE IF NOT EXISTS generation_notifications (
    id TEXT PRIMARY KEY, sequence BIGSERIAL NOT NULL,
    user_id TEXT NOT NULL, job_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('success', 'error')), trip_id TEXT,
    destination TEXT NOT NULL, days INTEGER NOT NULL,
    title TEXT NOT NULL, message TEXT NOT NULL,
    job_created_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL,
    read_at TIMESTAMPTZ
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_generation_notifications_job ON generation_notifications(user_id, job_id)`,
  `CREATE INDEX IF NOT EXISTS idx_generation_notifications_user ON generation_notifications(user_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS user_travel_preferences (
    user_id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS detail_operations (
    user_id TEXT NOT NULL, id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, id)
  )`,
  // ---------- 行程详情 Agent（P1）：业务会话 ↔ pi-durable conversation ----------
  `CREATE TABLE IF NOT EXISTS trip_health_checks (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    trip_id TEXT NOT NULL,
    trip_version INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'expired')),
    findings JSONB NOT NULL,
    decisions JSONB,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trip_health_checks_trip ON trip_health_checks(user_id, trip_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS agent_conversations (
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    durable_id INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, conversation_id)
  )`,
  `CREATE TABLE IF NOT EXISTS amap_service_usage (
    day TEXT NOT NULL,
    service TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0 CHECK (calls >= 0),
    PRIMARY KEY (day, service)
  )`,
  `CREATE TABLE IF NOT EXISTS editor_geo_usage (
    day TEXT NOT NULL,
    source TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, source)
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    github_id TEXT,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
  // 邮箱验证码（10-18）：只存 bcrypt 哈希；同一 (email, purpose) 只认最新一条未消费记录
  `CREATE TABLE IF NOT EXISTS email_verification_codes (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    purpose TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_email_codes_lookup ON email_verification_codes(email, purpose, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_email_codes_created ON email_verification_codes(created_at)`,
  `CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT PRIMARY KEY,
    byok_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    base_url TEXT NOT NULL DEFAULT '',
    api_key_ciphertext TEXT NOT NULL DEFAULT '',
    api_key_last4 TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    amap_api_key_ciphertext TEXT NOT NULL DEFAULT '',
    amap_api_key_last4 TEXT NOT NULL DEFAULT '',
    amap_key_revision INTEGER NOT NULL DEFAULT 0,
    search_api_key_ciphertext TEXT NOT NULL DEFAULT '',
    search_api_key_last4 TEXT NOT NULL DEFAULT '',
    search_api_base_url TEXT NOT NULL DEFAULT '',
    search_credential_revision INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS trips (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    destination TEXT NOT NULL,
    days_count INTEGER NOT NULL,
    activity_count INTEGER NOT NULL,
    total_cost INTEGER NOT NULL,
    used_xhs BOOLEAN NOT NULL DEFAULT FALSE,
    root_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    parent_id TEXT,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trips_user ON trips(user_id, updated_at DESC)`,
  // 注意：idx_trips_root / idx_generations_conversation 建在新增列上，不能放在 STATEMENTS——
  // 存量库执行到此处时 root_id / conversation_id 尚未补列，索引创建会失败。它们统一放在 runMigrations 的补列段之后。
  `CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    trip_id TEXT,
    conversation_id TEXT,
    kind TEXT NOT NULL DEFAULT 'generation',
    target_trip_id TEXT,
    job_id TEXT,
    request_id TEXT,
    durable_task_id TEXT,
    agent_conversations JSONB,
    destination TEXT,
    days INTEGER,
    finished_at TIMESTAMPTZ,
    error TEXT,
    summary TEXT,
    review_notes JSONB,
    data_sources JSONB,
    warnings JSONB,
    status TEXT NOT NULL,
    used_xhs BOOLEAN NOT NULL DEFAULT FALSE,
    used_byok BOOLEAN NOT NULL DEFAULT FALSE,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    xhs_calls INTEGER NOT NULL DEFAULT 0,
    amap_calls INTEGER NOT NULL DEFAULT 0,
    search_calls INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_generations_user_time ON generations(user_id, created_at DESC)`,
  // ---------- RAG 地基（09-18）：只建表不实现检索 ----------
  `CREATE TABLE IF NOT EXISTS canonical_places (
    id TEXT PRIMARY KEY,
    city TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    lng DOUBLE PRECISION,
    lat DOUBLE PRECISION,
    source TEXT NOT NULL,
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    payload JSONB,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_canonical_places_city_verified ON canonical_places(city, verified)`,
  `CREATE TABLE IF NOT EXISTS research_evidence (
    id TEXT PRIMARY KEY,
    place_id TEXT,
    city TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    source_url TEXT NOT NULL DEFAULT '',
    fetched_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_research_evidence_city_kind ON research_evidence(city, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_research_evidence_place ON research_evidence(place_id, fetched_at DESC)`,
  // ---------- POI 关联对（09-27）：上游 xhs-pipeline 规则挖掘的无向「常在同天」地点对 ----------
  // 无向存储（同一对只一行），消费端只用作同天聚类的距离折扣信号，不表达先后。
  `CREATE TABLE IF NOT EXISTS place_relation (
    id TEXT PRIMARY KEY,
    city TEXT NOT NULL,
    from_name TEXT NOT NULL,
    to_name TEXT NOT NULL,
    strength TEXT NOT NULL DEFAULT 'direct',
    note_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_place_relation_pair ON place_relation(city, from_name, to_name)`,
  `CREATE INDEX IF NOT EXISTS idx_place_relation_city ON place_relation(city)`,
  // ---------- 导出导入记录（09-27）：判定库里数据对应哪一版导出 ----------
  `CREATE TABLE IF NOT EXISTS data_import (
    source TEXT NOT NULL,
    city TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    file_path TEXT NOT NULL DEFAULT '',
    row_count INTEGER NOT NULL DEFAULT 0,
    imported_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (source, city)
  )`,
  // ---------- LLM 请求上下文快照（09-20） ----------
  `CREATE TABLE IF NOT EXISTS llm_request_logs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    round INTEGER NOT NULL DEFAULT 1,
    turn INTEGER NOT NULL,
    model TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    messages JSONB NOT NULL,
    tools JSONB NOT NULL,
    response JSONB,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_llm_request_logs_job ON llm_request_logs(job_id)`,
  `CREATE INDEX IF NOT EXISTS idx_llm_request_logs_user_time ON llm_request_logs(user_id, created_at DESC)`,
  // ---------- 问答式行程生成入口（09-23） ----------
  `CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id, updated_at DESC)`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    turn_id TEXT,
    task_id TEXT,
    intake JSONB,
    related_trip_id TEXT,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id, sequence)`,
  `CREATE TABLE IF NOT EXISTS agent_questions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    questions JSONB NOT NULL,
    status TEXT NOT NULL,
    answers JSONB,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    answered_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_questions_conversation ON agent_questions(conversation_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_questions_user ON agent_questions(user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS planning_briefs (
    conversation_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'collecting',
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  // ---------- 分享海报成品（10-08）：图片落盘 data/media/share-posters，本表只存索引 ----------
  // 主键 (trip_id, style) 即「同一行程同一风格只留最新一张」。
  `CREATE TABLE IF NOT EXISTS trip_share_images (
    trip_id TEXT NOT NULL,
    style TEXT NOT NULL,
    user_id TEXT NOT NULL,
    prompt_hash TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (trip_id, style)
  )`,
];

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sql of STATEMENTS) await client.query(sql);
    // PG 唯一索引下 NULL 互不冲突，未绑定 GitHub 的用户不受影响
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github ON users(github_id)');
    // 存量库补列（CREATE IF NOT EXISTS 无法给旧表补列）：PG 支持幂等 ADD COLUMN IF NOT EXISTS
    await client.query(`ALTER TABLE generation_notifications ADD COLUMN IF NOT EXISTS share_image_style TEXT`);
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS amap_api_key_ciphertext TEXT NOT NULL DEFAULT ''`);
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS amap_api_key_last4 TEXT NOT NULL DEFAULT ''`);
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS amap_key_revision INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS search_api_key_ciphertext TEXT NOT NULL DEFAULT ''`);
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS search_api_key_last4 TEXT NOT NULL DEFAULT ''`);
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS search_api_base_url TEXT NOT NULL DEFAULT ''`);
    await client.query(`ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS search_credential_revision INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS used_xhs BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS used_xhs BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS used_byok BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS tokens_in INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS tokens_out INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS xhs_calls INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS amap_calls INTEGER NOT NULL DEFAULT 0`);
    // 地图服务商降级（09-25）：天地图调用单独计数，与高德日额度互不影响
    await client.query(`ALTER TABLE generations DROP COLUMN IF EXISTS tianditu_calls`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS search_calls INTEGER NOT NULL DEFAULT 0`);
    // 问答式入口（09-23）：存量库补列。trips.root_id 先补列→回填→置 NOT NULL（单语句 ALTER 无法对存量行建 NOT NULL）。
    // 顺序不可调整：UPDATE 必须在 SET NOT NULL 之前，否则存量库启动失败。
    await client.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS root_id TEXT`);
    await client.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1`);
    await client.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS parent_id TEXT`);
    await client.query(`ALTER TABLE trips ADD COLUMN IF NOT EXISTS change_summary TEXT`);
    await client.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS attachment JSONB`);
    // turn/task 单一事实源（11-08）：同一主 Agent 回合共享 turn_id，同一子 Agent 任务共享 task_id。
    // 存量行没有这两列：turn_id 先按单条消息回填（历史配对已无法还原，UI 分组以 task_id 为准）；
    // task_id 先取委派消息上的附件任务，再按 generations(job_id, conversation_id, trip_id) 关联完成消息。
    await client.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS turn_id TEXT`);
    await client.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS task_id TEXT`);
    await client.query(`UPDATE chat_messages SET turn_id = id WHERE turn_id IS NULL`);
    await client.query(`UPDATE chat_messages SET task_id = attachment->'task'->>'jobId'
      WHERE task_id IS NULL AND attachment ? 'task' AND attachment->'task'->>'jobId' IS NOT NULL`);
    await client.query(`UPDATE chat_messages m SET task_id = g.job_id FROM generations g
      WHERE m.task_id IS NULL AND m.related_trip_id = g.trip_id AND m.conversation_id = g.conversation_id
        AND m.user_id = g.user_id AND g.job_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_chat_messages_task ON chat_messages(conversation_id, task_id)`);
    // 任务卡唯一归属（11-08）：历史完成消息与委派消息重复挂 task，清掉完成消息上的重复引用。
    await client.query(`UPDATE chat_messages SET attachment = attachment - 'task'
      WHERE attachment ? 'task' AND related_trip_id IS NOT NULL
        AND attachment->>'tripId' = related_trip_id`);
    // 历史表单直达的委派消息不再复述条件（可能带错误的「0 天」）。
    await client.query(`UPDATE chat_messages SET content = '已在后台开始规划行程。'
      WHERE content LIKE '条件已齐备：%' AND attachment ? 'task'`);
    // 委派消息只留任务引用：清掉旧文案与工具步骤，对话里只渲染任务节点。
    await client.query(`UPDATE chat_messages SET content = '', attachment = attachment - 'steps'
      WHERE content = '已在后台开始规划行程。' AND attachment ? 'task'`);
    await client.query(`UPDATE trips SET root_id = id WHERE root_id IS NULL`);
    await client.query(`ALTER TABLE trips ALTER COLUMN root_id SET NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_trips_root ON trips(root_id, version DESC)`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS conversation_id TEXT`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'generation'`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS target_trip_id TEXT`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_generations_conversation ON generations(conversation_id)`);
    // 任务视图（11-07）：生成开始即写 running 行，重启后状态/结果仍可读。列全部 nullable，旧代码忽略。
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS job_id TEXT`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS request_id TEXT`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS durable_task_id TEXT`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS agent_conversations JSONB`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS destination TEXT`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS days INTEGER`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS error TEXT`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS summary TEXT`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS review_notes JSONB`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS data_sources JSONB`);
    await client.query(`ALTER TABLE generations ADD COLUMN IF NOT EXISTS warnings JSONB`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_generations_job ON generations(user_id, job_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_generations_request ON generations(user_id, request_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_generations_status ON generations(user_id, status, created_at DESC)`);
    // 并发闸门下沉到数据库：同一用户最多一行 running（存量已结束任务不受影响）。
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_generations_running_user ON generations(user_id) WHERE status='running'`);
    // 景区围栏（11-06）：面状片区 + 子点关系 + 坐标去重键；存量行 dedupe_key 为 NULL，唯一索引只约束新数据。
    await client.query(`ALTER TABLE canonical_places ADD COLUMN IF NOT EXISTS parent_id TEXT`);
    await client.query(`ALTER TABLE canonical_places ADD COLUMN IF NOT EXISTS geom_kind TEXT NOT NULL DEFAULT 'point'`);
    await client.query(`ALTER TABLE canonical_places ADD COLUMN IF NOT EXISTS area_polygon JSONB`);
    await client.query(`ALTER TABLE canonical_places ADD COLUMN IF NOT EXISTS area_radius_m INTEGER`);
    await client.query(`ALTER TABLE canonical_places ADD COLUMN IF NOT EXISTS center_lng DOUBLE PRECISION`);
    await client.query(`ALTER TABLE canonical_places ADD COLUMN IF NOT EXISTS center_lat DOUBLE PRECISION`);
    await client.query(`ALTER TABLE canonical_places ADD COLUMN IF NOT EXISTS junk BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE canonical_places ADD COLUMN IF NOT EXISTS dedupe_key TEXT`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_canonical_places_parent ON canonical_places(city, parent_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_places_dedupe ON canonical_places(city, dedupe_key) WHERE dedupe_key IS NOT NULL`);
    // First rollout only: historical calls cannot be attributed to services. Conservatively
    // charge the recent legacy total to every service; never re-seed on later restarts.
    const { day, start } = amapDay();
    await client.query(`INSERT INTO amap_service_usage (day, service, calls)
      SELECT $1, service, LEAST(2147483647,
        (SELECT COALESCE(SUM(amap_calls), 0) FROM generations WHERE created_at >= $3) +
        (SELECT COALESCE(SUM(calls), 0) FROM editor_geo_usage WHERE source = 'amap' AND day::bigint >= $4))::integer
      FROM unnest($2::text[]) AS service
      WHERE NOT EXISTS (SELECT 1 FROM amap_service_usage)
      ON CONFLICT DO NOTHING`, [day, [...AMAP_SERVICES], new Date(start - 86400_000), String(start - 86400_000)]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // 证据强度分级（09-21）：幂等补列 + 按 kind 确定性回填（仅空值行）；外部管线后续可写入精细标签覆盖默认值
  await pool.query(`ALTER TABLE research_evidence ADD COLUMN IF NOT EXISTS strength TEXT NOT NULL DEFAULT ''`);
  await pool.query(`UPDATE research_evidence SET strength = CASE kind
    WHEN 'xhs_reservation' THEN 'direct'
    WHEN 'xhs_price' THEN 'direct'
    WHEN 'xhs_warning' THEN 'risk_only'
    ELSE 'weak' END
  WHERE strength = ''`);

  // pgvector 是 RAG 前置依赖；本地实例未装扩展时按降级告警处理，不阻断启动（检索能力后续任务再启用）
  let vectorAvailable = false;
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS vector');
    vectorAvailable = true;
  } catch (err) {
    console.warn(
      `[db] pgvector 扩展不可用，RAG 向量检索暂不启用：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // embedding 列依赖 pgvector；扩展可用时幂等补列，不可用时跳过（列保持不存在，读写路径判 null 降级）
  // 数据量 <1000 行时顺序扫描足够快，暂不建 ivfflat/hnsw 向量索引（YAGNI；索引有召回率-性能权衡，行数增长后再加）
  if (vectorAvailable) {
    await pool.query(`ALTER TABLE canonical_places ADD COLUMN IF NOT EXISTS embedding vector(1024)`);
    await pool.query(`ALTER TABLE research_evidence ADD COLUMN IF NOT EXISTS embedding vector(1024)`);
  }

  // llm_request_logs 每次模型请求全量快照落库，是增长最快的调试表；启动时按保留期清扫，
  // 防止长跑实例存储无界增长（11-03 审查：此前全库无一处 delete）。失败只告警不阻断启动。
  try {
    const swept = await pool.query(`DELETE FROM llm_request_logs WHERE created_at < NOW() - INTERVAL '7 days'`);
    if (swept.rowCount) console.log(`[db] llm_request_logs 已清理 ${swept.rowCount} 条（保留 7 天）`);
  } catch (err) {
    console.warn(`[db] llm_request_logs 清理失败（不影响启动）：${err instanceof Error ? err.message : String(err)}`);
  }
}
