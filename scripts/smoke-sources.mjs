// 冒烟：调研数据源连通性（高德搜索POI 2.0 + Web 搜索）
// 用法：node scripts/smoke-sources.mjs（读 apps/server/.env 或环境变量 AMAP_KEY / SEARCH_API_KEY）
// 未配 Key 的源跳过并提示（数据源属可选配置，exit 0）；已配置但探测失败时 exit 1
import { existsSync } from 'node:fs';
import { config } from 'dotenv';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

// 系统代理环境下 Node fetch 需显式接管（与 apps/server/src/lib/proxy.ts 一致）
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) {
  setGlobalDispatcher(new EnvHttpProxyAgent({ noProxy: process.env.NO_PROXY ?? 'localhost,127.0.0.1,::1' }));
}

for (const p of ['apps/server/.env', '.env']) if (existsSync(p)) config({ path: p });

const amapKey = process.env.AMAP_KEY ?? '';
const searchKey = process.env.SEARCH_API_KEY ?? '';
const searchBase = (process.env.SEARCH_API_BASE_URL || 'https://api.langsearch.com').replace(/\/+$/, '');

let failures = 0;

// ---------- 高德搜索POI 2.0 ----------
if (!amapKey) {
  console.log('[amap] 未配置 AMAP_KEY，跳过（生成时该源自动降级；申请指引见 .env.example）');
} else {
  try {
    const params = new URLSearchParams({
      key: amapKey,
      keywords: '天安门',
      types: '110000',
      region: '北京市',
      city_limit: 'true',
      show_fields: 'business,photos',
      page_size: '3',
    });
    const res = await fetch(`https://restapi.amap.com/v5/place/text?${params}`, { signal: AbortSignal.timeout(10_000) });
    const body = await res.json();
    if (body.status !== '1') throw new Error(body.info || `HTTP ${res.status}`);
    const pois = Array.isArray(body.pois) ? body.pois : [];
    console.log(`[amap] 连通正常，返回 ${pois.length} 条：`);
    for (const p of pois) {
      const photos = Array.isArray(p.photos) ? p.photos.length : 0;
      console.log(`  - ${p.name}｜${p.type}｜评分 ${p.business?.rating ?? '-'}｜图片 ${photos} 张`);
    }
  } catch (err) {
    failures += 1;
    console.error(`[amap] 探测失败：${err instanceof Error ? err.message : err}`);
  }
}

// ---------- Web 搜索（LangSearch / 博查同族） ----------
if (!searchKey) {
  console.log('[websearch] 未配置 SEARCH_API_KEY，跳过（生成时该源自动降级；LangSearch 免费申请见 .env.example）');
} else {
  try {
    const res = await fetch(`${searchBase}/v1/web-search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${searchKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: '故宫 门票 预约', summary: true, count: 3, freshness: 'noLimit' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const pages = body?.data?.webPages?.value ?? body?.webPages?.value ?? [];
    if (!Array.isArray(pages) || !pages.length) throw new Error('返回结构异常或无结果');
    console.log(`[websearch] 连通正常（${searchBase}），返回 ${pages.length} 条：`);
    for (const h of pages) console.log(`  - ${h.name}｜${h.siteName ?? '-'}｜${h.url}`);
  } catch (err) {
    failures += 1;
    console.error(`[websearch] 探测失败：${err instanceof Error ? err.message : err}`);
  }
}

process.exit(failures ? 1 : 0);
