# 接入 Pexels 图片源作为景点封面主路径

## Goal

景点封面目前只有两个来源：上游本地图库（`payload.coverImage`，仅北京/广州/杭州有，杭州只覆盖 34 个景点）和中文维基（`upload.wikimedia.org` 在国内被封锁，基本不出图）。结果就是绝大多数城市的候选卡片回落成类目图标。Pexels 免费图库有可用的中国地标素材（实测中文搜索「故宫」返回「北京故宫」「故宫博物院」「紫禁城」等真图），把它接成第一优先来源，用严格命中闸门挡掉张冠李戴。

## What I already know

* Pexels API：`GET https://api.pexels.com/v1/search`，参数 `query`（必填）/`orientation`/`size`/`color`/`locale`/`page`/`per_page`（默认 15，上限 80）；`locale` 支持 `zh-CN`。
* 响应 `Photo`：`id`、`width`、`height`、`url`（照片页）、`photographer`、`photographer_url`、`avg_color`、`src`（多尺寸对象：`original`/`large2x`/`large`/`medium`/`small`/`portrait`/`landscape`/`tiny`）。
* 条款（官网 API Guidelines）：**每次 API 请求都必须展示指向 Pexels 的显眼链接**（文本链接 `Photos provided by Pexels` 或官方 logo）；**尽可能**标注摄影师（`Photo by John Doe on Pexels` + 照片页链接）；默认限流 200 次/小时、20000 次/月；禁止绕过限流。
* 实测覆盖：中文搜「故宫」→「北京故宫 / 故宫博物院 / 天安门 / 紫禁城」；中文搜「西湖」→ 4000+ 结果。搜索质量远好于上一轮的预估。
* 现有封面链路（09-27 提交 `0a29278`）：`storedCover`（`payload.coverImage` → `MEDIA_BASE_URL`，默认 `/media` 同源）→ 中文维基 → 空。校验用 `isUsableCoverUrl`（`http(s)` 或 `/` 开头）。
* 封面消费方：`PoiCard` 封面为 72×72（紧凑卡 44×44、活动内嵌 56×56），`object-fit: cover`；生成中页拍立得容器撑满。都是方形裁切，横竖图都能用 → `orientation` 不需要收紧。
* 可复用件：`lib/ttlCache.ts`、`lib/serialQueue.ts`、`services/quotaService.ts`（日预算记账，照 `amapBudgetRemaining` 模式）、`lib/proxy`（fetch 走代理接管）、`integrations/nullPoiSource.ts`（缺失 key 的 Null 模式）。
* 参考实现风格：`integrations/wikimedia/cover.ts`（超时 + 串行队列 + 24h 正负缓存 + 单次生成上限 + 失败只 warn）。

## Decision (ADR-lite)

**Context**：需要一个覆盖面广、合规、国内可访问的景点图片来源；Pexels 没有坐标检索，只能按关键词搜，因此必须解决「关键词搜索把通用图当成本地景点」的准确性问题。

**Decision**：

1. **链路顺序**：Pexels（严格命中）→ 库内封面 → 中文维基 → 空。
2. **搜索词只用地点名**，`locale=zh-CN`，不加城市：实测「故宫」已能精确命中，拼上城市反而稀释关键词。
3. **严格命中闸门**：搜索结果里必须有 `alt` / 照片页 slug 与地点名**归一键**（去机构后缀、trim）匹配的项才采用；全部不匹配 → 判未命中并继续降级。宁可没图，也不要把「某公园的通用湖景」贴到具体景点上。
4. **热链，不转存**：`src.medium` 直接交给前端；Pexels 的计数与条款都基于 API 返回的链接。
5. **不回写 `canonical_places`**：`payload.coverImage` 保持「人工/上游精选」语义。用进程内 24h TTL（含负缓存）摊平重复请求。
6. **署名按条款最小实现**：展示 Pexels 图片的页面固定显示 `Photos provided by Pexels` 链接；不做逐图摄影师署名（条款原文为 "when possible"）。

**Consequences**：Pexels 命中会盖过库内真实实拍图（用户已选「Pexels 优先」，换取图片版权来源统一）；不含坐标导致准确率依赖关键词与闸门，需要实测调闸门阈值。未配 key 时行为与今天完全一致。

## Requirements

* 新增 `apps/server/src/integrations/pexels/cover.ts`：
  * `createPexelsCoverLookup(requestsLeft = 8, minIntervalMs = 1000): PexelsCoverLookup`，接口 `coverFor(query: { name: string; city: string }): Promise<string | null>`。
  * 请求 `https://api.pexels.com/v1/search?query={name}&locale=zh-CN&per_page=5`，头 `Authorization: <PEXELS_API_KEY>`；超时 8s；串行队列间隔 ≥1s。
  * 24h `TtlCache`，**命中与确认未命中（null）都缓存**；传输失败（超时/非 2xx）不缓存，下次重试。
  * 单次生成最多 8 次真实请求（与维基各自计数）；超出直接返回 null，不发请求。
  * 任何失败返回 null 并打一条 `[pexels-cover]` warn，绝不抛进生成流程。
  * 导出纯函数 `pickCover(photos, name): string | null` 便于单测：按归一键匹配 `alt` 与照片页 slug，返回第一条命中的 `src.medium`（字段缺失时依次回落 `src.large` / `src.original`）；只接受 `https://` 链接。
* `apps/server/src/env.ts` 新增 `pexelsApiKey`（`PEXELS_API_KEY`）。
* **小时级窗口限流**（不落库）：进程内滑动计数，超过 180 次/小时（Pexels 上限 200/h，留余量）直接返回 null、不发请求。重启即重置 —— 与 Pexels 自己的口径一致，且不需要新增 `generations` 用量列。
* 未配置 `PEXELS_API_KEY` → Null 实现（不发请求、不阻断、不影响既有链路）。
* `researchTools.ts`：`resolveCover` 顺序改为 Pexels → stored → 维基；新增依赖 `pexelsCover?: PexelsCoverLookup`，未注入时用空实现（测试与离线回放不发请求）。
* `orchestrator.ts` 注入 `pexelsCover`，与 `storedCover` / `coverLookup` 并列。
* 前端：在展示候选封面的页面（生成中页 / 概览）显示指向 `https://www.pexels.com` 的 `Photos provided by Pexels` 链接。
* `.env.example` 补 `PEXELS_API_KEY` 段（含条款与限流说明）。

## Acceptance Criteria

* [ ] 未配置 `PEXELS_API_KEY`：封面链路与现状逐字一致（库内 → 维基），不发任何 Pexels 请求。
* [ ] 配置 key 后，生成北京行程时「故宫」的 `coverUrl` 命中 `images.pexels.com`。
* [ ] 地点名无匹配 `alt` 时返回 null 并继续降级（如「虎跑公园」→ 杭州库内图）。
* [ ] 同一地点第二次调用命中缓存，不再发请求。
* [ ] 超时 / 非 2xx / 429 → null + 一条 warn，不抛异常。
* [ ] 单次生成第 9 次起不再发请求。
* [ ] 进程内小时窗口达到 180 次后不再发请求（直接 null）。
* [ ] 展示 Pexels 图片的页面有 `Photos provided by Pexels` 链接（指向 `https://www.pexels.com`）。
* [ ] `npm run typecheck`、`node --import tsx --test ...`、`npm run build` 全绿。

## Definition of Done

* 单测覆盖：`pickCover` 的命中/未命中/非 https/字段回落；适配器缓存、负缓存、失败不缓存、请求上限、无 key 时 Null。
* `resolveCover` 顺序单测：Pexels 命中即短路，不查库内、不查维基。
* Spec 更新：`.trellis/spec/server/backend/integration-guidelines.md`（新增 Pexels 封面来源契约）+ `rag-guidelines.md` 的封面场景段落同步顺序。
* 真实 key 到手后跑一次实测，结论写进 `research/pexels-api.md`（alt 质量、命中率、实际返回尺寸）。

## Out of Scope

* **全站日预算表列**（`generations.pexels_calls` + `quotaService` 计量）：先靠单次上限 + 24h 缓存 + 小时窗口限流；真实用量上来再加。
* BYOK（设置页个人 Pexels key）—— 只做站点级 `PEXELS_API_KEY`。
* 把 Pexels 图片下载/转存到 `data/media`（热链；转存还会失去 API 的计数语义）。
* 回写 `canonical_places.payload.coverImage`。
* 逐图摄影师署名（只做页面级 provider 链接）。
* 按卡片尺寸请求不同规格（统一 `medium`；`avg_color` 占位也先用不上）。
* Pexels 视频、collections、curated 端点。
* food / hotel 封面（封面仍只服务 `attraction`）。
* 修改 Pexels 搜索结果排序逻辑（只用相关性首条命中）。

## Technical Notes

TripWeaver 侧：

* `apps/server/src/generation/tools/researchTools.ts:80` `resolveCover`（顺序与校验的落点）
* `apps/server/src/generation/orchestrator.ts:249` 注入点（`coverLookup` / `storedCover` / `storedPoint` 并列）
* `apps/server/src/generation/storedCover.ts` —— 上一轮落的库内封面实现
* `apps/server/src/integrations/wikimedia/cover.ts` —— 适配器结构模板（队列、缓存、上限、降级）
* `apps/web/src/components/PoiCard.tsx` + `apps/web/src/styles/global.css:369` —— 封面渲染与尺寸
* `packages/shared/src/schemas.ts:84` —— `coverUrl` 上限 300 字符（Pexels 链接长度需确认）

外部：

* API 文档：`https://www.pexels.com/api/documentation/`
* 条款（署名 / 限流）：同页 Guidelines 段

## Research References

* 待写 `research/pexels-api.md` —— 真实响应样例（`src` 字段实测值、`alt` 中文质量）、不同关键词命中率、闸门阈值调参记录。需要用户提供 `PEXELS_API_KEY` 后补。
