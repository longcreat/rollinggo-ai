# 媒体存储对象化（CDN 反代 + 对象存储适配器）

## Goal

现在图片字节只存在宿主机 `data/media/`，容器里以 `:ro` 挂载，线上因此出现三类问题：写入侧（Pexels/维基）静默失效、`remote-photos` 触顶 256 MiB 后拒绝新图、无法多实例。本任务分两步把媒体存储解耦：**方案1** 用 CDN 反代 `/media`（零代码，先拿边缘缓存与带宽剥离），**方案2** 引入对象存储适配器（S3 兼容，R2 / OSS / COS / 自建 MinIO 任选），让读写都脱离单机磁盘。

用户已确认方向：方案1 + 方案2 一起做。

## What I already know

### 现状架构（已核对代码）

- 数据库只存**相对 key**（`canonical_places.payload.coverImage`，形如 `xhs/杭州/8f3a1b2c/00.webp`），展示 URL 由 `mediaUrl()` 在**读取时**拼前缀 — `apps/server/src/generation/storedCover.ts:15`，前缀来自 `env.mediaBaseUrl`（`MEDIA_BASE_URL`，默认 `/media`，已剥尾部斜杠），见 `apps/server/src/env.ts:143`。
- `/media/` 由同进程 fastify-static 托管：`apps/server/src/index.ts:71`（`path.resolve(__dirname, '../../../data/media')`），dev 与 prod 都注册。
- 容器挂载：`./data/media:/app/data/media:ro`，唯一可写例外 `./data/media/share-posters`（`docker-compose.yml:30-31`）；`docker-compose.release.yml:21` 只有只读挂载，**没有** share-posters 子挂载。
- `data/` 整个目录在 `.gitignore:3` 里，无 tracked 文件；仓库无 `.dockerignore`（CI checkout 无 `data/`，所以镜像里也没有）。
- 本地实际体量：1163 个文件 / 292.9 MiB（`remote-photos` 990 / 256.00 MiB、`xhs` 90 / 13.56 MiB、`photography` 41 / 14.02 MiB、`share-posters` 4 / 8.22 MiB、`wikimedia` 38 / 1.29 MiB）。
- 没有用户上传功能。图片全部来自：上游 xhs-pipeline 离线导出、人工精选脚本、运行时抓取（Pexels/Pixabay/维基）。高德 POI 图是外链热链，不落地。

### 需要改的 6 个磁盘 I/O 点

| 文件 | 现在的磁盘行为 |
| --- | --- |
| `apps/server/src/services/sharePosterStore.ts:34` | 写/删 `data/media/share-posters/<sha256>.<ext>` |
| `apps/server/src/integrations/photoStore.ts:11,48,86` | 写 `data/media/remote-photos/`；`validLocal()` 读回文件校验 sha256；`arena` 用 `readdir` 统计容量 |
| `apps/server/src/integrations/wikimedia/imageCache.ts:6,57` | 写 `data/media/wikimedia/` + `.json` sidecar；`readdir` 统计容量 |
| `apps/server/src/integrations/photoCollection.ts:162-166` | **读**本地文件字节做视觉审核与哈希 |
| `apps/server/src/integrations/photoEnrichment.ts:40-44` | 把 CDN 前缀**反向拼回** `/media/` 再读原文件 |
| `apps/server/src/index.ts:68-77` | `/media/` 静态路由本身 |

另需一并处置的非图片索引：`data/photo-store/**/*.json`（本地 1600+ 个：sources 1740、visual-reviews 3035、review-search 1184、review-jobs 303、reviewed 298、review-reports 298 等），根路径硬编在 `stockPhotoSupport.ts:14`（`PHOTO_DATA`）与 `photoStore.ts:11`（`DATA`），**无 env 覆盖**。

### 已确认的坑（都会影响方案设计）

1. **存量行程快照存的是解析后的路径，不是 key。** `researchTools.resolveCover` 把 `coverUrl` 写进 `Trip.overview` 时已经是 `mediaUrl(key)` 的结果（`/media/...`）。所以换 `MEDIA_BASE_URL` 之后 `/media` 路由**不能删**，否则历史行程图全 404。两者别混：`payload.coverImage` 是 key（可换前缀），快照里的 `coverUrl` 是成品 URL。
2. **有些链路要字节，不只是 URL。** `photoEnrichment.ts:41` 已经写着「MEDIA_BASE_URL 可能指向 CDN；此处还原本地 key，仅后台读取原文件」。视觉审核（`photoCollection.ts:162`）与 `validLocal()` 的 sha256 校验都依赖本地文件。纯 CDN 挡不住这几条。
3. **海报下载可能被跨域打断。** 前端 `downloadShareImage` 下的是同源静态 URL，跨域后 `<a download>` 失效，需 CDN 带 CORS / `Content-Disposition`。
4. **`remote-photos` 已触顶。** `MAX_CACHE_BYTES = 256 MiB`，实际 268,432,913 / 268,435,456 字节，**只剩 2543 字节**；超限直接 `return null` 放弃落盘，**没有淘汰机制**。下一张 Pexels 图基本落不下来。
5. **线上写入侧等于失效。** 容器里 `data/media` 只读，维基缓存与 Pexels 落盘会 EROFS；两条链路都 catch 后 warn 并返回空（`wikimedia/cover.ts:187` 返回 `null`、`pexels/cover.ts:185` 返回 `[]`），不报错。结论：线上实际只剩「库内封面 + 高德外链」两路。
6. **`data/photo-store/` 未挂载** → 容器重建后索引全丢（海报成品不受影响，索引在 PG 表 `trip_share_images`）。

### 已有测试证据

- `apps/server/src/__tests__/storedCover.test.ts:15-31` 已覆盖 `mediaUrl` 三种 base：`/media`、`https://cdn.example.com`、空串，含尾斜杠与前导斜杠归一。
- `apps/server/src/__tests__/photoStore.test.ts` 用 `fs.mkdtemp` 造临时根，通过 `root` 参数注入 —— 适配器抽象可以沿用同一注入点。
- `apps/server/src/__tests__/integration-guidelines.md:670-672` 记录了 `mediaUrl` 的 base 断言口径。

## Assumptions (temporary)

已由用户确认，升级为事实：

- 线上是**海外 VPS** + Docker Compose（`nginx.host.conf` 前置反代），单机非多实例。
- **域名已托管在 Cloudflare DNS**，因此 R2 自定义域名可用（如 `media.example.com`）。
- 站点面向国内用户，但服务器与 CDN 都在海外 —— 国内访问会经 Cloudflare 边缘，比国内 CDN 慢。这是本次选型的已知取舍（无备案路线）。

## Open Questions

全部已答，见 Decision。无阻塞项。

## Requirements

### 适配器

- 新增 `apps/server/src/lib/mediaStore.ts`：`put(key, bytes, contentType?)` / `get(key)` / `delete(key)` / `exists(key)`；`list` 只在迁移脚本里用，不进运行时接口。
- 两个实现：`local`（现有磁盘行为，**默认**）与 `s3`（`@aws-sdk/client-s3`、path-style 端点，R2 / MinIO / S3 通用），由 `MEDIA_STORE` 选择。
- 6 个磁盘 I/O 点全部改走适配器；需要字节的链路（`photoCollection` 视觉审核、`photoStore.validLocal` 哈希校验、`photoEnrichment` 回读）改用 `get(key)`，不得只拿 URL。

### Key 与缓存头

- **存储根 = `data/`**（即既有 `root` / `dataRoot` 注入点：`media/` 与 `photo-store/` 都在它下面），桶内布局与宿主机磁盘一一对应，迁移就是 `aws s3 sync data/ s3://bucket/`。
- 媒体对象 key = `media/<库里存的相对 key>`（如 `media/xhs/杭州/8f3a/00.webp`）；图源索引 key = `photo-store/<原路径>`。库里 `payload.coverImage` 仍是 `xhs/…` 不变。
- `/media/<key>` 路由只调 `store.get('media/' + key)`，**结构上够不到** `photo-store/`，因此不再需要额外的 key 白名单。
- `MEDIA_BASE_URL` 语义不变（默认 `/media`）：同源时走 Node 路由，指向 R2 时填 `https://media.example.com/media`（R2 自定义域名映射 bucket 根，不支持路径前缀）。
- 缓存头：内容寻址的四类（`photography/<placeId>/<hash>.webp`、`remote-photos/<sha>`、`wikimedia/<sha>`、`share-posters/<sha>`）用 `public, max-age=31536000, immutable`；`xhs/<city>/<placeId>/NN.webp` 用 `public, max-age=86400`（上游重导会替换同名文件，不能 immutable）。

### 读取与兜底

- `MEDIA_BASE_URL` 指向 R2 自定义域名（`https://media.example.com`）。
- `/media/...` 兼容兜底：反代层（`nginx.host.conf` 与 `docker-compose.release.yml` 的 Caddyfile）加 `/media/*` → 302 到 CDN 域名，带 `Cache-Control: public, max-age=3600`。不用 301：`xhs/` 的文件内容会变，永久重定向以后难回退。
- Node 侧 `/media` 路由在 `local` 模式下保持不变。
- 海报下载：CDN 域名加 CORS（GET/HEAD，站点 origin），前端下载改为 `fetch` → `blob` → object URL（跨域下 `<a download>` 会被忽略）。

### 容量与迁移

- 去掉 S3 模式下的 `MAX_CACHE_BYTES` 上限与 `readdir` 容量统计（256 MiB 是给本地磁盘设的；R2 存储便宜且出流量免费）。
- 新增 `apps/server/scripts/migrate-media-to-s3.mts`：`data/media` + `data/photo-store` 全量上传；幂等判据从「大小一致」升级为「单段上传的 ETag（内容 md5）一致」，因为索引类 JSON 会被就地改写而长度可能不变（本地无 ETag 时退化为比大小）；输出「桶内多出」清单（只报告不删除）。
- 一次性全量 sync 后切 `MEDIA_STORE=s3`；宿主机 `data/media` 保留供回滚，确认稳定后再删。
- 未配桶时行为与现在完全一致；CI 与本地开发不依赖对象存储。

## Acceptance Criteria

- [x] `MEDIA_STORE=local` 下全部现有测试通过：`typecheck`、`--full` 655/655、`--flow` 268/268、`verify-place-identity` 22/22。
- [x] 新增适配器单测（`mediaStore.test.ts` 8 条）+ S3 实现单测（`s3MediaStore.test.ts` 8 条，替身 fetch，不依赖真实 R2）。
- [x] 假存储的 `get` 被调用可作为证据：视觉审核与 sha256 校验在存储模式下确实拿到字节（旧实现下会失败）。
- [ ] `MEDIA_STORE=s3` 且配了测试桶时，海报成品、Pexels/维基入选图、`photo-store/` 索引全部落到桶，且桶内 key 与旧路径一一对应。（待 PR3 真机验证）
- [ ] 迁移脚本重复执行不产生重复对象；能报告「本地有、桶里没有」。（PR3）
- [ ] 配 `MEDIA_BASE_URL=https://media.example.com/media` 后新生成行程封面走该域名；旧快照 `/media/...` 仍 200。（待 PR3 真机验证；路由侧已就位）
- [x] `photo-store/` 下的对象无法通过 `/media/` 取到（路由只拼 `media/` 前缀，结构上够不到）。
- [ ] 海报在跨域 CDN 下仍能触发下载（CORS + fetch/blob 路径）。（PR3）
- [ ] 回滚演练：`MEDIA_STORE=local` + 数据同步回宿主机后，站点恢复旧行为。（PR3）

## Definition of Done (team quality bar)

- 测试新增/更新（适配器单测 + 关键链路注入假存储）
- typecheck / lint 通过
- 新约定（key 命名、缓存头、降级顺序）写入 `.trellis/spec/`
- 回滚路径明确（env 指回本地实现即可，不删桶）
- 部署文档更新（README 部署章节 + `deploy.sh` 的验收段）
- 用户验收后才提交

## Technical Approach

### 为什么方案1 在 R2 下几乎被方案2 吸收

R2 自带 Cloudflare CDN 与自定义域名，所以「CDN 反代 `/media`」不再需要单独的 nginx/CF 规则：**`MEDIA_BASE_URL` 直接指向 R2 自定义域名就是方案1**。

### 保留站点 `/media/` 路由作为兼容代理（关键决策）

存量行程快照里存的是**解析后的** `/media/...` 路径（不是 key），不能靠换 `MEDIA_BASE_URL` 修正。而「桶为唯一真源、本地不留副本」意味着宿主机 `data/media` 会消失，旧快照会 404。所以：

- `apps/server/src/index.ts` 的 `/media/` 路由**保留**，实现从「本地文件」改为「按 key 从桶取」（流式返回或 302 到签名 URL）。
- `MEDIA_BASE_URL=https://media.example.com`（R2 自定义域名）→ 新生成的数据直接走 CDN。
- 两条入口读同一个桶，不产生第二份真源；旧快照走站点代理、新数据走 CDN，各自都对。
- 替代方案（把历史快照的 `coverUrl` 批量改写成绝对 CDN 地址）需要改动用户数据、且会让「切回本地实现」变难，不采纳。

### 适配器形状

`apps/server/src/lib/mediaStore.ts`（新）暴露 `put(key, bytes, options?)` / `get(key)` / `delete(key)` / `exists(key)` / `list(prefix)`（`list` 供后台审核队列与审核目录枚举，不是迁移专用）。两个实现：

- `localMediaStore`：现有磁盘行为，`.env` 未配桶时使用，保证 CI 与本地开发零外部依赖。
- `s3MediaStore`：`aws4fetch`（SigV4 签名，约 3 KB）+ 全局 fetch，R2 / MinIO / S3 通用、path-style 端点。

行内签名请求的 `AWS4-HMAC-SHA256` 形状、中文 key 的单次百分号编码、ListObjectsV2 分页与 404/5xx 语义由 `apps/server/src/__tests__/s3MediaStore.test.ts` 用替身 fetch 钉住，不需要真实桶。

### 公开可读性

图片本来就在同源公开路径下（`share-posters` 也是内容寻址、极难猜），所以桶按公开可读配置（R2 自定义域名），不引入签名 URL 的复杂度。

**已知取舍**：自定义域名暴露整个桶根，因此 `photo-store/**` 的 JSON 索引理论上可被读（文件名是 sha256、无法枚举，内容也不是机密：图源 URL、署名与审核结论）。如果以后要彻底封掉，需要给桶加 Cloudflare Access 或把索引限制在不可公开的前缀下（目前不值得）。

## Decision (ADR-lite)

**Context**：图片字节只在单机磁盘，容器内只读，导致线上写入侧失效、容量触顶、无法多实例。用户要求 CDN + 对象存储一起做。

**Decision**：

1. **线上环境 = 海外 VPS**（无国内 ICP 备案诉求），因此国内 CDN/OSS/COS 路线排除，不引入备案依赖。
2. **对象存储 = Cloudflare R2**：S3 完全兼容、出流量免费、零运维。本地 292.9 MiB 远低于 R2 免费额度（10 GB-月存储），基本无成本（细节待官方页面核对）。
3. **读路径 = 桶为唯一真源，本地不留副本**：多实例天然一致，逻辑最简；需要字节的链路（视觉审核、sha256 校验）改为从桶 `get`。
4. **CDN = R2 自定义域名**，`MEDIA_BASE_URL` 指向它；站点 `/media/` 路由保留为兼容代理，兜住历史快照。
5. **未配桶时回落本地实现**，行为与现在完全一致，CI 不需要外部依赖。

**Consequences**：

- 顺带修掉「线上写入侧失效」与「容器内 media 只读」两个既有问题（不再写本地）。
- 视觉审核与内容哈希校验各多一次对象存储往返（毫秒级，可接受）。
- 本地开发看不到真实桶数据，需要 mock 或指向测试桶；测试一律注入假实现。
- 回滚 = `MEDIA_STORE=local` + 把 `data/media` 同步回宿主机，不删桶。

## Out of Scope (explicit)

- 不引入图片处理/转码服务（现状是离线转码 + 上游导出）。
- 不做图片历史版本管理（海报仍只保留最新一张）。
- 不做孤儿文件清理（既有行为，仅记录）。
- 不做对象生命周期 / LRU 淘汰策略（桶无容量压力，去掉上限即可）。
- 不加签名 URL / 防盗链（图片本来就公开可读）。
- 不迁移到阿里云 OSS / 腾讯 COS（已排除，无备案）。
- 不改 `MEDIA_BASE_URL` 以外的数据模型；`payload.coverImage` 仍是相对 key。
- 海报成品跟其他图片一样用 `MEDIA_BASE_URL`（库里只存 `fileName`，换前缀不动数据）；代价是跨域下载要自己取字节，桶必须配 `GET/HEAD` 的 CORS。
- 不做签名 URL（图片公开可读、请求不带凭据）。

## Technical Notes

- 关键文件：`apps/server/src/generation/storedCover.ts`、`services/sharePosterStore.ts`、`integrations/photoStore.ts`、`integrations/wikimedia/imageCache.ts`、`integrations/photoCollection.ts`、`integrations/photoEnrichment.ts`、`integrations/curatedPhotos.ts`、`integrations/stockPhotoSupport.ts`、`index.ts`、`env.ts`、`docker-compose.yml`、`docker-compose.release.yml`、`.env.example`
- 现有 spec：`.trellis/spec/server/backend/rag-guidelines.md`（§stored cover / `/media` 路由 / MEDIA_BASE_URL 契约，含「写相对 key、绝不写 URL」的反例）、`.trellis/spec/server/backend/integration-guidelines.md`（封面四源顺序）
- 相关任务：`.trellis/tasks/archive/2026-10/10-06-place-identity-governance/`（层2 坐标与图库链路）
- 研究：Tavily 搜索两次被 429 限流，`research/` 未产出；R2 的定价与自定义域名细节待实现时按官方页面核对（本地 292.9 MiB 远低于 R2 免费额度，预计零成本）。

### 实施进度

- **已完成（PR1 + PR2 合并为一次提交）**
  - `lib/mediaStore.ts`：`MediaStore`（`put` / `get` / `delete` / `exists` / `list`）、`normalizeMediaKey`、`mediaCacheControl`、`mediaContentType`、`createLocalMediaStore`、`createS3MediaStore`（aws4fetch + 全局 fetch，含 ListObjectsV2 分页与 XML 取值）。
  - `lib/dataStore.ts`：进程实例（按 `MEDIA_STORE` 选实现）、`mediaObjectKey`（`xhs/…`、`/media/…`、CDN 完整 URL 统一到 `media/…`）、`storeScope`（进程级缓存按存储实例分租）。
  - `env.ts`：`MEDIA_STORE` + `MEDIA_S3_ENDPOINT` / `MEDIA_S3_BUCKET` / `MEDIA_S3_ACCESS_KEY_ID` / `MEDIA_S3_SECRET_ACCESS_KEY` / `MEDIA_S3_REGION`，四项缺一启动失败。`.env.example` 已同步。
  - 11 个模块的 `root` / `dataRoot: string` 全部换成 `store: MediaStore`（默认 `dataStore`）：`sharePosterStore`、`photoStore`、`wikimedia/imageCache` 与 `cover`、`curatedPhotos`、`photoCollection`、`photoReviewIO`、`reviewedPhotos`、`photoReviewQueue`、`stockPhotoSupport`、`independentPhotoSources`，以及 pexels / pixabay / unsplash 三个选片适配器与 `photoEnrichment`。
  - `index.ts`：local 模式仍走 fastify-static；s3 模式同前缀改为按 key 从存储读取（存量 `/media/…` 快照无需改数据）。
  - 删除两处旧妥协：`photoEnrichment` 里把 CDN 前缀反拼回本地路径的 hedge；`remote-photos` / `wikimedia` 的 256 MiB 容量上限与 `readdir` 统计（两种模式都移除）。
  - 测试：新增 `mediaStore.test.ts`（8）、`s3MediaStore.test.ts`（8，含 SigV4 请求形状、中文 key 单次编码、404/5xx、分页、key 归一）、`helpers/memoryMediaStore.ts`；11 个已有测试文件改为注入 `createLocalMediaStore(root)`。
  - 验证：`npm run typecheck` 通过；`verify-sql-first.mts --full` **655/655**；`--flow` **268/268**；`verify-place-identity.mts` **22/22**（含 CLI 预演/回滚用例）。
- **PR3 进度（部分完成）**
  - 已完成：`apps/server/scripts/migrate-media-to-s3.mts`（默认预演/`--apply` 上传；先 `list` 拿桶内现状再批量 `put`，不逐个 HEAD；不依赖数据库与 MASTER_KEY，只读 `MEDIA_STORE`/`MEDIA_S3_*`；显式加载仓库根 `.env` 与 `apps/server/.env`，不依赖 cwd）；`readMediaStoreConfig` 从 `env.ts` 下移到 `lib/mediaStore.ts` 以便脚本独立运行；README 部署章节新增「图片存储（对象存储 + CDN）」段；`docs/TECHNICAL_ARCHITECTURE.md` §10 环境变量表与数据卷说明；`deploy.sh` 验收段按 `MEDIA_STORE` 分支提示。
  - Cloudflare 侧（MCP 已做）：账号已启用 R2；建桶 `tripweaver-media`（WNAM）；自定义域名 `media.sakiiko.com`（ssl/ownership 均已 active，DNS 自动加 `CNAME → public.r2.dev` 已代理）；S3 凭据由用户在 dashboard 建（MCP 无 API Tokens 权限，`permission_groups` 返回 9109）。
  - 迁移已跑完：`--apply` 上传 **8337** 个对象（media 1223 + photo-store 7114，共 292.9 MiB），0 失败；复跑预演 **0 待上传 / 0 桶内多出**。
  - **海报也走 CDN（用户追加要求，已实现）**：`sharePosterUrl(fileName, base = env.mediaBaseUrl)` 改为读 `MEDIA_BASE_URL`（库里仍只存 `fileName`，换前缀不动数据）；`SHARE_POSTER_URL_PATTERN` 放宽为同时接受同源路径与绝对地址；前端 `downloadShareImage` 改为 `fetch`→blob（跨域下 `a[download]` 会被忽略），先试 CDN 地址、退回同源 `/media/...`（Node 路由从同一对象存储转发），返回是否真的发起下载供通知文案使用；桶加 CORS `origins:["*"] GET/HEAD` 并清理了 4 个先于 CORS 缓存的旧海报 URL。微信长按保存（`<img src>`）不受影响。
  - **方案1：体积报告（用户选定，不清理）**：`migrate-media-to-s3.mts --report` 按二级前缀列出对象数与体积，并给出占 R2 免费额度的百分比。首次报告：**8338 个对象 / 325.5 MB ≈ 3.18%**（`media/remote-photos` 270.4 MB 为大头）。没有任何自动过期策略，只有被替换的旧海报会被删。
  - 真机验证（本机 `PORT=8788` 起第二个实例，s3 模式）：`/media/probe-s3-only.txt`（只存在于桶）→ 200；`/media/xhs/photography/<sha>.webp` → 200 `image/webp` `Cache-Control: public, max-age=31536000, immutable`；`/media/probe-s3-only.txt` → `max-age=86400`（非内容寻址）；`/media/photo-store/visual-reviews/<sha>.json` → **404**（结构上取不到索引）。用户本机 dev server（8787）已在读 R2。
  - 待用户在 VPS 侧做：更新 `.env` 后 `docker compose pull && docker compose up -d`；**VPS 上累积的 `data/media/share-posters/`（若有）需单独迁移**，否则库里已有的海报行会 404。
  - **反代层 `/media/*` 302：取消**。Node 路由已能从桶取对象，存量快照直接可用；302 只省服务器带宽，且会给每张图加一跳。有需要再作为独立优化做。
  - **海报跨域下载：需要改代码（推翻我之前的判断）**。用户明确要求海报也走 CDN 后，`sharePosterUrl()` 改读 `MEDIA_BASE_URL`，于是海报变为跨域资源 —— `a[download]` 被忽略，必须 fetch→blob；桶的 CORS 从「不需要」变为「需要（GET/HEAD）」。
  - 测试与验证（追加）：`tripShareImage.test.ts` 新增「URL 前缀跟随 `MEDIA_BASE_URL`，两种前缀都过共享校验」（18/18）；`trip-share-image-browser.mjs` 全绿 —— 这是本轮真正的端到端证明（跨域下载、失败不遗留链接节点、微信长按保存、退出后迟到下载不执行）；`verify-sql-first.mts --full` **656/656**；`npm run typecheck` 通过。
  - 验证过程中查出并修掉两个真实缺陷：
    1. 用 `window.open(image.url)` 做下载兜底会额外打开一个标签页，并使 `trip-share-image-browser.mjs` 的退出登录段失败（该段断言页面上只有一个「登录」按钮）。已改为只返回 false，由调用方提示错误与重试入口（完成提醒本就有「图片暂不可用」按钮）。
    2. `createLocalMediaStore.put` 并发写同一 key 时偶发 `EPERM`（Windows 上 rename 目标恰被另一写入者持有），单测间歇失败。改为带退避重试：`EPERM` 当瞬时错误重试，`EEXIST` 才先删再 rename，上限 8 次。40 轮 × 8 并发压力脚本 0 失败，单测连跑 20 次全绿。
  - `trip-share-image-browser.mjs` 就绪等待由 5s 提到 20s：改 web 源码后 Vite 首次预构建会超过 5s，测试会随机死于 `ERR_CONNECTION_REFUSED`（本轮碰上一次）。

### 与初稿的偏差

- **S3 客户端用 `aws4fetch`（约 3 KB）而不是 PRD 初稿写的 `@aws-sdk/client-s3`（约 10 MB）** —— 只需要 PUT/GET/DELETE/HEAD/ListObjectsV2，用不上 AWS SDK 的分片上传与重试栈；`package.json` 只多一个依赖。
- **"先字节后索引"的两步拆分合并为一次**：`root` / `dataRoot` 是同一个参数，字节与索引在 `saveRemotePhoto` / `readPhotoSelection` 这类函数里成对出现，分两步反而要引入临时的 `{ root, store }` 双参数再拆掉。测试全套只需 3 秒，一次改完可验证。
- **容量上限两种模式都移除**：256 MiB 上限本来是为了宿主机磁盘，而内容寻址的文件名不可能重复写入，留着只会静默拒图。

### 需要用户手动完成的前置（我无法代做）

1. 在 Cloudflare 建 R2 bucket（如 `tripweaver-media`）。
2. 给 bucket 配自定义域名 `media.example.com`（域名已在 CF DNS，只加一条记录）。
3. 配 CORS：允许站点 origin 的 GET/HEAD。
4. 建一个最小权限 R2 API Token（Object Read & Write），拿到 `account_id` / `access_key_id` / `secret_access_key`。
5. 填 `.env`（实现时我给出变量清单与占位模板）。
