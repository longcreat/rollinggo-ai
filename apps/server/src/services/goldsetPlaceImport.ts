import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { createPlaceIdentityIndex, identityStrings, isScopedPlace, placeIdentity, type IdentityPlace } from '../lib/placeIdentity';
import { placeEmbeddingText } from '../lib/placeEmbeddingText';
import { captureIdentityImport, recordIdentityImport } from './placeIdentityAudit';

export interface GoldsetActivity {
  name: string;
  category?: string;
  lat: number;
  lng: number;
  coordSource: 'geocoded';
  [key: string]: unknown;
}
export interface GoldsetInput { city: string; caseId?: string; activity: GoldsetActivity }
interface StoredPlace extends IdentityPlace { category: string; source: string; verified: boolean }

/** 调用方必须开启事务。金集是独立来源，已声明身份不可被历史快照覆盖。 */
export async function importGoldsetCity(client: PoolClient, city: string, items: readonly GoldsetInput[], mode: 'seed' | 'restore') {
  if (!city.trim() || items.some(item=>item.city!==city)) throw new Error('金集城市范围不一致');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`place-identity:${city}`]);
  // 同时阻止不持城市锁的图片回写，在快照与恢复之间覆盖刚写入的字段。
  const rows = (await client.query<StoredPlace>('SELECT id,city,name,category,source,verified,payload FROM canonical_places WHERE city=$1 FOR UPDATE', [city])).rows;
  const before = await captureIdentityImport(client, city);
  const hasEmbedding = mode==='restore' && (await client.query<{available:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema()
      AND table_name='canonical_places' AND column_name='embedding') available`)).rows[0]!.available;
  const result = { city, scanned: items.length, inserted: 0, restored: 0, skipped: 0, identityClaimed: 0, auditId: null as string | null };
  for (const item of items) {
    const { activity } = item;
    const id = createHash('sha256').update(city + activity.name).digest('hex').slice(0, 32);
    const existing = rows.find(row=>row.id===id);
    if (mode==='seed') {
      if (existing) { result.skipped++; continue; }
      // 纳入不可用行只判断“是否已有声明”，不把它们恢复为可用身份。
      const index = createPlaceIdentityIndex(rows);
      const named = index.resolve(city, activity.name);
      const claimedId = rows.some(row=>placeIdentity(row).entityId===id || row.payload?.canonicalRedirectTo===id
        || identityStrings(placeIdentity(row).memberIds).includes(id));
      if (claimedId || named.status!=='unresolved' || named.reason==='withdrawn') { result.identityClaimed++; continue; }
      const payload = { ...(item.caseId ? { caseId:item.caseId } : {}), activity };
      const row: StoredPlace = {id,city,name:activity.name,category:activity.category ?? '',source:'goldset',verified:true,payload};
      await client.query(`INSERT INTO canonical_places(id,city,name,category,lat,lng,source,verified,payload,created_at)
        VALUES($1,$2,$3,$4,$5,$6,'goldset',TRUE,$7,now())`, [id,city,activity.name,row.category,activity.lat,activity.lng,payload]);
      rows.push(row); result.inserted++;
      continue;
    }
    if (!existing || existing.source==='goldset') { result.skipped++; continue; }
    const governed = Object.keys(placeIdentity(existing)).length>0 || isScopedPlace(existing) || !!existing.payload?.canonicalRedirectTo;
    const category = governed ? existing.category : activity.category ?? existing.category;
    const payload:Record<string,unknown> = { ...existing.payload, ...(item.caseId ? { caseId:item.caseId } : {}), activity };
    const changedText = placeEmbeddingText(existing)!==placeEmbeddingText({...existing,category,payload});
    if(changedText) delete payload.embeddedText;
    await client.query(`UPDATE canonical_places SET source='goldset',category=$2,payload=$3
      ${changedText && hasEmbedding ? ',embedding=NULL' : ''} WHERE id=$1`, [id,category,payload]);
    Object.assign(existing,{source:'goldset',category,payload}); result.restored++;
  }
  if (result.inserted || result.restored) {
    const hash = createHash('sha256').update(JSON.stringify({mode,city,items})).digest('hex').slice(0,32);
    result.auditId = await recordIdentityImport(client,city,hash,before);
  }
  return result;
}
