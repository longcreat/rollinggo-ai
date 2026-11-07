# PRD: 取消高德本地日配额拦截（保留计量）

## 背景

`amap_service_usage` 账本按官方月配额 ÷ 31 给每个高德服务设了本地日上限（place = 5000/31 = 161）。2026-11-06 当天 place 用满 161，`search_area_places` 每次都在外呼前被本地闸门拒绝，生成链路连报 5 次「盘点片区里的好去处未完成」，模型降级为只用 `list_areas` 候选 + web 检索，最终生成失败。

用户要求：不要再限制配额。

## 目标

1. 高德调用不再因本地日预算被拒绝：`place`（POI 检索）与 LBS（geocode/route）全部放行。
2. 保留计量：继续写 `amap_service_usage`，日志仍输出 `[amap-call] used/limit`，`/api/usage` 与运维排查口径不变。
3. 新增开关 `AMAP_QUOTA_ENFORCE`，**默认 false**（不拦截）；设为 `true` 时恢复原有硬闸门行为。
4. 关闭拦截时，`budgetRemaining()` / `remainingOf('place')` 返回 `Infinity`，使 orchestrator 的 POI 源预检、geoPipeline 的 provider 预检自然放行（否则仍是「零额度 → Null 源」的隐性限制）。
5. 当计数超过日上限且未开启拦截时，日志给出一次 `over_budget` 提示，保留超额可见性。

## 非目标

- 不动和风 QWeather 的日额度（`qweatherQuotaService` 保持独立 enforcement）。
- 不动用户侧生成配额（`GEN_DAILY_LIMIT` / `CHAT_DAILY_LIMIT`）。
- 不删除预算配置、校验函数与数据表；开启开关即可回到旧行为。
- 不提交主工作区其他 WIP。

## 涉及文件

- `apps/server/src/lib/amapQuotaLedger.ts` — 增加 `enforce` 选项；关闭时只增计数、恒 `allowed: true`；`remaining*` 返回 `Infinity`。
- `apps/server/src/services/amapQuotaService.ts` — 传入 `env.amapQuotaEnforce`。
- `apps/server/src/env.ts` — 新增 `amapQuotaEnforce`。
- `apps/server/src/integrations/amap/request.ts` — 超额时一次性日志（不改变放行逻辑）。
- `.env.example`、`docs/AMAP_QUOTAS.md` — 说明新默认行为与开关。

## 验收标准

1. `npm run typecheck` 四个 tsconfig 全过。
2. 现有 `amapRequest` 相关单测通过（预算解析逻辑不变）。
3. 真实冒烟：今日 place 计数已到 161/161、`AMAP_QUOTA_ENFORCE` 未设置时，`AmapPoiSource` 检索仍返回结果，不再抛「高德 place 今日调用预算已用完」；计数继续增长。
4. 设置 `AMAP_QUOTA_ENFORCE=true` 时行为回到拦截（可用单测覆盖）。