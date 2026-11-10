import crypto from 'node:crypto';
import { Client } from 'pg';

/** 评估只允许显式的本机 postgres 管理库，不能借用应用 DATABASE_URL。 */
export function validateAdminUrl(raw: string | undefined): URL {
  if (!raw) throw new Error('live 需要 EVAL_PG_ADMIN_URL，指向本机专用 PostgreSQL 的 /postgres 管理库');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('EVAL_PG_ADMIN_URL 格式错误'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/postgres' || url.search || url.hash) {
    throw new Error('EVAL_PG_ADMIN_URL 仅接受本机 /postgres 管理库，禁止应用库、远端地址和连接覆盖参数');
  }
  return url;
}
export async function createEvaluationDatabase(raw: string | undefined) {
  const url = validateAdminUrl(raw);
  const name = `tripweaver_eval_${crypto.randomBytes(12).toString('hex')}`;
  const admin = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  let created = false;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
  } catch {
    await admin.end().catch(() => {});
    throw new Error('无法创建评估数据库：检查本机 PostgreSQL 与管理账号 CREATEDB 权限');
  }
  url.pathname = `/${name}`;
  return {
    name, url: url.toString(),
    async close() {
      try {
        // 名称来自本函数生成且创建成功，只清理本次拥有的库。
        if (created && /^tripweaver_eval_[a-f0-9]{24}$/.test(name)) {
          await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
          created = false;
        }
      } finally { await admin.end(); }
    },
  };
}
