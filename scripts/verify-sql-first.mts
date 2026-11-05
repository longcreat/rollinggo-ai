// 使用全新专用 PostgreSQL 数据库；不加载应用 .env、不访问真实模型。
// node --import tsx scripts/verify-sql-first.mts [--full]
import { Client } from 'pg';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';

const databaseName = `tripweaver_verify_retrieval_${Date.now()}`;
const adminUrl = process.env.VERIFY_GENERATION_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const url = new URL(adminUrl);
url.pathname = `/${databaseName}`;
const admin = new Client({ connectionString: adminUrl });
await admin.connect();
let created = false;
try {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const folder = 'apps/server/src/__tests__';
  // 所有测试都应自带夹具，能在隔离空库里成立（placeLookup.test.ts 的库内身份样本已改为显式注入）。
  const files = process.argv.includes('--full')
    ? (await readdir(folder)).filter((name) => name.endsWith('.test.ts')).sort()
    : ['placeRetrieval.test.ts', 'placeImportIdentity.test.ts', 'queryEmbedding.test.ts', 'researchSubmission.test.ts', 'researchQuality.test.ts', 'routeOrder.test.ts', 'routeCoherence.test.ts', 'scheduling.test.ts', 'generationModel.test.ts', 'titleFont.test.ts', 'prompts.test.ts', 'generationPerformance.test.ts', 'settingsResolve.test.ts', 'sharePosterBrand.test.ts', 'emailRegisterGuard.test.ts',
      ...(process.argv.includes('--flow') ? ['dateRepair.test.ts', 'mealLocality.test.ts', 'longHaul.test.ts', 'longHaulFixer.test.ts', 'openHours.test.ts',
        'placeFacts.test.ts', 'placeRelations.test.ts', 'placeLookup.test.ts', 'geoPipeline.test.ts', 'legs.test.ts',
        'agentCompletion.test.ts', 'llmRetry.test.ts', 'draftRevision.test.ts', 'chatBrief.test.ts', 'chatBriefApply.test.ts',
        'chatDerive.test.ts', 'exportFiles.test.ts'] : [])];
  const env = { ...process.env, DATABASE_URL: url.toString(), MASTER_KEY: 'a'.repeat(64),
    DOTENV_CONFIG_PATH: './data/absent-verification.env',
    SITE_LLM_BASE_URL: '', SITE_LLM_API_KEY: '', SITE_LLM_MODEL: '', EMBEDDING_BASE_URL: '', EMBEDDING_API_KEY: '',
    RESEND_API_KEY: 're_verify_fixture',
    AMAP_KEY: '', SEARCH_API_KEY: '',
    GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '', REGISTRATION_MODE: 'open' };
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...files.map((name) => `${folder}/${name}`)], { env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (exitCode) => resolve(exitCode ?? 1));
  });
  if (code) process.exitCode = code;
} finally {
  if (created && /^tripweaver_verify_retrieval_\d+$/.test(databaseName)) {
    await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  }
  await admin.end();
}
