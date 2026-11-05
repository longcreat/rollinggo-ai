// BYOK baseUrl 的 SSRF 防护：仅 http(s)，解析后 IP 落私网/环回/链路本地段一律拒绝
// 站长可通过 SSRF_ALLOWLIST 豁免自有内网端点（如本机 Ollama）
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { env } from '../env';

export class SsrfError extends Error {}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  const [a, b] = parts;
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||   // CGNAT
    (a === 169 && b === 254) ||               // link-local
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;      // ULA fc00::/7
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // link-local
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);            // IPv4-mapped
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return false;
}

function isAllowlisted(url: URL): boolean {
  const host = url.host.toLowerCase();       // 含端口
  const hostname = url.hostname.toLowerCase();
  return env.ssrfAllowlist.includes(host) || env.ssrfAllowlist.includes(hostname);
}

/** 校验用户提供的 baseUrl；不安全时抛 SsrfError。保存时与请求时均需调用（防 DNS 重绑定）。 */
export async function assertSafeBaseUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError('Base URL 格式不正确');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SsrfError('Base URL 仅支持 http/https');
  }
  if (isAllowlisted(url)) return;

  const hostname = url.hostname;
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new SsrfError('Base URL 不允许指向内网地址（站长可在 SSRF_ALLOWLIST 中豁免）');
  }

  const addresses = net.isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true }).catch(() => {
        throw new SsrfError('Base URL 域名无法解析');
      });

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new SsrfError('Base URL 不允许指向内网地址（站长可在 SSRF_ALLOWLIST 中豁免）');
    }
  }
}
