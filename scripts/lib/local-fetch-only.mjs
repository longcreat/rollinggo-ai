// 测试服务的启动预加载：未配置地图时仍有公共地理/封面兜底，验收只允许本机 mock。
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    return Promise.reject(new Error('Public provider disabled by verification'));
  }
  return originalFetch(input, init);
};
