import type { TripShareImageResponse } from '@tripweaver/shared';
import { assertSafeBaseUrl } from './ssrfGuard';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_JSON_BYTES = 15 * 1024 * 1024;
// 整条降级链共享的预算；单站时等价于原有的 180 秒单次超时
const TOTAL_TIMEOUT_MS = 180_000;

/** 生图结果在服务端只以字节流传手：落盘与对外 URL 由分享海报服务负责 */
export type GeneratedShareImage = { bytes: Buffer; mimeType: TripShareImageResponse['mimeType'] };

export interface ImageGenerationConfig { baseUrl: string; apiKey: string; model: string }

/** retryable=false 表示换站也不会成功（请求本身错了），调用方应直接失败而不是降级。
 * expose 标记：message 是我们自己写的（不含密钥或上游原始错误），可以透给前端；
 * 否则用户看到「服务器内部错误」无法分辨是自己配置错了还是上游挂了。 */
export function imageError(message: string, statusCode = 502, retryable = true) {
  return Object.assign(new Error(message), { statusCode, retryable, expose: true });
}

function isImageError(error: unknown): error is Error & { statusCode: number; retryable: boolean } {
  return error instanceof Error && 'statusCode' in error;
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw imageError('生成图片过大，请重试');
  }
  if (!response.body) throw imageError('生图服务返回空内容');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw imageError('生成图片过大，请重试');
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks);
}

export function encodeShareImage(bytes: Buffer): GeneratedShareImage {
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw imageError('生成图片大小异常');
  let mimeType: GeneratedShareImage['mimeType'];
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mimeType = 'image/jpeg';
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mimeType = 'image/webp';
  else throw imageError('生图服务未返回有效的 PNG、JPEG 或 WebP 图片');
  return { bytes, mimeType };
}

/** HTTP 4xx 里除鉴权失败与限流外都是请求本身的问题：换站也不会成功 */
function isRequestError(status: number): boolean {
  return status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429;
}

/** 单站尝试；失败抛 imageError，可降级性写在 retryable 上 */
async function attemptImageGeneration(config: ImageGenerationConfig, prompt: string, signal: AbortSignal): Promise<GeneratedShareImage> {
  try {
    try {
      await assertSafeBaseUrl(config.baseUrl);
    } catch {
      throw imageError('生图接口地址配置不正确', 503, false);
    }
    const base = new URL(config.baseUrl);
    if (base.username || base.password || base.search || base.hash) throw imageError('生图接口地址配置不正确', 503, false);
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/images/generations`, {
      method: 'POST', signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, prompt, n: 1, size: '1024x1536' }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw imageError(
        response.status === 401 || response.status === 403 ? '生图服务鉴权失败，请管理员检查配置' : response.status === 429 ? '生图服务繁忙或额度不足，请稍后重试' : `生图服务暂不可用（HTTP ${response.status}）`,
        502,
        !isRequestError(response.status),
      );
    }
    let body: unknown;
    try { body = JSON.parse((await readLimited(response, MAX_JSON_BYTES)).toString('utf8')); }
    catch (error) { if (isImageError(error)) throw error; throw imageError('生图服务响应格式异常'); }
    const first = body && typeof body === 'object' && 'data' in body && Array.isArray(body.data) ? body.data[0] as unknown : undefined;
    if (!first || typeof first !== 'object') throw imageError('生图服务没有返回图片');
    if ('b64_json' in first && typeof first.b64_json === 'string' && first.b64_json) {
      if (first.b64_json.length > MAX_JSON_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(first.b64_json)) throw imageError('生图服务图片编码异常');
      return encodeShareImage(Buffer.from(first.b64_json, 'base64'));
    }
    if ('url' in first && typeof first.url === 'string') {
      const url = new URL(first.url);
      if (url.protocol !== 'https:' || url.username || url.password) throw imageError('生图服务返回不安全的图片地址');
      await assertSafeBaseUrl(url.href);
      // Never forward provider authorization to a returned CDN URL or follow redirects.
      const image = await fetch(url, { signal, redirect: 'error' });
      if (!image.ok) { await image.body?.cancel(); throw imageError('生成图片下载失败，请重试'); }
      return encodeShareImage(await readLimited(image, MAX_IMAGE_BYTES));
    }
    throw imageError('生图服务没有返回图片');
  } catch (error) {
    if (isImageError(error)) throw error;
    throw imageError(signal.aborted ? '图片生成超时，请稍后重试' : '无法连接生图服务，请稍后重试');
  }
}

/**
 * 按配置顺序尝试中转站：可重试故障降级到下一站，首个成功即返回。
 * 全部失败时抛出最后一次真实错误；请求本身出错（HTTP 4xx）与本站配置不合法则立即失败。
 *
 * 逐站写日志：只记最后一站错误的话，三家上游同时故障时分不清是「降级没跑」还是「都挂了」。
 * 日志只写站序号、域名、耗时与原因，不输出密钥。
 */
export async function generateShareImage(providers: ImageGenerationConfig[], prompt: string): Promise<GeneratedShareImage> {
  const usable = providers.filter(provider => provider.baseUrl && provider.apiKey);
  if (!usable.length) throw imageError('AI 生图尚未配置，请管理员设置 IMAGE_API_KEY', 503);
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let lastError: Error | null = null;
  for (const [index, provider] of usable.entries()) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      console.warn(`[image-generation] 总预算 ${TOTAL_TIMEOUT_MS}ms 用尽，剩余 ${usable.length - index} 站未尝试`);
      break;
    }
    const label = `#${index + 1} ${new URL(provider.baseUrl).host}`;
    const started = Date.now();
    try {
      const image = await attemptImageGeneration(provider, prompt, AbortSignal.timeout(remainingMs));
      // 单站时成功是常态，不必每次都打日志
      if (usable.length > 1) console.info(`[image-generation] ${label} 成功 ${Date.now() - started}ms`);
      return image;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const fatal = !isImageError(error) || !error.retryable;
      console.warn(`[image-generation] ${label} 失败 ${Date.now() - started}ms：${reason}${fatal ? '（不可降级，终止）' : ''}`);
      if (fatal) throw error;
      lastError = error;
    }
  }
  throw lastError ?? imageError('无法连接生图服务，请稍后重试');
}
