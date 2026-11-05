// 导出浏览器工具：AI 图片下载 / JSON 下载 / 打印 / 微信环境探测
import { TRIP_EXPORT_VERSION, type Trip, type TripExport, type TripShareImageResponse } from '@tripweaver/shared';

export function isWeChat(): boolean {
  return /MicroMessenger/i.test(navigator.userAgent);
}

function safeFileName(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 50) || 'tripweaver';
}

function downloadUrl(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  try { a.click(); } finally { a.remove(); }
}

/** JSON 备份：版本化完整数据（与导入成对，跨账号还原） */
export function exportTripJson(trip: Trip): void {
  const payload: TripExport = { version: TRIP_EXPORT_VERSION, trip };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  downloadUrl(url, `${safeFileName(trip.title)}.json`);
  URL.revokeObjectURL(url);
}

/**
 * 候选字节来源：优先 MEDIA_BASE_URL 指向的地址（CDN），再退回同源 `/media/...`
 * （服务端从同一个对象存储转发）。同源时两者相同，去重后只剩一个。
 */
function byteSources(url: string): string[] {
  const sources = [url];
  try {
    const sameOrigin = new URL(url, window.location.origin).pathname;
    if (sameOrigin && !sources.includes(sameOrigin)) sources.push(sameOrigin);
  } catch { /* 非 URL：保持原值，让下面的 fetch 自己失败 */ }
  return sources;
}

/**
 * 非微信环境触发下载（微信由调用方走「长按保存」引导，R12）。
 * 成品可能由 CDN 提供，而跨域静态资源上 `a[download]` 会被浏览器忽略，所以先 fetch 取字节再造 blob URL；
 * CDN 未配 CORS、离线等情况退回同源路径。失败时不静默开新标签页：只返回 false，
 * 由调用方给出错误与重试入口（完成提醒已有「图片暂时无法下载」按钮，弹窗里可再次点「下载」）。
 * 返回值表示是否真的发起了下载 —— 完成通知的文案依赖它，不能谎报。
 */
export async function downloadShareImage(image: TripShareImageResponse, title: string): Promise<boolean> {
  const extension = image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/webp' ? 'webp' : 'png';
  const filename = `${safeFileName(title)}-AI分享图.${extension}`;
  for (const source of byteSources(image.url)) {
    try {
      const response = await fetch(source, { credentials: 'omit' });
      if (!response.ok) continue;
      const objectUrl = URL.createObjectURL(await response.blob());
      try { downloadUrl(objectUrl, filename); } finally {
        // 立即 revoke 可能打断已经开始的下载，等它落地后再释放
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      }
      return true;
    } catch { /* 换下一个候选地址；失败由调用方提示，返回值就是唯一真相 */ }
  }
  return false;
}

export function printTrip(): void {
  window.print();
}
