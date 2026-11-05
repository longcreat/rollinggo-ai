# Wikimedia Commons 补景点图片

## Goal

天地图成为 POI 搜索主路径后，`photoUrls` 恒为空，概览卡片的 `coverUrl` 随之消失。用 Wikimedia Commons 按坐标给景点补一张封面图，失败就留空，不阻断生成。

## What I already know

* 用户拍板：用 Wikimedia Commons，不要 Pexels / Unsplash / Pixabay。
* 高德 `v5/place/text` 的 `photos` 链已随 POI 搜索切到天地图而消失（09-25 PRD：封面图暂不做，`coverUrl` 字段保留）。
* `SourcedPoi.photoUrls` 在天地图适配器里写死 `[]`（`apps/server/src/integrations/tianditu/poiSource.ts`）。
* 模型通过 `search_pois` 看到 `图片=<url>`，再在 `add_candidate` 的可选参数 `coverUrl` 里原样回填。前端 `PoiCard` 热链展示，`onerror` 回落类目图标。
* 坐标已在手：天地图 POI 入站已转 GCJ-02。Commons geosearch 要 WGS-84，仓库已有 `gcj02ToWgs84`。
* 集成约定：外部源有超时、串行队列、24h `TtlCache`、失败降级为空、不阻断生成。

## Decision

用户拍板（2026-09-26）：维基实时检索是**降级**，不是主路径。景点库里已有图就用库里的；没有才当场查。查到的只写进本次候选的 `coverUrl`，**不回写** `canonical_places`。库内补图是后续任务。

现状：`canonical_places` 没有图片列（`schema.ts` 只有 name/category/lng/lat/payload），所以这次生成里每个景点都会走降级。以后库里有图，同一个函数先读库再决定要不要查。

## Requirements (evolving)

* 解析顺序：库内封面（现在恒缺）→ 中文维基实时检索 → 空（前端类目图标）。
* 只对本次生成新加入的 `attraction` 候选做实时检索。旧行程不回填。
* 天地图 POI 仍不返回图片；图片来自独立适配器，不塞进 `PoiSource`。
* 仅当候选是 `attraction`、有坐标、且库内没有封面时才查。模型传来的 `coverUrl` 不作为来源。
* 命中条件：geosearch 半径 ≤500m，且条目标题与地点名有实质重合（去「博物馆」「景区」等后缀后仍相交）。
* 取该条目的 `pageimage` 缩略图（约 400px），URL 必须是 `https://upload.wikimedia.org/`。
* 结果按「规范化地点名 + 约 100m 网格」缓存 24h。负缓存同样 24h（没图的地点不再打）。
* 单次生成最多 8 次真实请求。队列间隔 ≥1s（Commons 礼貌使用，匿名约 200 req/s 上限，我们远低于此）。
* 超时 8s。任何失败返回空，打一条 warn，不抛到生成流程。

## Acceptance Criteria (evolving)

* [ ] 坐标落在已知景点（如故宫）附近且标题重合时，`coverUrl` 被写成 `upload.wikimedia.org` 的 https URL。
* [ ] 500m 内没有标题重合的条目时，`coverUrl` 保持空。
* [ ] 超时 / 非 2xx / 畸形 JSON → 空结果，不抛异常。
* [ ] 同一地点第二次查询命中缓存，不再发请求。
* [ ] 非 attraction、无坐标、或模型已给合法 http(s) `coverUrl` 时，不调用 Commons。
* [ ] 单次生成第 9 次起不再发请求。

## Definition of Done (team quality bar)

* Tests added/updated (unit/integration where appropriate)
* Lint / typecheck / CI green
* Docs/notes updated if behavior changes
* Rollout/rollback considered if risky

## Out of Scope (explicit)

* 不给 `canonical_places` 加图片列，不把实时命中回写进库。库内补图是后续任务。
* 不接 Pexels / Unsplash / Pixabay / Flickr。
* 不下载、不转存图片。
* 不补 food / hotel。
* 不回填旧行程，不在读取行程时发请求。
* 不回填 `SourcedPoi.photoUrls`，不改天地图适配器的空数组契约。
* 不改前端 `PoiCard`（已有缺图兜底）。
* 不做多图、不做图库挑选 UI。

## Technical Notes

* Commons API：`https://commons.wikimedia.org/w/api.php`
  * `action=query&list=geosearch&gscoord={lat}|{lng}&gsradius=500&gslimit=5&format=json`
  * 再 `action=query&prop=pageimages&pithumbsize=400&pageids=...&format=json`
  * 坐标必须是 WGS-84。请求头带描述性 `User-Agent`（Commons 要求）。
* 相关文件：
  * `apps/server/src/generation/tools/researchTools.ts` — `add_candidate` 写 `coverUrl` 的位置
  * `apps/server/src/integrations/tianditu/poiSource.ts` — 坐标来源
  * `apps/server/src/lib/serialQueue.ts`、`ttlCache.ts` — 复用
  * `packages/shared` 的 `gcj02ToWgs84`
* 前端协议注释仍写「高德协议 3.5 热链」，本任务不改协议，只换 URL 来源。

## Research References

* （待写）`research/commons-geosearch.md`
