# 生图模型支持多中转站降级重试

## Goal

AI 分享图目前只认一个第三方中转站（`IMAGE_API_BASE_URL` + `IMAGE_API_KEY` + `IMAGE_MODEL`），该站限流或故障时整条链路直接报错。改为可配置多个中转站，按优先级顺序尝试，某站出现可重试故障时自动降级到下一站，全部站点失败才对外报错。

## What I already know

- 唯一配置注入点：`apps/server/src/env.ts:125` 的 `imageGeneration: { baseUrl, apiKey, model }`（默认 `https://xjbh.lol/v1` + `gpt-image2.5`）。
- 唯一调用点：`apps/server/src/integrations/imageGeneration.ts` 的 `generateShareImage(config, prompt)` —— POST `{baseUrl}/images/generations`，`AbortSignal.timeout(180_000)`，SSRF 守卫 `assertSafeBaseUrl`，图片 10MiB / JSON 15MiB 上限，不向返回的 CDN 地址回传 Authorization。
- 上层：`apps/server/src/services/tripShareImageService.ts`（30 分钟 TTL 缓存 + 同用户/全局并发闸门 2）→ 路由 `POST /api/trips/:id/share-image`。这是 `env.imageGeneration` 的唯一消费方。
- 其他读同名 env 但走 `process.env` 的脚本：`scripts/verify-trip-share-image.mts`、`scripts/ui-mockup.mts`、`eval/live.ts`、`eval/flow.ts`，不受本次改动影响。
- 文档：`.env.example:116`、`README.md:71`、`docs/AI_SHARE_IMAGES.md`、`.trellis/spec/server/backend/integration-guidelines.md:51`。
- 项目既有多源降级先例：图库 Pexels→Pixabay→Unsplash→Wikimedia 顺序降级；高德→天地图按能力降级；`createRouteBreaker` 任务级熔断（阈值 5、任务内记忆、不持久化）。

## Decision (ADR-lite)

**Context**：中转站是第三方（`xjbh.lol`）转发，限流/宕机属常态，但当前实现把单站失败直接暴露给用户；同时配置必须保持 .env 手写可维护。

**Decision**：

1. **索引式扁平变量**，第 1 站沿用现有三个变量，第 2/3 站加 `_2` / `_3` 后缀：
   - `IMAGE_API_BASE_URL` / `IMAGE_API_KEY` / `IMAGE_MODEL`（现有，语义不变）
   - `IMAGE_API_BASE_URL_2|3` / `IMAGE_API_KEY_2|3` / `IMAGE_MODEL_2|3`
   - 扫描上限 3 站；只解析到最后一个「有 baseUrl 的站」，序号不连续即停止。
   - 某站缺 `IMAGE_MODEL_n` 时沿用 `IMAGE_MODEL`（或默认 `gpt-image2.5`）；缺 `IMAGE_API_KEY_n` 的站直接跳过（不发起必死的请求）。
2. **可重试故障降级**。可降级：网络错误、超时、HTTP 5xx、429、401/403、响应体无图/格式异常、图片过大、返回不安全的图片地址。不可降级：HTTP 4xx（400/404/422 等）与本站 baseUrl 配置不合法（未过 SSRF allowlist / 含凭据或 query）—— 请求本身错了，换站也一样。
3. **无熔断 + 整链总预算 180s**。每次请求从第 1 站按序试；`deadline = now + 180s`，每站用剩余时间作超时。不记忆坏站（生图频率低：30 分钟缓存 + 并发闸门 2），只约束用户等待上限。

**Consequences**：单站配置时行为与现状一致（含错误文案与状态码），既有测试不需要改断言；多站时用户最长等待仍为 180s，代价是前几站故障时后几站可用时间被压缩（极端情况最后一站可能只剩几秒）。不引入持久化状态，多实例部署行为一致。

## Requirements

- 支持配置最多 3 个中转站，书写顺序即优先级。
- 可重试故障自动尝试下一站，首个成功即返回，缓存与并发闸门逻辑不变。
- 全部站点失败时抛最后一个真实失败（保留现状文案质量：鉴权失败 / 繁忙 / 暂不可用 / 超时 / 无法连接），不外泄 Key 与上游响应体。
- 所有站点都无 Key（或未配置 baseUrl）时保持 503「尚未配置，请管理员设置 IMAGE_API_KEY」。
- 单站配置（仅旧三个变量）行为与现状完全一致。

## Acceptance Criteria

- [ ] 单站配置时行为不变，`tripShareImage.test.ts` 既有断言全绿
- [ ] 首站 5xx / 超时 / 429 / 401 时自动切到次站并成功返回图片
- [ ] 首站返回 400 时不降级，直接报错且只发生一次请求
- [ ] 跳过缺 Key 的站，不为它发起请求
- [ ] 所有站点均失败时报最后一个真实错误，且不泄露 Key 或上游响应体
- [ ] 全部站点未配置时返回 503（不再提到「IMAGE_API_KEY 未设置」以外的实现细节）
- [ ] 站数超过 3 个时忽略多余配置并输出一次告警

## Definition of Done

- 单元测试覆盖：降级成功 / 不可重试失败 / 跳过缺 Key 站 / 全站失败 / 未配置，共 5 类路径
- `npm run typecheck`、lint、`apps/server` 全量测试绿
- `.env.example`、`README.md`、`docs/AI_SHARE_IMAGES.md`、spec `integration-guidelines.md` 同步更新
- 不新增依赖

## Out of Scope

- 不做管理界面配置，仍走环境变量
- 不做熔断 / 站点健康记忆 / 持久化统计
- 不做每站独立提示词或模型能力探测
- 不改缓存 key（仍为 `userId:tripId:promptHash`，不区分出图站点）
- 不改前端与 API 契约

## Technical Approach

- `env.ts`：把 `imageGeneration: { baseUrl, apiKey, model }` 改为 `imageProviders: ImageGenerationConfig[]`，解析 `_2` / `_3` 后缀。
- `imageGeneration.ts`：新增 `attemptImageGeneration(config, prompt, signal)`（现有单站逻辑），`generateShareImage(providers, prompt)` 负责遍历 + 错误分类 + 总预算；`imageError` 增加第三个参数标记可重试性。
- `tripShareImageService.ts`：注入点从 `env.imageGeneration` 改为 `env.imageProviders`。
- 逐个沿用现有安全约束：SSRF allowlist、`redirect: 'error'`、不向 CDN 回传 Authorization、体积上限、错误文案不外泄上游 body。

## Technical Notes

- 单站超时 180s 是已有的整链预算；多站后用同一数值作整链 deadline，避免最坏 N×180s。
- 上游无服务商文档，按 OpenAI 兼容 `POST /images/generations` 集成；模型标识不做归一化，每站可不同。
- 既有测试 `apps/server/src/__tests__/tripShareImage.test.ts` 直接传单站 config 调 `generateShareImage`，改为传 `[config]` 即可，断言不变。
