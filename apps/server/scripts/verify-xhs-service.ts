// 验证小红书社区库（PG）查询逻辑：名称匹配 / 城市过滤 / 语料读取 / 分类检索
// 用法：cd apps/server && npx tsx scripts/verify-xhs-service.ts
import { findXhsEvidence, findXhsPlace, findXhsPlacesByCategory, xhsPlaceStats } from '../src/services/xhsPlaceService';

async function main(): Promise<void> {
  const stats = await xhsPlaceStats();
  console.log('库状态:', JSON.stringify(stats));

  const cases: [string, string][] = [
    ['洪崖洞', '重庆'],
    ['长江索道', '重庆 3日游'],
    ['三峡博物馆', '重庆'],
    ['不存在的景点XYZ', '重庆'],
  ];

  for (const [name, city] of cases) {
    const hit = await findXhsPlace(name, city);
    if (!hit) {
      console.log(`${name} @ ${city} → 未命中`);
      continue;
    }
    const p = hit.payload;
    console.log(
      `${name} @ ${city} → 命中 ${hit.name}（${hit.category}）| res=${p.reservation ?? 'none'} | ` +
        `note=${(p.reservationNote ?? '').slice(0, 30) || '-'} | 主题=${(p.themes ?? []).join('/') || '-'}`,
    );
    const ev = await findXhsEvidence(hit.id, [], 3);
    for (const e of ev) {
      console.log(`    [${e.kind}] ${e.content.slice(0, 50)} | ${e.sourceUrl.slice(0, 45)}`);
    }
  }

  console.log('\n按分类「自然」检索:');
  for (const p of await findXhsPlacesByCategory('重庆', '自然', 5)) {
    console.log(`  ${p.name}（推荐分 ${p.payload.recommendScore}）`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('验证失败:', err);
    process.exit(1);
  },
);
