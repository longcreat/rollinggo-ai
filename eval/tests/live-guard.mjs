// 仅验证进程预加载：任何应用库连接立即失败，公共 HTTP 请求不允许出网。
import fs from 'node:fs';
import { Client } from 'pg';
import '../../scripts/lib/local-fetch-only.mjs';

const localFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (process.env.EVAL_VERIFY_GEO === 'fixture' && url.hostname === 'nominatim.openstreetmap.org') {
    return Promise.resolve(Response.json([{ lat: '23.128', lon: '113.26', display_name: '广州测试片区' }]));
  }
  return localFetch(input, init);
};

const connect = Client.prototype.connect;
Client.prototype.connect = function (...args) {
  const database = this.connectionParameters.database;
  if (database !== 'postgres' && !/^tripweaver_eval_[a-f0-9]{24}$/.test(database)) {
    throw new Error('验证检测到非评估数据库连接');
  }
  fs.appendFileSync(process.env.EVAL_CONNECTION_AUDIT, `${database}\n`);
  return connect.apply(this, args);
};
