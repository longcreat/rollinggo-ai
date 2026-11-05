// 运行时探针：验证本机对 Nominatim / 高德的直连可达性（不读取任何密钥与 .env）
// 用途：确证「eval:live 全量 geocode 失败」是环境级（网络不可达）还是代码级
import { geocode } from '../../../apps/server/src/integrations/geocode';

async function main() {
  console.log('[probe] Nominatim: 上海 上海博物馆 …');
  const t0 = Date.now();
  const p = await geocode('上海 上海博物馆');
  console.log(`[probe] Nominatim result=${JSON.stringify(p)} (${Date.now() - t0}ms)`);

  console.log('[probe] Amap keyless reachability（预期 status=0 INVALID_USER_KEY 即网络可达）…');
  const t1 = Date.now();
  try {
    const res = await fetch('https://restapi.amap.com/v3/geocode/geo?key=probe&address=test', {
      signal: AbortSignal.timeout(8000),
    });
    console.log(`[probe] Amap http=${res.status} body=${JSON.stringify(await res.json())} (${Date.now() - t1}ms)`);
  } catch (e) {
    console.log(`[probe] Amap fetch failed: ${(e as Error).message} (${Date.now() - t1}ms)`);
  }
}

main();
