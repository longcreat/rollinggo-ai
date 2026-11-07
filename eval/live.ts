import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { MAX_OVERVIEW_POIS, type GenerationEvent, type ResearchPoi } from '@tripweaver/shared';
import { EVAL_DIR, ROOT, hash, writeJson } from './artifacts';
import { createEvaluationDatabase, validateAdminUrl } from './isolation';
import { loadKnowledge, seedKnowledge, type KnowledgeMode } from './knowledge';
import { summarizeFrozen } from './frozenKnowledge';
import type { Execution, Manifest, Snapshot } from './contracts';
import type { GoldenCase } from './golden/cases';
import type { GenerationRunOptions } from '../apps/server/src/generation/orchestrator';

// 仅加载评估所需配置；不加载应用数据库、主密钥、用户凭据或后台图片/天气服务。
const CREDENTIAL_KEYS = ['SITE_LLM_BASE_URL', 'SITE_LLM_API_KEY', 'SITE_LLM_MODEL', 'AMAP_KEY',
  'SEARCH_API_KEY', 'SEARCH_API_BASE_URL', 'EMBEDDING_BASE_URL', 'EMBEDDING_API_KEY', 'EMBEDDING_MODEL'] as const;
export function loadLiveCredentials(): void {
  for (const file of [path.join(ROOT, 'apps/server/.env'), path.join(ROOT, '.env')]) {
    if (!fs.existsSync(file)) continue;
    const values = parse(fs.readFileSync(file));
    for (const key of CREDENTIAL_KEYS) if (process.env[key] === undefined && values[key] !== undefined) process.env[key] = values[key];
  }
}
export function sanitizeError(error: unknown): string {
  let message = error instanceof Error ? error.message : '未知评估错误';
  // 先抹端点，再按环境变量值替换。顺序不能反：数据库口令常是 `postgres` 这种短词，
  // 先替换会把 `postgres://user:password@host` 打成 `[redacted]://user:password@host`，
  // URL 规则就再也匹配不上，密码反而留在结果里（2026-11 由 POSTGRES_PASSWORD=postgres 触发）。
  message = message.replace(/(?:postgres(?:ql)?|https?):\/\/[^\s"'<>]+/g, '[endpoint]');
  for (const [key, value] of Object.entries(process.env)) {
    if (value && /KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL|PG_ADMIN_URL/.test(key)) message = message.split(value).join('[redacted]');
  }
  return message.slice(0, 1200);
}
export function liveConfiguration(allowNoGeo: boolean, timeoutMs: number): Manifest['configuration'] {
  // 只记录主机与路径；禁止 userinfo、query、fragment 中的密钥进入产物。
  const endpoint = new URL(process.env.SITE_LLM_BASE_URL!);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('模型地址仅支持不含凭据、查询参数或片段的 HTTP(S) URL');
  }
  return { model: process.env.SITE_LLM_MODEL!, endpoint: `${endpoint.origin}${endpoint.pathname}`,
    allowNoGeo, timeoutMs, amap: Boolean(process.env.AMAP_KEY),
    search: Boolean(process.env.SEARCH_API_KEY), embeddingModel: process.env.EMBEDDING_MODEL ?? 'cf/bge-m3',
    photos: false, weather: false, modelOptions: 'production runner defaults (runtimeHash)',
    providerCallSemantics: 'accepted wrapper attempts; not billing or confirmed network requests' };
}
export async function startLive(options: {
  directory: string; manifest: Manifest; knowledge: KnowledgeMode; allowNoGeo: boolean; timeoutMs: number;
  knowledgeSnapshot?: string; skipVectors?: boolean; cities?: string[];
}) {
  validateAdminUrl(process.env.EVAL_PG_ADMIN_URL); // 导入任何应用模块前 fail-closed。
  const knowledge = loadKnowledge(options.knowledge, { snapshot: options.knowledgeSnapshot, skipVectors: options.skipVectors, cities: options.cities });
  options.manifest.knowledge = knowledge.manifest;
  if (knowledge.kind === 'frozen') {
    const directory = path.join(options.directory, 'knowledge');
    fs.mkdirSync(directory);
    fs.copyFileSync(path.join(knowledge.directory, 'knowledge.json.gz'), path.join(directory, 'knowledge.json.gz'), fs.constants.COPYFILE_EXCL);
    writeJson(path.join(directory, 'manifest.json'), summarizeFrozen(knowledge.snapshot));
  }
  loadLiveCredentials();
  if (knowledge.kind === 'frozen') {
    const configuredModel = process.env.EMBEDDING_MODEL ?? 'cf/bge-m3';
    if (!knowledge.skipVectors && configuredModel && knowledge.snapshot.data.vectors.configuredModel && configuredModel !== knowledge.snapshot.data.vectors.configuredModel) {
      throw new Error('查询 embedding 模型与冻结副本记录不一致；请对齐模型配置或显式 --skip-vectors');
    }
  }
  if (!process.env.SITE_LLM_BASE_URL || !process.env.SITE_LLM_API_KEY || !process.env.SITE_LLM_MODEL) {
    throw new Error('live 需要 SITE_LLM_BASE_URL / SITE_LLM_API_KEY / SITE_LLM_MODEL');
  }
  if (!options.allowNoGeo && !process.env.AMAP_KEY) throw new Error('live 需要 AMAP_KEY；显式降级可用 --allow-no-geo');
  options.manifest.configuration = liveConfiguration(options.allowNoGeo, options.timeoutMs);
  const lock = path.join(EVAL_DIR, 'data/live.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, runId: options.manifest.runId }), { flag: 'wx' }); }
  catch { throw new Error('已有 live 运行锁：eval/data/live.lock；确认旧进程结束后才可移除失效锁'); }
  let database: Awaited<ReturnType<typeof createEvaluationDatabase>> | undefined;
  let pool: import('pg').Pool | undefined;
  async function close() {
    try {
      try { if (pool) await pool.end(); }
      finally { if (database) await database.close(); }
    } finally { fs.unlinkSync(lock); }
  }
  try {
    database = await createEvaluationDatabase(process.env.EVAL_PG_ADMIN_URL);
    Object.assign(process.env, {
      DATABASE_URL: database.url, MASTER_KEY: crypto.randomBytes(32).toString('hex'),
      DOTENV_CONFIG_PATH: path.join(EVAL_DIR, 'data', `absent-${options.manifest.runId}.env`),
      REGISTRATION_MODE: 'open', GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '',
      IMAGE_API_KEY: '',
      QWEATHER_KEY: '', QWEATHER_JWT_KEY_ID: '', QWEATHER_JWT_DEVELOPER_ID: '', QWEATHER_JWT_PROJECT_ID: '', QWEATHER_JWT_PRIVATE_KEY: '',
      // 配额计数位于专用库。配置独立于应用的额度，避免意外继承高额度。
      AMAP_DAILY_BUDGET: process.env.EVAL_AMAP_DAILY_BUDGET ?? '700',
      SEARCH_DAILY_BUDGET: process.env.EVAL_SEARCH_DAILY_BUDGET ?? '100',
    });
    // 防止 shell 中的应用服务级额度覆盖评估默认值。
    for (const service of ['GEOCODE', 'PLACE', 'WALK', 'CYCLE', 'DRIVE', 'TRANSIT']) {
      process.env[`AMAP_${service}_DAILY_BUDGET`] = process.env[`EVAL_AMAP_${service}_DAILY_BUDGET`] ?? (service === 'PLACE' ? '100' : process.env.EVAL_AMAP_DAILY_BUDGET ?? '700');
    }
    process.env.AMAP_LBS_MONTHLY_BUDGET = '150000';
    process.env.AMAP_SEARCH_MONTHLY_BUDGET = '5000';
    if (knowledge.kind === 'frozen' && knowledge.skipVectors) {
      process.env.EMBEDDING_MODEL = ''; // 显式关闭查询向量，不能偷偷测空列降级。
      options.manifest.configuration.embeddingModel = '';
    }
    for (const key of ['AMAP_GEOCODE_DAILY_BUDGET', 'AMAP_PLACE_DAILY_BUDGET', 'AMAP_WALK_DAILY_BUDGET',
      'AMAP_CYCLE_DAILY_BUDGET', 'AMAP_DRIVE_DAILY_BUDGET', 'AMAP_TRANSIT_DAILY_BUDGET', 'SEARCH_DAILY_BUDGET']) {
      options.manifest.configuration[key] = process.env[key]!;
    }
    await import('../apps/server/src/lib/proxy');
    ({ pool } = await import('../apps/server/src/db/client'));
    await seedKnowledge(pool, knowledge);
    await pool.query(`INSERT INTO users (id,email,password_hash,created_at) VALUES ('eval-user','eval@invalid.local','disabled',NOW())`);
    const { runGeneration } = await import('../apps/server/src/generation/orchestrator');
    const { createJob, observe } = await import('../apps/server/src/generation/jobManager');
    const { getTrip } = await import('../apps/server/src/services/tripService');
    const config = { baseUrl: process.env.SITE_LLM_BASE_URL!, apiKey: process.env.SITE_LLM_API_KEY!, model: process.env.SITE_LLM_MODEL!, byok: false };
    console.log(`live：专用 PostgreSQL｜知识库 ${knowledge.places.length} 地点`);
    return {
      close,
      async generate(gc: GoldenCase, signal: AbortSignal): Promise<Snapshot> {
        const job = createJob('eval-user');
        const candidates: ResearchPoi[] = [];
        const timing: NonNullable<Snapshot['timing']> = { phases: {} };
        const events: object[] = [];
        const execution: Execution = { tasks: {}, planLlmCalls: 0, terminal: 'running', tripReadBack: false, auditCommitted: false, overviewMatches: false };
        let terminalError = '';
        const stop = () => job.abort.abort();
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
        const timeout = setTimeout(() => { job.cancelReason = 'timeout'; stop(); }, options.timeoutMs);
        const unsubscribe = observe(job, (event: GenerationEvent) => {
          if (event.type === 'tool_end') {
            const count = execution.tasks[event.tool] ??= { ok: 0, errors: 0 };
            if (event.isError) count.errors++; else count.ok++;
          }
          if (event.type === 'llm_response' && event.phase === 'plan') execution.planLlmCalls++;
          // 只保留结构化观测，避免原始请求、工具参数或模型异常泄露凭据。
          if (event.type === 'candidate') candidates.push(event.poi);
          if (event.type === 'phase_start') events.push({ type: event.type, phase: event.phase, round: event.round, at: event.at });
          if (event.type === 'phase_end') {
            if (event.durationMs !== undefined) timing.phases[`${event.phase}#${event.round}`] = event.durationMs;
            events.push({ type: event.type, phase: event.phase, round: event.round, durationMs: event.durationMs });
          }
          if (event.type === 'tool_end') events.push({ type: event.type, phase: event.phase, tool: event.tool,
            isError: event.isError, durationMs: event.durationMs });
          if (event.type === 'llm_response') events.push({ type: event.type, phase: event.phase, turn: event.turn,
            stopReason: event.stopReason, hasError: Boolean(event.errorMessage),
            httpStatus: event.errorMessage?.match(/\b([45]\d{2})\b/)?.[1] ?? null });
          if (event.type === 'usage') {
            timing.tokensIn = event.tokensIn; timing.tokensOut = event.tokensOut;
            timing.providerCalls = { amap: event.amapCalls, search: event.searchCalls, xhs: event.xhsCalls };
          }
          if (event.type === 'job_done' || event.type === 'job_error' || event.type === 'job_cancelled') timing.totalMs = event.durationMs;
          if (event.type === 'job_error') terminalError = sanitizeError(new Error(event.message));
          if (event.type === 'job_cancelled') terminalError = event.reason === 'timeout'
            ? `生成超时（单例上限 ${options.timeoutMs}ms），已取消` : '生成已取消';
          if (event.type === 'job_done' || event.type === 'job_error' || event.type === 'job_cancelled') {
            events.push({ type: event.type, at: event.at, ...(event.type === 'job_cancelled' ? { reason: event.reason } : {}) });
          }
        });
        try {
          // 让 live 也走 durable 阶段（writer），真实验证第 6 项的迁移。
          let agentHost: GenerationRunOptions['agent'];
          try {
            const [{ getAgentRuntime }, { buildAgentModels }, { generationStoragePath }, { BACKGROUND_CONTEXT }] = await Promise.all([
              import('../apps/server/src/chat/agent/runtime'),
              import('../apps/server/src/chat/agent/models'),
              import('../apps/server/src/generation/agentStorage'),
              import('@earendil-works/chord/context'),
            ]);
            const runtime = await getAgentRuntime(generationStoragePath('eval-user'));
            runtime.holder.current = await buildAgentModels(config);
            agentHost = { harness: runtime.harness, registry: runtime.registry, context: BACKGROUND_CONTEXT };
          } catch {
            agentHost = undefined;
          }
          await runGeneration(job, gc.form, config, undefined, agentHost ? { agent: agentHost } : {});
          if (!job.tripId || job.status !== 'done') throw new Error(terminalError || `生成终态：${job.status}（可能已取消或超时）`);
          const trip = await getTrip('eval-user', job.tripId);
          if (!trip) throw new Error('生成已完成，但读回行程失败');
          execution.terminal = job.status;
          execution.tripReadBack = true;
          execution.auditCommitted = (await pool!.query(`SELECT id FROM generations WHERE user_id=$1 AND trip_id=$2 AND status='done'`, ['eval-user', trip.id])).rows.length === 1;
          execution.overviewMatches = hash(trip.overview ?? []) === hash(candidates.slice(0, MAX_OVERVIEW_POIS));
          return { schemaVersion: 3, caseId: gc.id, generatedAt: Date.now(), model: config.model, form: gc.form, trip,
            research: { candidates }, timing, execution };
        } finally {
          clearTimeout(timeout); signal.removeEventListener('abort', stop); unsubscribe();
          execution.terminal = job.status;
          writeJson(path.join(options.directory, 'events', `${gc.id}.json`), { terminal: job.status, events, research: { candidates }, timing, execution });
        }
      },
    };
  } catch (error) {
    try { await close(); } catch { throw new Error(`${sanitizeError(error)}；评估库清理失败，请检查本机 tripweaver_eval_* 库`); }
    throw error;
  }
}
