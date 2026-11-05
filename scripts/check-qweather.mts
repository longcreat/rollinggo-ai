// 和风配置自查：打印私钥对应的公钥指纹、实打一次接口，并把待验证的 JWT 写到临时文件。
// 不打印任何凭据内容。用法：node --import tsx scripts/check-qweather.mts
// 配套一行（PowerShell）把 token 放进剪贴板，供控制台的「JWT 验证」工具润贴：
//   Set-Clipboard -Value (Get-Content "$env:TEMP\qweather-jwt.tmp" -Raw).Trim(); Remove-Item "$env:TEMP\qweather-jwt.tmp"
import { createHash, createPublicKey } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';
dotenv.config({ path: 'apps/server/.env', quiet: true });
const { qweatherAuthHeader, normalizePem } = await import('../apps/server/src/integrations/qweather/auth');
const { env, qweatherCredential } = await import('../apps/server/src/env');

const auth = qweatherCredential();
if (!auth || auth.mode !== 'jwt') { console.log('不是 JWT 模式:', auth?.mode); process.exit(0); }
const publicPem = createPublicKey(normalizePem(auth.privateKey)).export({ type: 'spki', format: 'pem' }).toString();
console.log('公钥 SHA256（拿去和 控制台-项目管理-凭据 里显示的值手工比）：');
console.log('  ' + createHash('sha256').update(publicPem.trim().replace(/[\r\n]/g, '')).digest('hex'));
console.log('不一致 = .env 里的私钥与上传的公钥不是同一对（浏览器 JWT 工具每次刷新会重新生成密钥对）。');
console.log('API Host:', env.qweatherApiHost);
console.log('申请的接口:', new URL(`https://${env.qweatherApiHost}`).hostname);
console.log('');
const token = qweatherAuthHeader(auth).Authorization!.replace('Bearer ', '');
const response = await fetch(`https://${env.qweatherApiHost}/geo/v2/city/lookup?location=${encodeURIComponent('北京')}&number=1&lang=zh`, { headers: { Authorization: `Bearer ${token}` } });
console.log('第 1 步（裸请求，不过额度账本）HTTP 状态:', response.status, (await response.text()).slice(0, 200));
console.log('');
// token 只落到临时文件，由终端复制到剪贴板，不进入命令行输出。
const tokenPath = join(tmpdir(), 'qweather-jwt.tmp');
writeFileSync(tokenPath, token, 'utf8');
console.log('当前 JWT 已写到:', tokenPath, '（15 分钟有效）');
console.log('  401 时把它粘到 控制台 → JWT验证 (console.qweather.com/support/jwt-validation)：');
console.log('  提示无效 → 公钥/凭据问题；提示有效 → API Host 或项目权限问题。');
console.log('');
// 第 2 步走完整生产链路（额度账本 + 解析 + 状态），需要数据库可用。
try {
  const { makeSampleTrip, chinaDate, weatherForDate } = await import('@tripweaver/shared');
  const { getTripWeather } = await import('../apps/server/src/services/tripWeatherService');
  const weather = await getTripWeather({ ...makeSampleTrip(), destination: '北京', startDate: chinaDate() });
  console.log('第 2 步（生产链路 getTripWeather）status:', weather.status);
  const forecast = weather.forecast;
  if (forecast) {
    console.log(`  ${forecast.city} · ${forecast.casts.length} 天 · ${forecast.reportTime} 更新`);
    for (const cast of forecast.casts.slice(0, 3)) console.log(`  ${cast.date} ${cast.dayWeather}/${cast.nightWeather} ${cast.nightTemp}~${cast.dayTemp}℃ ${cast.dayWind}风${cast.dayPower}级`);
    const lastDate = forecast.casts.at(-1)!.date;
    const last = weatherForDate(weather, '北京', lastDate);
    console.log(`  末日 ${lastDate}:`, last.status, last.status === 'available' ? `distant=${last.distant}` : '');
  }
} catch (error) {
  console.log('第 2 步跳过（多半是本地数据库没启动）:', error instanceof Error ? error.message : error);
}
try { await (await import('../apps/server/src/db/client')).pool.end(); } catch { /* 未建池则无所谓 */ }
// 不强制 process.exit：Windows 上带着未关闭句柄退出会抛 uv 断言，自然退出即可。
