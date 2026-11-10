// 回归守卫（2026-11-05）：图片只允许来自高德 POI。
// 结构断言：任何外部图库/审核图库的导入都视为回归；env 不再接受相关密钥。
// 行为断言由 amapPoiPhotos / placeLookup / tripPhotos 覆盖。
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const SRC = path.join(import.meta.dirname, '..');
const SELF = path.basename(import.meta.filename);

const FORBIDDEN_MODULES = [
  'integrations/pexels', 'integrations/pixabay', 'integrations/unsplash', 'integrations/wikimedia',
  'integrations/photoEnrichment', 'integrations/photoCollection', 'integrations/photoReview',
  'integrations/reviewedPhotos', 'integrations/selectedPhotos', 'integrations/curatedPhotos',
  'integrations/boundPhotoLookup', 'integrations/photoStore', 'integrations/stockPhotoSupport',
  'services/independentPhoto',
];
const FORBIDDEN_ENV = /PEXELS_API_KEY|PIXABAY_API_KEY|UNSPLASH_ACCESS_KEY|PHOTO_REVIEW_/;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(full));
    else if (entry.name.endsWith('.ts') && entry.name !== SELF) files.push(full);
  }
  return files;
}

test('没有任何外部图库/审核图库模块被重新引入', async () => {
  const hits: string[] = [];
  for (const file of await sourceFiles(SRC)) {
    const text = await readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      if (!/^\s*import\b|^\s*export\b.*from\b|require\(/.test(line)) continue;
      for (const name of FORBIDDEN_MODULES) {
        if (line.includes(name)) hits.push(`${path.relative(SRC, file)}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(hits, [], `图片只能走高德 POI，发现已删除来源的导入：\n${hits.join('\n')}`);
});

test('env 不再声明外部图库与视觉审核配置', async () => {
  const env = await readFile(path.join(SRC, 'env.ts'), 'utf8');
  assert.equal(FORBIDDEN_ENV.test(env), false, 'env.ts 不应再出现 Pexels/Pixabay/Unsplash/PHOTO_REVIEW 配置');
});

test('图片来源只有高德：封面解析不引用外部主机', async () => {
  const tools = await readFile(path.join(SRC, 'generation/tools/researchTools.ts'), 'utf8');
  for (const host of ['images.pexels.com', 'images.unsplash.com', 'pixabay.com', 'upload.wikimedia.org', 'commons.wikimedia.org']) {
    assert.equal(tools.includes(host), false, `researchTools.ts 不应出现 ${host}`);
  }
});
