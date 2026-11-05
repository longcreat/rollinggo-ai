// 单测：导出文件扫描与版本选择（09-27）——识别三类产物、忽略无关文件、每城取最新
// 夹具在临时目录内自造：import/ 被 .gitignore 忽略，CI 里恒为空，断言不能依赖它。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { EXPORT_SOURCES, latestExports, scanExports } from '../../scripts/lib/exportFiles';

/** 造一份与 import/ 同构的导出目录：北京三份多版本、上海 relations（无 generatedAt）、杭州 images、外加无关文件 */
function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-files-'));
  const write = (name: string, data: unknown) =>
    fs.writeFileSync(path.join(dir, name), JSON.stringify(data), 'utf8');
  write('xhs-places.json', { city: '北京', generatedAt: '2026-09-22', places: [{ id: 'a' }] });
  write('xhs-places-beijing.json', { city: '北京', generatedAt: '2026-09-23', places: [{ id: 'a' }, { id: 'b' }] });
  write('xhs-places-北京.json', { city: '北京', generatedAt: '2026-09-25', places: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  write('xhs-place-relations-上海.json', { city: '上海', relations: [{ from: 'a', to: 'b' }] });
  write('xhs-place-images-杭州.json', { city: '杭州', generatedAt: '2026-09-27', images: [{ placeId: 'a', key: 'x/y.webp' }] });
  fs.writeFileSync(path.join(dir, 'tripweaver-backup.dump'), 'not-json', 'utf8');
  return dir;
}

test('scanExports：识别三类导出，忽略 backup.dump 等无关文件', () => {
  const dir = makeFixture();
  try {
    const files = scanExports(dir);
    assert.equal(files.length, 5, '三份北京地点导出 + 上海关联 + 杭州图片');
    assert.ok(
      files.every((item) => EXPORT_SOURCES.includes(item.source)),
      '只应识别 xhs-places*.json / xhs-place-relations-*.json / xhs-place-images-*.json',
    );
    assert.ok(!files.some((item) => item.filePath.endsWith('.dump')));
    for (const item of files) {
      assert.ok(item.city.length > 0, `${item.filePath} 应有 city`);
      assert.match(item.contentHash, /^[0-9a-f]{32}$/);
      assert.match(item.generatedAt, /^\d{4}-\d{2}-\d{2}$/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('latestExports：每个 (source, city) 只留 generatedAt 最新的一份', () => {
  const dir = makeFixture();
  try {
    const files = scanExports(dir);
    const latest = latestExports(files);
    assert.equal(latest.length, 3, '北京地点 / 上海关联 / 杭州图片各一份');
    const keys = latest.map((item) => `${item.source}|${item.city}`);
    assert.equal(new Set(keys).size, keys.length, '不应出现重复的 (source, city)');
    for (const item of latest) {
      const sameKey = files.filter((f) => f.source === item.source && f.city === item.city);
      const newest = sameKey.reduce((max, f) => (f.generatedAt > max ? f.generatedAt : max), '');
      assert.equal(item.generatedAt, newest, `${item.source}/${item.city} 应取最新的一版`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('latestExports：同城多份导出时只留一份（北京实测曾有三份：09-22 / 09-23 / 09-25）', () => {
  const dir = makeFixture();
  try {
    const beijing = scanExports(dir).filter((f) => f.source === 'xhs_places' && f.city === '北京');
    assert.equal(beijing.length, 3, '夹具里北京应有三份导出');
    const latest = latestExports(beijing);
    assert.equal(latest.length, 1, `多份北京导出应只留一份，实际留了 ${latest.length} 份`);
    assert.equal(latest[0]!.generatedAt, '2026-09-25', '应取 09-25 那份而不是默认读到的 09-22');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('latestExports：空输入返回空数组', () => {
  assert.deepEqual(latestExports([]), []);
});

test('图片产物与地点产物互斥：xhs-place-images-*.json 不被当成 places 导出', () => {
  // 正则 ^xhs-places 要求第 10 个字符是 s，`xhs-place-images-` 那里是 `-`；写错会让两个源互相吞掉
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-files-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'xhs-place-images-杭州.json'),
      JSON.stringify({ city: '杭州', generatedAt: '2026-09-27', count: 1, images: [{ placeId: 'a', key: 'x/x.webp' }] }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(dir, 'xhs-places-杭州.json'),
      JSON.stringify({ city: '杭州', generatedAt: '2026-09-27', count: 1, places: [{ id: 'a', name: 'X' }] }),
      'utf8',
    );
    const found = scanExports(dir);
    assert.equal(found.length, 2, '两份产物都应被识别');
    const images = found.find((f) => f.source === 'xhs_place_images');
    const places = found.find((f) => f.source === 'xhs_places');
    assert.ok(images && places, '两个源各一份');
    assert.equal(images.rowCount, 1, 'rowCount 取 images 数组长度');
    assert.equal(places.rowCount, 1, 'rowCount 取 places 数组长度');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
