import { pool } from '../db/client';
import { createPlaceIdentityIndex, placeNames } from '../lib/placeIdentity';
import type { RetrievedPlace } from '../generation/placeRetrieval';

/** 一次操作读取同城完整身份目录，避免检索 top-k 截断把歧义错误降成唯一命中。 */
export async function loadPlaceIdentityIndex(city: string) {
  const { rows } = await pool.query<RetrievedPlace>(
    `SELECT id,city,name,category,verified,source,lat,lng,payload
       FROM canonical_places WHERE city=$1 AND (verified=TRUE OR payload ? 'identityWithdrawal')`, [city]);
  return createPlaceIdentityIndex<RetrievedPlace>(rows.map(row => ({ ...row, aliases: placeNames(row), evidence: [] })));
}
