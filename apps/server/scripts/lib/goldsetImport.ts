import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { env } from '../../src/env';
import { runMigrations } from '../../src/db/migrate';
import { importGoldsetCity, type GoldsetActivity, type GoldsetInput } from '../../src/services/goldsetPlaceImport';

const ActivitySchema=Type.Object({name:Type.String({minLength:1}),category:Type.Optional(Type.String()),
  lat:Type.Number({minimum:-90,maximum:90}),lng:Type.Number({minimum:-180,maximum:180}),coordSource:Type.Literal('geocoded')});
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);

export async function runGoldsetImport(mode:'seed'|'restore') {
  const snapshotIndex=process.argv.indexOf('--snapshot-dir');
  const supplied=snapshotIndex>=0?process.argv[snapshotIndex+1]:undefined;
  if(snapshotIndex>=0&&(!supplied||supplied.startsWith('--'))) throw new Error('--snapshot-dir 需要目录');
  const folder=supplied?path.resolve(supplied):fileURLToPath(new URL('../../../../eval/snapshots/',import.meta.url));
  const dryRun=process.argv.includes('--dry-run');
  const byCity=new Map<string,GoldsetInput[]>();
  for(const file of fs.readdirSync(folder).filter(file=>file.endsWith('.json')).sort()) {
    const snapshot:unknown=JSON.parse(fs.readFileSync(path.join(folder,file),'utf8'));
    if(!object(snapshot)||!object(snapshot.trip)||typeof snapshot.trip.destination!=='string'||!snapshot.trip.destination.trim()) continue;
    const city=snapshot.trip.destination;
    for(const day of Array.isArray(snapshot.trip.days)?snapshot.trip.days:[]) {
      if(!object(day)||!Array.isArray(day.activities)) continue;
      for(const activity of day.activities) {
        if(!Value.Check(ActivitySchema,activity)||!activity.name.trim()) continue;
        const item:GoldsetInput={city,activity:activity as GoldsetActivity,
          ...(typeof snapshot.caseId==='string'?{caseId:snapshot.caseId}:{})};
        byCity.set(city,[...(byCity.get(city)??[]),item]);
      }
    }
  }
  const pool=new pg.Pool({connectionString:env.databaseUrl});
  try {
    await runMigrations(pool);
    for(const [city,items] of [...byCity].sort(([a],[b])=>a.localeCompare(b))) {
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const result=await importGoldsetCity(client,city,items,mode);
        await client.query(dryRun?'ROLLBACK':'COMMIT');
        console.log(JSON.stringify({mode,dryRun,...result}));
      } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
      finally {client.release();}
    }
  } finally {await pool.end();}
}
