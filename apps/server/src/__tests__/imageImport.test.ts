import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

process.env.MASTER_KEY = 'a'.repeat(64);
const { pool } = await import('../db/client');
after(() => pool.end());
const run = promisify(execFile);
const root = fileURLToPath(new URL('../../../..', import.meta.url));

test('地点重导保留独立图片字段，多图导入采用首张且重复运行保持一致', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tripweaver-image-import-'));
  const id = 'image-import-regression';
  const city = '图片导入测试城';
  const places = path.join(dir, 'xhs-places-test.json');
  const images = path.join(dir, 'xhs-place-images-test.json');
  const seed = async (script: string, input: string) => {
    await run(process.execPath, ['--import', 'tsx', `apps/server/scripts/${script}`, input], {
      cwd: root, env: process.env, timeout: 30_000,
    });
  };
  try {
    await pool.query(
      `INSERT INTO canonical_places (id, city, name, source, payload, created_at)
       VALUES ($1, $2, '测试景点', 'xhs', $3, now())`,
      [id, city, { coverImage: 'old.webp', amapPhoto: 'https://example.com/photo.jpg', outdated: true }],
    );
    await fs.writeFile(places, JSON.stringify({ city, generatedAt: '2026-09-29', places: [
      { id, name: '测试景点', category: '自然', lat: 30, lng: 120, payload: { recommendScore: 100 } },
    ] }));
    await seed('seed-xhs-places.ts', places);
    const payload = (await pool.query('SELECT payload FROM canonical_places WHERE id=$1', [id])).rows[0].payload;
    assert.equal(payload.coverImage, 'old.webp');
    assert.equal(payload.amapPhoto, 'https://example.com/photo.jpg');
    assert.equal(payload.recommendScore, 100);
    assert.equal(payload.outdated, undefined, '仅保留独立维护的图片字段，不保留过期上游字段');
    await fs.writeFile(images, JSON.stringify({ city, generatedAt: '2026-09-29', images: [
      { placeId: id, key: 'first.webp' }, { placeId: id, key: 'second.webp' },
    ] }));
    await seed('seed-xhs-place-images.ts', images);
    await seed('seed-xhs-place-images.ts', images);
    const final = (await pool.query('SELECT payload FROM canonical_places WHERE id=$1', [id])).rows[0].payload;
    assert.equal(final.coverImage, 'first.webp');
    assert.deepEqual(final.imageGallery.map((image: { key: string }) => image.key), ['first.webp', 'second.webp']);
    assert.equal(final.amapPhoto, 'https://example.com/photo.jpg');
    assert.equal(final.recommendScore, 100);
    await seed('seed-xhs-places.ts', places);
    const reimported = (await pool.query('SELECT payload FROM canonical_places WHERE id=$1', [id])).rows[0].payload;
    assert.deepEqual(reimported.imageGallery, final.imageGallery, '地点重导不能清空独立维护的图库');
  } finally {
    await pool.query('DELETE FROM canonical_places WHERE id=$1', [id]);
    await pool.query('DELETE FROM data_import WHERE city=$1', [city]);
    // mkdtemp 返回的本次测试目录，仅在系统临时目录内清理。
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
