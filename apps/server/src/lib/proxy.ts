// 出站代理支持：开发机常见「系统代理」环境（HTTP_PROXY/HTTPS_PROXY）下，
// Node fetch(undici) 默认不认代理环境变量 —— 此处显式接管全局 dispatcher。
// localhost 默认豁免（本地 Ollama 等直连），站长可用 NO_PROXY 覆盖。
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

const hasProxy = Boolean(
  process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy,
);

if (hasProxy) {
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      noProxy: process.env.NO_PROXY ?? process.env.no_proxy ?? 'localhost,127.0.0.1,::1,host.docker.internal',
    }),
  );
}
