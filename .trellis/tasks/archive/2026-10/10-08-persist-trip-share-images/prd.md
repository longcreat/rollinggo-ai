# 分享海报服务端持久化与打开回显

## 用户要求（2026-10-08）

已生成过海报的行程，再次点「分享行程 → AI 生成海报」应直接回显成品图。当前该状态只存在于前端模块级 `Map`（`apps/web/src/lib/shareImageJobs.ts`），刷新页面即丢失；服务端也只有进程内 `TtlCache`（30 分钟 / 8 条），重启即丢失。要求改为服务端持久化：图片落盘 + 落库，打开弹窗时查询已有成品直接回显。

## 已确认决策

1. **存储介质**：本地磁盘 `data/media/share-posters/`，复用现有 `/media/` 静态通道（`apps/server/src/index.ts` 已注册，dev 与 prod 都生效）。
2. **接口返回**：改为 URL。`TripShareImageResponse` 由 `{ dataUrl, mimeType }` 变为 `{ url, mimeType }`，`dataUrl` 字段删除。
3. **保留策略**：同一行程同一风格只留最新一张，重新生成时 upsert 记录并删除磁盘旧文件。

## 契约变更

- `packages/shared/src/schemas.ts`：`TripShareImageResponseSchema` 改为 `{ url: string, mimeType }`；`url` 只允许站内静态前缀（`/media/share-posters/`）。
- `POST /api/trips/:id/share-image`（既有）：语义不变，响应改为 URL。`regenerate: true` 仍强制重新生成。
- `GET /api/trips/:id/share-image?style=<journal|ink>`（新增）：返回该行程该风格的成品；无成品、内容已变更（prompt hash 不匹配）或文件丢失时 404 `{ error }`。需要 `requireAuth` + `userId` 所有权谓词，未拥有统一 404。

## 数据模型

新表 `trip_share_images`（`schema.ts` + `migrate.ts` 双改，启动幂等迁移）：

| 列 | 说明 |
| --- | --- |
| `trip_id` + `style` | 复合主键，天然实现「只留最新一张」 |
| `user_id` | 所有权过滤谓词 |
| `prompt_hash` | `sha256(buildTripSharePrompt(trip, style))`，内容变更即失效 |
| `file_name` | `<sha256(bytes)>.<ext>`，内容寻址 |
| `mime_type` | `image/png` / `image/jpeg` / `image/webp` |
| `created_at` | timestamptz |

磁盘文件：`data/media/share-posters/<sha256>.<ext>`，写入用临时文件 + rename（与 `photoStore` 同模式），读取前校验哈希与大小。

## 服务端流程（`tripShareImageService`）

1. 计算 `prompt` 与 `promptHash`。
2. 查库：命中且 `prompt_hash` 一致、文件存在、`regenerate !== true` → 直接返回 URL（不打模型、不写盘）。
3. 未命中 → 沿用现有并发闸门（同行程进行中请求合并、并发上限 2）。
4. 生成成功 → 原子写盘 → upsert 库（同 `trip_id` + `style` 覆盖）→ 删除被替换的旧文件 → 返回 URL。
5. 生成失败 → 保留库中已有成品与文件，错误照旧抛出。
6. 移除内存 `TtlCache`（持久层已是缓存，且内存缓存不跨副本）。

生成层 `encodeShareImage` 由「拼 dataUrl」改为返回字节与 mimeType，`dataUrl` 拼接职责随响应契约一起下线。

## 前端行为

- `shareImageJobs` 的 `result.image` 改为 `{ url, mimeType }`；打开弹窗或切换风格时先 `GET` 查询已有成品，命中即写入 store 并直接显示成品视图。
- 同一会话内继续保留内存 job（生成中状态不因关闭弹窗中断）；`regenerate`、自动下载、`delivered` 去重逻辑不变。
- `downloadShareImage` 改为下载同源 URL；微信「长按保存」照旧（`<img src>` 不变）。
- 刷新后必须能直接看到成品（本任务的核心验收点）。

## 部署

`docker-compose.yml` 当前把 `./data/media` 以 **只读** 挂载（`data/media` 是上游导出的同步目录）。新增可写子目录挂载：

```yaml
- ./data/media/share-posters:/app/data/media/share-posters
```

否则生产环境写盘失败。

## 验证

- `npm run typecheck`（shared + server + web）。
- `MASTER_KEY=<64 位十六进制> node --import tsx --test apps/server/src/__tests__/tripShareImage.test.ts`：需同步改造既有用例（注入内存 store 替代真实磁盘与数据库）。
- `node apps/web/tests/trip-share-image-browser.mjs`：mock 需新增 `GET` 与 `/media/**` 路由；新增「刷新后直接回显成品」断言。

## 非目标

- 不做对象存储（S3/OSS），不做多实例共享。
- 不做历史成品回溯（只留最新一张）。
- 不清理已生成但行程已删除的孤儿文件（后续独立任务）。
- 不改生图模型、提示词、风格定义与并发/额度策略。
