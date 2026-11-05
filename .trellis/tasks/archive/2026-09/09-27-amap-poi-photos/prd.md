# 接入高德 POI 图片并调整封面优先级

## Goal

封面链路的优先级按用户决策调整为：**上游图库 → Pexels → 高德 POI 图片 → 中文维基**。同时补上目前缺失的第三级 —— 上游图库只覆盖 3 个城市，Pexels 的文本闸门实测只有 45%~50% 命中，剩下的一半需要国内可访问、能精确对应景点的来源，高德 POI 自带的 `photos` 就是这个洞。

## What I already know

* 高德 `v5/place/text` + `show_fields=photos` **实测可用**：`keywords=西湖&region=杭州` 返回「杭州西湖风景名胜区」+ 3 张图 URL（`store.is.autonavi.com/showpic/...`）。
* 图片 URL **无 Referer 校验**：https 形式、带高德 Referer、不带 Referer 三种请求都返回 `200 image/png`（309 KB）。可直接热链。
* URL 是 http/https 混合（实测第二条是 `http://`）→ 必须归一为 https，否则在 https 页面被浏览器当 mixed content 拦掉。
* 配额约束（`geoProvider.ts` 已记录）：高德 `v5/place/text` 与地理编码主路径**共用同一份个人配额**，09-25 就是因为被打满（`USER_DAILY_QUERY_OVER_LIMIT`）才把 POI 搜索切到天地图。本适配器排在上游图库与 Pexels 之后，只在两者都未命中时调用，请求量因此很小。
* 凭据解析：`resolveAmapCredential(userId)` 返回个人 key 优先、站点 key 兜底（`services/settingsService.ts`）。
* 配额记账：`orchestrator.ts:127` 的 `providerCallCounts()` 现算 `amapCalls` / `tiandituCalls`；高德图片调用必须计入 `amapCalls` 才会被 `AMAP_DAILY_BUDGET` 约束。
* 当前顺序（09-27 `88f1798`）：Pexels → 库内封面 → 中文维基 → 空。

## Decision (ADR-lite)

**Context**：三个来源各有硬伤 —— 上游图库只覆盖 3 个城市，Pexels 无坐标且闸门实测半数命中，维基在国内被封锁。需要一个「国内 + 能精确对应景点」的第三级。

**Decision**（用户 2026-09-27 拍板）：

1. **顺序**：上游图库（`payload.coverImage`）→ Pexels → 高德 POI 图片 → 中文维基 → 空。
2. **高德排最后一级有图来源**：它的请求会与地理编码抢个人配额，所以只在前面都没图时才打。
3. **热链不转存**：`store.is.autonavi.com` 直接给前端，强制 https。
4. **命中闸门（两段，都要过）**：名字（归一后相同 / 以其结尾 / 其分段按序出现 —— 「西溪国家湿地公园」对得上「西溪湿地」）+ 类型（POI `type` 首段在白名单 `风景名胜 / 体育休闲服务 / 科教文化服务 / 购物服务`，缺失即拒）。名字闸门比 Pexels 的 alt 匹配可靠得多，因为 name 是权威地名而非摄影师描述；类型闸门是必需的 —— 搜「龙井村」高德会返回「龙井村(公交站)」，搜「宋城」会返回路名，那些 POI 同样带 photos。
5. **维基保留在最后**：国内无效但零成本，且是唯一带坐标核对的外部源。

**Consequences**：接受高德 POI 图片的协议风险（见 Risks）；新增的配额消耗受 `AMAP_DAILY_BUDGET` 约束，且只在前两级失败时才发生。

## Requirements

* 调整 `generation/tools/researchTools.ts` 的 `resolveCover` 顺序：stored → Pexels → 高德 → 维基。
* 新增 `apps/server/src/integrations/amap/poiPhotos.ts`：
  * `createAmapPoiPhotoLookup(apiKey: string, requestsLeft = 3)`，接口 `coverFor({ name, city }): Promise<string | null>`，并暴露 `calls: number`（已发生的真实请求数，供 `providerCallCounts()` 计入 `amapCalls`）。
  * 请求 `v5/place/text?keywords={name}&region={city}&show_fields=photos&page_size=3`，超时 8s，**复用 `amapQueue`**（与 geocode/route 同一串行队列，350ms 间隔，避免把个人约 3 QPS 打满）。
  * 命中闸门写在纯函数 `pickPhoto(pois, name)` 里：归一键相同的 POI 取 `photos[0].url`；无命中 / 无 photos → `null`。
  * URL 归一：`http://store.is.autonavi.com/...` → `https://...`；只接受 https 结果。
  * 24h `TtlCache`（命中与确认未命中都缓存）；传输失败不缓存；**单次生成最多 3 次真实调用**（配额稀缺，只给最难的那几个候选补图）。
  * **进程内 24h 滚动窗口 ≤40 次**：`v5/place/text` 属「基础搜索服务」个人认证 5,000/月（≈166/天），与地理编码那 150,000/月 不是同一份配额，必须自己兜底。
* **命中回写**（
  `saveAmapPhoto(city, name, url)` in `generation/scheduling/placeFacts.ts`）：高德实时命中后把完整 URL 写进 `canonical_places.payload.amapPhoto`（jsonb 新键，无需迁移），按归一键匹配库内行、已有值不覆盖、失败只 warn。下次同一地点零成本复用 —— 这是把「每地点重复消耗配额」变成「终身一次」的关键。
* 读取：`PlaceFacts.amapPhoto` 透传，`createStoredAmapPhotoLookup(city)` 在**高德那一级内部先读库**（与 Pexels 同级位置，不改变上游 → Pexels → 高德 的对外顺序）。
  * 未配置 key → 直接 `null`，不发请求。
* `generation/orchestrator.ts`：
  * `resolveAmapCredential(job.userId)` 取 key，注入 `amapPoiPhotos`；
  * `providerCallCounts()` 的 `amapCalls` 加上 `amapPoiPhotos.calls`。
* `.env.example` 无需新增（复用 `AMAP_KEY`）。
* 前端不动（`coverUrl` 契约不变；高德 URL 是 http(s)，已在允许范围）。

## Acceptance Criteria

* [ ] 顺序单测：上游有图时不调 Pexels / 高德；Pexels 命中时不调高德；前两级都空时才调高德。
* [ ] `pickPhoto`：POI name 归一后匹配（含「风景名胜区」等后缀、中间插词）→ 取图；类型不在白名单或缺失 → null；`photos` 缺失或为空 → null。
* [ ] http 图片 URL 被改写成 https。
* [ ] 未配置 key：不发请求，链路其余部分不受影响。
* [ ] 缓存命中第二次不发请求；传输失败不缓存、下次重试；第 4 次起不发请求。
* [ ] 库内已有 `payload.amapPhoto` 时直接复用，不发请求也不重写。
* [ ] 高德实时命中后调用一次回写，参数为（地点名, 图片 URL）。
* [ ] `amapPoiPhotos.calls` 反映真实请求数，且 `amapCalls` 统计包含它。
* [ ] `npm run typecheck` / `node --import tsx --test --test-concurrency=1 apps/server/src/__tests__/*.test.ts` / `npm run build` 全绿。

## Definition of Done

* 新增单测 `apps/server/src/__tests__/amapPoiPhotos.test.ts`（纯函数 + mock fetch，不连库）。
* 更新 `apps/server/src/__tests__/placeLookup.test.ts` 的顺序断言。
* Spec 更新：`.trellis/spec/server/backend/integration-guidelines.md` 的封面来源章节补第三级契约与配额说明。
* 真实 key 跑一次端到端验证，结论写进 `research/amap-poi-photos.md`。

## Out of Scope

* 高德图片的转存 / 缓存到本地。
* POI 搜索主路径切回高德（配额分工不变，仍固定天地图）。
* 多图选择（只取 `photos[0]`）。
* 按高德 POI 图片做相似度/质量筛选。
* Pexels 闸门优化（放宽片段匹配、别名表）—— 本轮不动，保持现状。
* food / hotel 封面。

## Risks

* **协议待核实**：高德开放平台服务协议对 POI 数据（含图片）是否要求「必须配合高德地图展示」，尚未找到权威原文。当前按热链实现，若协议要求配图，需要在前端补高德地图或改用其他来源。
* **配额互相挤占**：`v5/place/text` 属「基础搜索服务」个人认证 **5,000/月**（地理编码走的 `v3/geocode/geo` 是另一档 150,000/月，两者分组不同）。排最后一级 + 24h 缓存 + 100/天窗口把影响压到最小，但仍需在实测里统计单次生成的实际调用数。
* **图片质量与时效**：POI 图片由高德维护，可能过期或与景点不符（无质量信号可用）。

## Technical Notes

* `apps/server/src/integrations/amap/geocoder.ts` —— 同目录的既有适配器（超时、错误处理风格参照）
* `apps/server/src/integrations/wikimedia/cover.ts`、`pexels/cover.ts` —— 封面适配器结构模板
* `apps/server/src/lib/ttlCache.ts`、`serialQueue.ts`、`placeKey.ts`
* `apps/server/src/services/settingsService.ts` 的 `resolveAmapCredential`
* `apps/server/src/generation/orchestrator.ts:127` 统计函数、`:249` 注入点
* 实测命令：`curl -G "https://restapi.amap.com/v5/place/text" --data-urlencode "keywords=西湖" --data-urlencode "region=杭州" --data "show_fields=photos" --data "key=$key"`

## Research References

* 待写 `research/amap-poi-photos.md` —— 单次生成的实际调用数、命中率、图片可用性（是否 403/失效）、与地理编码配额的挤占实测。
