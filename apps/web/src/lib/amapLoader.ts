// 高德 JS API 加载器（09-26）：自写 script 注入，不引入 @amap/amap-jsapi-loader 依赖
// —— 少一个依赖，也少一处与并行前端改动在 package.json 上打架。
//
// ⚠️ 时序是唯一的坑：`window._AMapSecurityConfig` 必须在 SDK **加载之前**设置。
// JS API 2.0 起（2021-12-02 后申请的 Key）必须有配套安全密钥，缺失会让所有请求被拒。
// 失败与超时一律 reject —— 调用方据此静默降级到 Leaflet（见 MapView）。
export interface AmapJsConfig {
  key: string;
  securityJsCode: string;
}

declare global {
  interface Window {
    _AMapSecurityConfig?: { securityJsCode: string };
  }
}

const SDK_URL = 'https://webapi.amap.com/maps?v=2.0&key=';
/** 超时上限：地图是可选增强，等太久不如直接降级 */
const LOAD_TIMEOUT_MS = 8_000;

let pending: Promise<void> | null = null;

/** 加载高德 JS API；同一页面内多次调用共享同一次加载。失败后清缓存，下次挂载可重试。 */
export function loadAmapSdk(config: AmapJsConfig): Promise<void> {
  if (pending) return pending;
  pending = new Promise<void>((resolve, reject) => {
    window._AMapSecurityConfig = { securityJsCode: config.securityJsCode };
    const script = document.createElement('script');
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      script.remove();
      pending = null; // 允许下次挂载重试
      reject(new Error(message));
    };
    timer = setTimeout(() => fail('高德 JS API 加载超时'), LOAD_TIMEOUT_MS);
    script.src = `${SDK_URL}${encodeURIComponent(config.key)}`;
    script.async = true;
    script.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    script.onerror = () => fail('高德 JS API 加载失败');
    document.head.appendChild(script);
  });
  return pending;
}
