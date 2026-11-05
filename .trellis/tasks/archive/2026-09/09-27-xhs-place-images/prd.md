# 接入上游景点图片（storedCover + 图片 manifest）

## Goal

生成页的候选卡片目前拿不到真实照片：`storedCover` 钩子存在但恒返回 null，维基降级又因 `upload.wikimedia.org` 在国内被封锁而必然失败，前端只剩类目占位图标。上游 `xhs-travel-pipeline` 已经把小社区笔记里的风景图下载到本地并做了 CLIP 分类 + 景点关联（884 张 / 313MB / 北京·广州·杭州），这份资产没接进来。本任务把它做成一条可重复的导出→导入→渲染链路。

## What I already know

* `storedCover` 钩子已就位：`researchTools.ts:66` 注释写着「库内封面（未来 canonical_places 补图后由调用方提供）」，orchestrator 目前没注入 → 恒 null。
* 封面优先级：`storedCover` → 中文维基实时检索 → 空。只对 `category === 'attraction'` 走（`researchTools.ts:275`）。
* 硬约束：`resolveCover` 用 `isHttpUrl(stored)` 校验后 `slice(0, 300)` —— **返回本地文件路径会被丢弃**，必须有 HTTP 通道。
* `upload.wikimedia.org` 在国内全面封锁（维基媒体官方帮助页列明媒体服务器 IP 198.35.26.112 / 208.80.154.240 均被封）→ 维基降级只对海外/代理环境有效，不能作为主路径。
* `canonical_places.payload` 是自由 jsonb，无字段白名单；seed 已实现幂等 upsert + `data_import` 版本记录 + `check-data-freshness.ts` 对比。
* `import/` 已被 `.gitignore` 忽略；seed 直连远程 Neon Postgres 执行 —— **DB 与图片文件天然不在同一台机器**。
* `data/` 已被 `.gitignore` 忽略（`!apps/server/src/data/` 例外），适合放图片。
* 上游图片现状：`xhs-travel-pipeline/data/images/{city}/{note_id}/NN.jpg`，884 张 / 313.22MB / 平均 363KB；`note_image` 表含 `canonical_place_id`、`img_type='scenery'`、`img_score`、`source_url`（小红书 CDN 原链，约 24h 过期仅作溯源）。
* 上游一键脚本 `scripts/export_and_embed.ps1` 负责「导出 → seed → 回填向量」，图片导出应并入它。
* server 已注册 `@fastify/static`，但只在 `env.isProd && webDist 存在` 时挂载前端产物，没有媒体目录通道。

## Decision (ADR-lite)

**Context**：313MB 二进制不能进 git、不能进数据库；DB（Neon）与图片文件不在同一台机器；而消费端只接受 HTTP URL。

**Decision**（用户 2026-09-27 拍板，按推荐方案）：

1. **图片落地**：`data/media/xhs/...`，server 挂 `/media` 静态路由，URL 前缀由环境变量 `MEDIA_BASE_URL` 控制 → 将来换对象存储只改环境变量，不动数据。
2. **DB 只存相对 key**：`payload.coverImage = "xhs/杭州/{placeId}/00.webp"`，不存绝对 URL（存绝对 URL 会让换存储变成全量重导）。
3. **导出时转码**：长边 1024 / webp q80，体积预期降到 1/3~1/5。
4. **每地点 1 张**（取 `img_score` 最高的 scenery 图），不做图集。
5. **独立 manifest**，不塞进 `xhs-places-{city}.json` —— 图库会持续增长，重导地点库不该重传图片。

**Consequences**：增加一步「部署时同步图片目录」的人工/脚本步骤（见 Risks）；换取的是零外部依赖、零版权外链、换存储零成本。

## Requirements

* 上游新增 `scripts/export_place_images.py`：
  * 按 `canonical_place` 分组 `note_image`，只取 `img_type='scenery'`，按 `img_score` 降序取 Top 1。
  * 转码为长边 1024 的 webp（q80），保留原始宽高比；转码失败则回退拷贝原图并记 warn。
  * 输出 manifest `D:\Project\tripweaver\import\xhs-place-images-{city}.json`，图片写入 `D:\Project\tripweaver\data\media\xhs\{city}\{placeId}\00.webp`。
  * 参数：`--city`（默认 `settings.city`）、`--out`、`--media-root`、`--max-per-place`（默认 1）、`--dry-run`。
  * 城市取 `settings.city`（与 `export_to_tripweaver.py` 一致，由 `CITY` 环境变量驱动）。
* manifest 格式固定：

  ```json
  {
    "_comment": "杭州景点封面图（xhs-travel-pipeline 离线导出，2026-09-27）。导入 canonical_places.payload.coverImage",
    "city": "杭州",
    "generatedAt": "2026-09-27",
    "count": 96,
    "images": [
      {
        "placeId": "<sha256(city+name)[:32]，与 canonical_places.id 同算法>",
        "placeName": "西湖",
        "key": "xhs/杭州/8f3a.../00.webp",
        "width": 1024,
        "height": 768,
        "bytes": 92160,
        "score": 0.91,
        "sourceUrl": "https://sns-img...（仅溯源/下线用）"
      }
    ]
  }
  ```

* `exportFiles.ts` 扩展：`ExportSource` 加 `'xhs_place_images'`，PATTERNS 加 `/^xhs-place-images-.*\.json$/`，`readExport` 的 rows 分支取 `data.images`。
  * 注意：不能与既有 `/^xhs-places.*\.json$/` 冲突（已验证两者互斥）。
* 新增 `apps/server/scripts/seed-xhs-place-images.ts`：
  * 复用 `scanExports` / `latestExports`，每城取最新一份。
  * 每行 `UPDATE canonical_places SET payload = payload || jsonb_build_object('coverImage', $2) WHERE id = $1`，**只动一个键**，不碰 `recommendScore` / `mentionCount` 等既有合并逻辑。
  * 行不存在（地点还没入库）时跳过并计数，最后一起 warn。
  * 写 `data_import`（`source='xhs_place_images'`），与业务写入同事务。
  * 幂等：重复执行结果一致。
  * **依赖顺序**：必须在 `seed-xhs-places.ts` 之后跑（否则地点行不存在）。
* 新增 `apps/server/src/generation/storedCover.ts`：
  * `createStoredCoverLookup(city)`：复用 `loadPlaceFacts([name], city)`（一次拉全城 + 归一键合并，与 `cityPointLookup` 同模式），读 `payload.coverImage`。
  * 拼 URL：`${MEDIA_BASE_URL}/xhs/{city}/{placeId}/00.webp`；`MEDIA_BASE_URL` 为空时用 `/media`（同源相对路径）。
  * 返回类型与现有 `storedCover` 签名一致（`Promise<string | null>`）。
* `env.ts` 加 `mediaBaseUrl: str('MEDIA_BASE_URL', '/media')`。
* `orchestrator.ts` 注入 `storedCover: createStoredCoverLookup(form.destination)`。
* `researchTools.ts` 的 stored 校验放宽：接受 `http(s)` URL **或** `/media/` 开头的站内路径（否则相对路径会被 `isHttpUrl` 丢弃）。维基降级路径不受影响。
* `index.ts` 注册媒体静态路由：`fastifyStatic({ root: data/media 绝对路径, prefix: '/media' })`，**dev 与 prod 都注册**（本地开发要看图）；目录不存在时跳过注册，不阻断启动。
* `export_and_embed.ps1` 加 `-WithImages` 开关，在 places 入库后追加「导出图片 → seed 图片」两步。
* 部署侧：`docker-compose*.yml` 挂载 `./data/media:/app/data/media`，`deploy.sh` 注释里补一条图片同步说明（`scp`/`rsync` 从本地上传 `data/media`）。

## Acceptance Criteria

* [ ] `python scripts/export_place_images.py`（`CITY=杭州`）产出 `import/xhs-place-images-杭州.json` 与 `data/media/xhs/杭州/{placeId}/00.webp`；文件数与 `note_image` 中 `img_type='scenery'` 且 `canonical_place_id` 非空的去重地点数一致。
* [ ] manifest 里 `placeId` 与 `canonical_places.id` 完全一致（抽查 3 个地点）。
* [ ] 转码后单张体积明显小于原图（`bytes` 有记录），总目录体积下降。
* [ ] seed 后 `canonical_places.payload->>'coverImage'` 有值，且同一行的 `recommendScore` / `mentionCount` / `aliases` 等既有键不变。
* [ ] 生成北京/杭州行程时，命中库内图的候选 `poi.coverUrl` 为 `/media/xhs/{city}/{placeId}/00.webp`，且**不发起**维基请求。
* [ ] 库内无图的地点 → `storedCover` 返回 null → 照旧走维基降级 → 失败留空 → 前端类目图标（不回归）。
* [ ] 浏览器/curl 打开 `/media/xhs/杭州/{placeId}/00.webp` 返回 200 + `image/webp`。
* [ ] 重复跑 seed 两次，`payload` 与 `data_import` 结果一致（幂等）。
* [ ] lint / typecheck / 既有测试全绿（新增单测覆盖 `storedCover` 命中与未命中、`exportFiles` 识别新产物）。

## Definition of Done

* Tests added/updated（`storedCover` 单测 + `exportFiles` 新 source 的识别测试）
* Lint / typecheck / tests green
* Spec 更新：`.trellis/spec/server/backend/integration-guidelines.md`（图片通道与 storedCover 契约）
* 部署影响已记录（volume 挂载 + 图片同步步骤）

## Out of Scope

* 对象存储 / CDN（只留 `MEDIA_BASE_URL` 这个切换点）
* 多图 / 图集 / 图片挑选 UI
* 高德 POI `photos` 补缺口（另开任务）
* food / hotel 封面（`resolveCover` 只服务 attraction）
* 前端改动（`PoiCard` 已有失败兜底，不动）
* 自动化增量抓图（抓取仍由人工触发上游脚本）
* 侵权下线机制（只保留 `sourceUrl` 溯源字段，不做管理界面）
* 图片二次处理（水印、人脸打码等）

## Risks

* **DB 与媒体文件不同步**：seed 直写 Neon，图片在本地/服务器磁盘。部署时必须同步 `data/media`，否则前台 404。缓解：dev 与 compose 用同一相对路径；`deploy.sh` 写明同步命令。
* **转码体积收益未实测**：313MB 是原图；1024/q80 的实际压缩比要跑完才知道。若 >150MB 再收紧到 800px/q75。
* **覆盖只有 3 城**：北京 21 / 广州 143 / 杭州 164 个笔记有图，成都、厦门为零。不能指望这套方案解决全部封面。
* **版权灰区**：图片源自小红书笔记，仅本地预览 + 保留 `source_url`。公开部署前需再评估。

## Technical Notes

上游（`D:\Project\xhs-travel-pipeline`）：

* `app/models.py:229` `NoteImage` —— 字段与索引（`idx_note_image_canonical`、`uq_note_image_note_idx`）
* `scripts/fetch_scenery_images.py` —— 下载 + CLIP 分类 + 转存 + 景点关联的既有实现，选图逻辑照它
* `scripts/export_to_tripweaver.py` —— 导出脚本模板（`_place_id` 与 seed 同算法 sha256(city+name)[:32]）
* `scripts/export_and_embed.ps1` —— 一键脚本

TripWeaver：

* `apps/server/src/generation/tools/researchTools.ts:80` `resolveCover`（校验 + 优先级）
* `apps/server/src/generation/orchestrator.ts:50` `cityPointLookup`（storedCover 的实现模板）、`:249` 注入点
* `apps/server/src/generation/storedCover.ts` —— 相对 key → 展示 URL（`mediaUrl`）
* `Dockerfile` WORKDIR `/app` + `npm run start`（tsx 直跑 `apps/server/src/index.ts`）→ `__dirname` 为 `/app/apps/server/src`，`../../../data/media` 落在 `/app/data/media`
* `apps/server/src/generation/scheduling/placeFacts.ts:170` `loadPlaceFacts`（一次拉全城 + 归一键合并）
* `apps/server/scripts/lib/exportFiles.ts` —— 产物识别/版本比较
* `apps/server/scripts/seed-xhs-places.ts` —— seed 模板（幂等 upsert + `data_import`）
* `apps/server/src/index.ts:56` —— fastifyStatic 现有挂载点（仅 prod 前端产物）

## Research References

* 无独立 research 文件。平台对比结论内化在本文的 Decision 段：Wikimedia（国内被墙，降级保留）· 高德 POI photos（另任务）· Pexels/Unsplash/Pixabay（中国景点无覆盖，弃）· 百度 POI 图片（付费，弃）· 上游本地图库（采用）
