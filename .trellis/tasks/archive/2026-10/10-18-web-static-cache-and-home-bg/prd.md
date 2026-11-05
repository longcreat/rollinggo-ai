# 线上静态资源缓存与首页背景图优化

## 背景

2026-10-18 用 Playwright 实测 https://sakiiko.com 首屏：20 个请求 / 传输 2024KB / load 2691ms。两个最大单项：

| 资源 | 传输 | 耗时 | 响应头 |
| --- | --- | --- | --- |
| `/home-bg.png` | 988KB PNG | 2416ms | `Cache-Control: public, max-age=0` |
| Vite 输出（JS/CSS/字体 11 分片） | 928KB→287KB br / 455KB→93KB br / 600KB | 字体 2320ms | `max-age=0`，Cloudflare `cf-cache-status: DYNAMIC` |

根因：`apps/server/src/index.ts` 的 `fastifyStatic` 未配置 `maxAge`/`setHeaders`，Vite 带 hash 的产物也返回 `max-age=0`，Cloudflare 因此在边缘完全不缓存，每次访问穿透到美国源站。

## 目标

1. Vite 带 hash 的 `/assets/*` 产物返回一年 immutable 缓存，重复访问不再请求源站。
2. `/brand/*`、`/home-bg.webp`、`/share-styles/*` 等无 hash 静态文件返回 7 天缓存（可随文件更新自然失效）。
3. `index.html` 保持不缓存（SPA 入口，必须随发布更新）。
4. 首页背景图换成 WebP：988KB → 约 9KB，且视觉无差异。

## 范围外

- Cloudflare Cache Rules 面板配置（P0-2）、字体系统栈优先（P1）、CSS 瘦身（P2）。
- 不改 `/media/*`（线上 s3 模式已有 `mediaCacheControl`）。
- 保留 `home-bg.png` 原文件：`apps/web/tests/*.mjs` 仍以它作占位封面。

## 验收标准

- [x] `apps/web/public/home-bg.webp` 存在，体积 < 20KB，PSNR 对比原 PNG > 45dB。
- [x] `AppLayout.tsx`、`Modal.tsx` 的背景引用改为 `/home-bg.webp`，页面背景渲染正常（本地 `vite` 或构建后检查）。
- [x] `fastifyStatic` 对 `/assets/*` 返回 `public, max-age=31536000, immutable`，对 `/brand/*`、`/home-bg.webp`、`/share-styles/*` 返回 `public, max-age=604800`，`/index.html` 仍为 `max-age=0`。
- [x] `pnpm --filter @tripweaver/server typecheck`（或等价命令）通过，`apps/web` 构建通过。

## 追加范围：标题字体分片重切（2026-10-18）

手写体与老宋原先按“字频/600 字”切分，单片 250-337KB，任何短标题都要拉 250KB。改为：

- Youran：城市名、景点词、高频字各自单独成片，其余按码位 96 字/片 → 76 片，最大 101KB。
- KingHwa：按码位 96 字/片 → 79 片，最大 64KB；文件名带内容 hash（可 1 年 immutable）。
- 生成脚本：`scripts/build-handwriting-font.py`、`scripts/build-title-font.py`。

验收：

- [x] 旧分片所有码位在新分片中轮廓逐点一致（6955 + 7507 码位，缺失 0、不一致 0）。
- [x] `scripts/generate-title-font-coverage.py --check` 通过。
- [x] 短标题命中量：杭州/北京/成都/南京/故宫/胡同寻味 → 1 片 26-28KB；西湖漫步 3 片 83KB；上海 · 外滩夜景 6 片 303KB（原 686KB）。
- [x] `/fonts/**` 全部带 hash，响应头 `max-age=31536000, immutable`。

## 复核记录（2026-10-18，提交前重跑）

代码已在 `68914ba`（静态资源分层缓存）、`475bbfe`（首页背景图改 WebP）、`96cf69a`（字体分片重切）入库，本次只复核 + 归档：

- `home-bg.webp` 8.7KB（原 PNG 987.4KB）；`AppLayout.tsx:41` 与 `Modal.tsx:34` 均引用 `/home-bg.webp`
- `npm run build -w apps/web` 通过（5.10s）
- `NODE_ENV=production` 临时实例（:8799）实测响应头：

| 路径 | Cache-Control |
|---|---|
| `/assets/index-*.js` | `public, max-age=31536000, immutable` |
| `/fonts/kinghwa/part-00-*.woff2` | `public, max-age=31536000, immutable` |
| `/fonts/handwriting/*` | `public, max-age=31536000, immutable` |
| `/brand/logo-bird.png` | `public, max-age=604800` |
| `/share-styles/*` | `public, max-age=604800` |
| `/home-bg.webp` | `public, max-age=604800` |
| `/index.html` | `public, max-age=0` |

注意：静态托管仅在 `env.isProd` 下启用，dev 实例请求这些路径会落到 SPA fallback（返回 index.html + `max-age=0`），复核缓存头必须用 `NODE_ENV=production` 起实例。
