import fs from 'node:fs';
import path from 'node:path';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { wgs84ToGcj02 } from '@tripweaver/shared';
import type { Pool } from 'pg';
import { EVAL_DIR, hash } from './artifacts';
import { readFrozen, seedFrozen, summarizeFrozen } from './frozenKnowledge';

export type KnowledgeMode = 'golden' | 'empty' | 'frozen';

const FixtureSchema = Type.Object({ version: Type.Literal(1), source: Type.String(), note: Type.String(), places: Type.Array(Type.Object({
  city: Type.String(), name: Type.String(), category: Type.Literal('attraction'), intro: Type.String(),
  lat: Type.Number({ minimum: -90, maximum: 90 }), lng: Type.Number({ minimum: -180, maximum: 180 }), themes: Type.Array(Type.String()),
  coordSystem: Type.Union([Type.Literal('wgs84'), Type.Literal('gcj02')]),
})) });
export function loadKnowledge(mode: KnowledgeMode, options: { snapshot?: string; skipVectors?: boolean; cities?: string[] } = {}) {
  if (mode === 'frozen') {
    if (!options.snapshot) throw new Error('--knowledge frozen 需要 --knowledge-snapshot <目录>');
    const snapshot = readFrozen(options.snapshot);
    const missing = options.cities?.filter((city) => !snapshot.data.cities.includes(city));
    if (missing?.length) throw new Error(`冻结知识库未覆盖本次用例城市：${missing.join('、')}`);
    const summary = summarizeFrozen(snapshot);
    const skipVectors = options.skipVectors ?? false;
    return { kind: 'frozen' as const, snapshot, skipVectors, places: snapshot.data.places, directory: path.resolve(options.snapshot),
      manifest: { mode, hash: hash({ snapshotHash: snapshot.contentHash, skipVectors }), rows: snapshot.data.places.length,
        snapshotName: snapshot.name, snapshotHash: snapshot.contentHash, exportedAt: snapshot.exportedAt, cities: snapshot.data.cities,
        evidenceRows: snapshot.data.evidence.length, relationRows: snapshot.data.relations.length,
        vectorMode: skipVectors ? 'omitted' : snapshot.data.vectors.included ? 'preserved' : 'absent',
        placeVectors: skipVectors ? 0 : summary.counts.placeVectors, evidenceVectors: skipVectors ? 0 : summary.counts.evidenceVectors,
      },
    };
  }
  if (options.snapshot || options.skipVectors) throw new Error('知识库副本/向量参数只能用于 --knowledge frozen');
  const data: unknown = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'fixtures/places.json'), 'utf8'));
  if (!Value.Check(FixtureSchema, data)) throw new Error('固定知识库种子格式错误');
  // canonical_places 的消费链按 GCJ-02 处理坐标；旧快照缺 coordSystem 时语义是 WGS84。
  const places = mode === 'empty' ? [] : data.places.map((place) => ({ ...place,
    ...(place.coordSystem === 'wgs84' ? wgs84ToGcj02(place.lat, place.lng) : {}), coordSystem: 'gcj02' as const,
  }));
  return { kind: 'legacy' as const, places, manifest: { mode, hash: hash({ version: data.version, mode, places }), rows: places.length } };
}
export async function seedKnowledge(pool: Pool, knowledge: ReturnType<typeof loadKnowledge>): Promise<void> {
  if (knowledge.kind === 'frozen') return seedFrozen(pool, knowledge.snapshot, knowledge.skipVectors);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const place of knowledge.places) {
      await client.query(`INSERT INTO canonical_places (id,city,name,category,lat,lng,source,verified,payload,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,'goldset',TRUE,$7,$8)`, [
        `eval-${hash([place.city, place.name]).slice(0, 24)}`, place.city, place.name, place.category, place.lat, place.lng,
        JSON.stringify({ topReasons: [place.intro.slice(0, 200)], themes: place.themes, coordSource: 'geocoded', coordSystem: 'gcj02',
          reservation: 'unknown', fixtureSource: 'historical-golden-july-2026' }), new Date('2026-07-18T00:00:00Z'),
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
