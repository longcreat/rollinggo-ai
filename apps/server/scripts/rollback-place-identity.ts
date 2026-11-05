// 只预览回滚条件；显式 --apply 才恢复审计快照，现状变化则拒绝。
import { pool } from '../src/db/client';
import { rollbackIdentityImport } from '../src/services/placeIdentityAudit';

const id = process.argv[2];
if (!id || id.startsWith('--')) throw new Error('用法：tsx apps/server/scripts/rollback-place-identity.ts <审计ID> [--apply]');
const client = await pool.connect();
try {
  await client.query('BEGIN');
  console.log(await rollbackIdentityImport(client, id, process.argv.includes('--apply')));
  await client.query(process.argv.includes('--apply') ? 'COMMIT' : 'ROLLBACK');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally { client.release(); await pool.end(); }
