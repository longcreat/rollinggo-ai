# 景点图片：高德 POI 单一来源（2026-11-05 收敛）

## 1. Scope / Trigger

`add_candidate` 为 `attraction` 候选补图、`GET /api/trips/:id` 读取时补空图，或图片 URL/配额规则变化时读这一页。

**2026-11-05 决策**：删除 Pexels / Pixabay / Unsplash / Wikimedia Commons 四个外部图库、视觉审核队列与人工选片库，只使用高德 POI `photos`。原因是人工晒图几乎为零、外部图库对国内景点命中率低且常配错图，而高德每个 POI 自带多张与地点严格对应的官方图。完整契约见
[集成指南 · Attraction Cover Sources](./integration-guidelines.md#attraction-cover-sources-amap-poi-photos-only-2026-11-05)。

## 2. Signatures

- `resolveCover(name, city, deps)`（`generation/tools/researchTools.ts`）：`search_pois` 旁路 → `payload.amapPhoto` 库内回写 → 实时高德查询，返回 `{ coverUrl, photos } | null`。
- `createAmapPoiPhotoLookup(apiKey, requestsLeft)`：`photosFor({name, city})` 返回 ≤3 张 https 图，附 `calls` 计数；命中与确认无图都缓存 24h。
- `pickPhotos(pois, name, max = 3)`：纯函数，名字闸门 + 类型闸门后按 POI 顺序取图、去重。
- `createStoredPlaceLookups(city)`：一次生成共享全城索引，只暴露 `amapPhotoFor` 与 `pointFor`。
- `enrichTripPhotos(trip, lookup)`：只补 overview 中无封面且无相册的 `attraction`，不改原对象。

## 3. Contracts

- 只有 `attraction` 查图；`food` / `hotel` 一律留空，前端回落类目图标。
- `coverUrl = photos[0]`，`photos` 为同序去重的 ≤3 张；不带 `coverAttribution`（高德是外链热链，不伪造作者）。
- 名称闸门：相同 / `endsWith` / 归一键分段按序出现；类型闸门：`type` 首段必须在
  `['风景名胜','体育休闲服务','科教文化服务','购物服务']`。
- http 统一改 https；不再接受 `/media/...` 相对路径。
- 实时查询受 `AMAP_PHOTO_MAX_PER_TASK`、`amapQueue` 串行队列、24h 缓存与 place 日预算四重约束；命中回写 `payload.amapPhoto`，未命中不回写。
- 任何失败都降级为「无图」，不抛进生成流程。
- 读路径只用库内 `amapPhoto`，零外呼、零配额；不写回历史版本。

## 4. Removed in 11-05（不要恢复）

`integrations/{pexels,pixabay,unsplash,wikimedia}`、`stockPhotoSupport`、`photoCollection`、
`photoReview{IO,Policy,Queue}`、`reviewedPhotos`、`selectedPhotos`、`boundPhotoLookup`、
`curatedPhotos`、`photoStore`、`photoEnrichment`、`services/independentPhoto*`，以及对应测试与脚本
（`verify-stock-photos.mts`、`review-place-photos.mts`、`govern-independent-photos.mts`、`collect-photo-pilot.mts`）。
`PHOTO_REVIEW_*`、`PEXELS_API_KEY`、`UNSPLASH_ACCESS_KEY`、`PIXABAY_API_KEY` 已从 `env.ts` 删除。

历史行程里已有的 `coverUrl` / `photos` / `coverAttribution` 继续按 schema 展示（前端 `PhotoCredit` 保留），
只是不再产生新数据；不要为「统一」批量清洗历史数据。

## 5. Tests

`amapPoiPhotos.test.ts`、`placeLookup.test.ts`、`tripPhotos.test.ts`、`storedPlaceLookups.test.ts`。
其中 `placeLookup.test.ts` 断言旁路多图直接入池且不再触发任何外部图源，`tripPhotos.test.ts` 断言只补空景点且不改原快照。

## 6. Wrong / Correct

```ts
// Wrong: 恢复多源降级或人工图库兜底。
const cover = await pexels(name) ?? await reviewed(name);

// Correct: 只用高德，失败留空由前端占位。
const cover = await resolveCover(name, city, { amapPhotos, storedAmapPhoto, saveAmapPhoto, searchPhotos });
if (cover) Object.assign(poi, cover);
```
