import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../env';
import { runMigrations } from './migrate';
import * as schema from './schema';

export const pool = new Pool({ connectionString: env.databaseUrl });
// 空闲连接被服务端断开（实例重启、DROP DATABASE、网络中断）会以 'error' 事件抛出；
// pg 不会自己捕它，不挂监听就会变成未捕获异常直接结束进程。
pool.on('error', (error) => {
  console.error(`[db] 空闲连接异常：${error.message}`);
});

// 顶层 await：模块导入即完成建库与迁移（ESM + tsx 支持，index.ts 依赖该副作用）
await runMigrations(pool);

export const db = drizzle(pool, { schema });
