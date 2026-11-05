## 背景

用户发现「已生成海报直接回显」只存在于前端模块级 `Map` 与服务端进程内 `TtlCache`（30 分钟 / 8 条），刷新页面即丢失。

## 实施（任务 10-08-persist-trip-share-images）

- shared：`TripShareImageResponseSchema` 由 `{dataUrl,mimeType}` 改为 `{url,mimeType}`，新增 `TripShareImageQuerySchema` 与 `SHARE_POSTER_URL_PATTERN`。
- server：新增 `trip_share_images` 表（主键 `trip_id + style`，同一行程同一风格只留最新一张），`schema.ts` / `migrate.ts` 双改；新增 `services/sharePosterStore.ts`（内容寻址落盘 `data/media/share-posters/<sha256>.<ext>` + upsert + 删除被替换的旧文件）；`createTripShareImageService(store, generate?)` 改为注入 store、移除内存 `TtlCache` 与 dataUrl 拼接；新增 `GET /api/trips/:id/share-image?style=`，无成品或行程内容已变时 404。
- web：`shareImageJobs` 改为校验并保存 URL，新增 `loadShareImage`（打开弹窗 / 切换风格时查询服务端成品）；`ExportDialog` 使用 `currentResult.url`；`downloadShareImage` 改为下载同源静态 URL。
- 部署：`docker-compose.yml` 为 `data/media/share-posters` 增加可写子挂载（父目录 `data/media` 是只读挂载）。

## 验证

- `npm run typecheck` 通过；`npm run build` 通过。
- `MASTER_KEY=<64 位十六进制> node --import tsx --test apps/server/src/__tests__/tripShareImage.test.ts`：16/16 通过，含新增的「成品命中不重新生成」「行程内容变化不回显」「他人账号不可见」。
- `node apps/web/tests/trip-share-image-browser.mjs`：通过，含新增的「刷新后直接回显已保存海报且不触发生成」断言。
- `node --import tsx scripts/verify-trip-share-image.mts`：需要本地 18797 端口 PostgreSQL，本次未运行（该端口无实例）。

## 遗留

- 行程删除后的孤儿图片文件不清理；并发锁仍是进程内，未做多实例共享（PRD 非目标）。
- 上一个误建的任务目录 `.trellis/tasks/10-08-share-trip-button-icon-order/` 待删除。
