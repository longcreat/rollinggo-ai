import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { env } from '@tripweaver/core/env';
import { dataStore, mediaObjectKey } from '@tripweaver/core/lib/dataStore';
import { mediaCacheControl, mediaContentType } from '@tripweaver/core/lib/mediaStore';
import { setAmapLogger } from '@tripweaver/integrations/amap/request';
import { setQWeatherLogger } from '@tripweaver/integrations/qweather/client';
import '@tripweaver/core/lib/proxy';                        // 需在任何出站 fetch 之前接管代理
import '@tripweaver/core/db/client';                       // 触发建库与迁移
import { installApiResponses } from './http/apiResponse';
import { authRoutes } from './routes/auth';
import { conversationRoutes } from './routes/conversations';
import { settingsRoutes } from './routes/settings';
import { tripRoutes } from './routes/trips';
import { usageRoutes } from './routes/usage';
import { destinationRoutes } from './routes/destinations';
import { generationRoutes } from './routes/generations';
import { notificationRoutes } from './routes/notifications';
import { promptParseRoutes } from './routes/promptParse';
import { expireOrphanQuestions } from '@tripweaver/agent/chat/agent/questionStore';

/**
 * TripWeaver 服务端进程入口。
 *
 * 启动顺序有依赖关系，改动前先看清：
 * 1. `./lib/proxy`、`./db/client` 是**副作用导入**，必须在读取 env / 出站 fetch 之前完成
 *    （前者装全局代理 dispatcher，后者建库并跑迁移）。
 * 2. 先装 `installApiResponses`（onSend 包装 + 错误处理），再注册路由 —— 它作用于所有 /api 响应。
 * 3. 生产模式下前端产物与 `/media` 静态托管注册在路由之后，靠 setNotFoundHandler 做 SPA 回退。
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const app = Fastify({
    logger: { level: env.isProd ? 'info' : 'debug' },
    // 生产部署 app 前必有可信反代（compose 只绑 127.0.0.1 + 宿主 nginx / release 版内置 nginx，两者都发 X-Forwarded-For）。
    // 不信任代理头时 request.ip 恒为反代地址，所有限流（登录/验证码/路线选项）会全站共享一个桶（11-03 审查实测 bug）。
    // 代价：绕过反代直连容器网络的调用方可伪造 X-Forwarded-For —— 该拓扑下不构成新攻击面。
    trustProxy: true,
  }).withTypeProvider<TypeBoxTypeProvider>();
  setAmapLogger(app.log);
  setQWeatherLogger(app.log);

  // 上一个进程留下的 HITL 问题不可能再被回答：启动时统一标过期，避免前端反复拿到问题卡。
  await expireOrphanQuestions()
    .then((expired) => { if (expired) app.log.info({ expired }, 'stale HITL questions expired'); })
    .catch((error) => app.log.warn({ error }, 'expire stale HITL questions failed'));

  await app.register(cookie);
  await app.register(rateLimit, { global: false });

  // 统一响应信封 + 全局错误处理：必须在业务路由注册前装上
  installApiResponses(app);

  // 健康检查带 commit/buildDate：容器里 `docker inspect` 之外也能确认跑的是哪个镜像
  app.get('/api/health', async () => ({
    ok: true,
    name: 'tripweaver',
    time: Date.now(),
    commit: process.env.COMMIT_SHA ?? 'unknown',
    buildDate: process.env.BUILD_DATE ?? 'unknown',
  }));

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(settingsRoutes, { prefix: '/api/settings' });
  await app.register(tripRoutes, { prefix: '/api/trips' });
  await app.register(conversationRoutes, { prefix: '/api/conversations' });
  await app.register(usageRoutes, { prefix: '/api/usage' });
  await app.register(destinationRoutes, { prefix: '/api/destinations' });
  await app.register(generationRoutes, { prefix: '/api/generations' });
  await app.register(notificationRoutes, { prefix: '/api/notifications' });
  await app.register(promptParseRoutes, { prefix: '/api/chat' });

  // 生产模式：托管前端构建产物 + SPA fallback
  const webDist = path.resolve(__dirname, '../../web/dist');
  if (env.isProd && fs.existsSync(webDist)) {
    // 无 maxAge 时连 Vite 带 hash 的产物也返回 max-age=0，Cloudflare 边缘随之不缓存（实测 cf-cache-status: DYNAMIC）。
    // assets 文件名带内容 hash → 一年 immutable；无 hash 的品牌图/分享图 7 天；index.html 保持不缓存，发布即可生效。
    await app.register(fastifyStatic, {
      root: webDist,
      // cacheControl: false 是必需的：@fastify/send 在 setHeaders 之后才回写自己生成的 Cache-Control，
      // 开着就会把下面设的头覆盖回 max-age=0（实测过）。
      cacheControl: false,
      setHeaders: (res, filePath) => {
        const normalized = filePath.replace(/\\/g, '/');
        if (normalized.includes('/assets/') || normalized.includes('/fonts/')) {
          // Vite 产物与手写体/标题字体分片文件名都带内容 hash
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (/\/(brand|share-styles)\//.test(normalized) || /\/home-bg\.(webp|png)$/.test(normalized)) {
          res.setHeader('Cache-Control', 'public, max-age=604800');
        } else res.setHeader('Cache-Control', 'public, max-age=0');
      },
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.raw.url?.startsWith('/api/')) {
        return reply.code(404).send({ error: 'Not Found' });
      }
      return reply.sendFile('index.html');
    });
  }

  // 库内景点封面（09-27）：本地模式直接托管仓库 data/media（已 gitignore），dev 与 prod 都注册。
  // 对象存储模式同一前缀改为按 key 从存储读取 —— 存量行程快照里存的 `/media/…` 因此继续可用。
  // decorateReply: false：避免与上面的前端产物注册抢 sendFile 装饰（只有一个 fastify-static 能装饰）。
  const mediaRoot = path.resolve(__dirname, '../../../data/media');
  if (env.mediaStore.mode === 's3') {
    app.get('/media/*', async (request, reply) => {
      const key = mediaObjectKey((request.params as Record<string, string>)['*'] ?? '');
      const bytes = key ? await dataStore.get(key).catch(() => null) : null;
      if (!key || !bytes) return reply.code(404).send({ error: 'Not Found' });
      return reply.type(mediaContentType(key)).header('Cache-Control', mediaCacheControl(key)).send(bytes);
    });
  } else {
    fs.mkdirSync(mediaRoot, { recursive: true });
    if (fs.existsSync(mediaRoot)) {
      await app.register(fastifyStatic, { root: mediaRoot, prefix: '/media/', decorateReply: false });
    }
  }

  await app.listen({ port: env.port, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
