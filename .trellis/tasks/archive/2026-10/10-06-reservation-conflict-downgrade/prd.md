# 预约资料冲突降级与无源语料降权

## Goal

2026-10-06 排查「天坛公园提前7天；天坛公园提前1天00:00预约」时发现两类缺陷：预约说明里可以同时存在两个互相矛盾的「提前 N 天」而系统照抄为 `required`；社区语料中 `xhs_reservation` / `xhs_price` 这类来自平台文字、`source_url` 为空的记录，靠迁移按 kind 回填拿到了 `direct` 强度，与「direct = 有多条可核查来源」的语义不符。本任务让自相矛盾的预约资料降为「待核实」，并让无来源语料不再顶格。

## Requirements

1. `normalizeReservation` 增加冲突判定：同一段说明里出现**互不重叠**的「提前 N 天」区间时返回 `unknown` + 现有 CONFLICT 文案（「预约资料存在冲突，请通过官方渠道确认后安排。」）。`提前3-7天` 这类区间按单个区间处理，不与自身或包含它的区间冲突。
2. 导入侧显式决定语料强度：`seed-xhs-places.ts` 写 `research_evidence.strength`，优先级为「上游给了就用上游的 > 无 `sourceUrl` 的 `xhs_reservation`/`xhs_price` 降为 `weak` > 按 kind 默认（`xhs_reason`=weak、`xhs_warning`=risk_only、其余 direct）」。
3. 现有库数据不自动改写：给出降级 SQL（131 条 `xhs_reservation` + 268 条 `xhs_price`，全部无 source_url），由用户决定是否执行。

## Acceptance Criteria

- [x] `normalizeReservation('required', '天坛公园提前7天；天坛公园提前1天00:00预约')` → `unknown` + 冲突文案。
- [x] `'故宫博物院提前3-7天20:00放票；故宫/天安门升旗/天安门城楼均需通过官方小cx提前7天预约'` 不再被判冲突（区间重叠）。
- [x] `'人民大会堂提前3天；人民大会堂提前3天'` 不判冲突。
- [x] 其余既有三态判定（negative/positive/uncertain/种子覆盖）行为不变，原有单测全绿。
- [x] 强度函数有单测：上游值优先、无 url 的预约/价格降为 weak、有 url 保持 direct、`xhs_warning` 为 risk_only。
- [x] `npm run typecheck` 通过，两个单测文件共 8 项全绿；另对库内 5324 条带预约说明的地点重算验证影响面。

## Definition of Done

- 只动 `apps/server`（`generation/researchQuality.ts`、新增 `services/evidenceStrength.ts`、`scripts/seed-xhs-places.ts`、两个单测）。
- 不新增依赖。
- 规范同步：`rag-guidelines.md` 记录「自相矛盾的提前天数 → unknown」与「无来源语料不得顶格」两条约定。

## Technical Approach

- `researchQuality.ts`：
  ```ts
  const AHEAD = /提前\s*(\d{1,3})\s*(?:[-~～至到—–]\s*(\d{1,3}))?\s*天/g;
  function hasConflictingLeadDays(note: string): boolean
  ```
  收集区间 `[min,max]`，任意两区间无交集即冲突；`normalizeReservation` 开头短路返回 CONFLICT。
- `services/evidenceStrength.ts`：导出 `evidenceStrength({ kind, sourceUrl, strength? })`，供导入脚本使用并单独单测。
- `seed-xhs-places.ts`：`EvidenceItem` 增加可选 `strength`，`evRows` 增加一列，`INSERT` 列表同步加 `strength`。

## Decision (ADR-lite)

**Context**: 单一 `direct` 证据即可让预约结论生效，而 `direct` 实际由迁移按 kind 批量回填，与「≥2 条可核查来源」的原意脱节；同段说明内的矛盾数字没有任何校验。

**Decision**: 只做两件最小改动 —— 同段说明内的**不同**提前天数视为冲突降为 unknown；导入侧不再给无来源的预约/价格语料顶格强度。不改变预约结论的整体采信链路（是否要求存在 direct 证据）。

**Consequences**: 天坛这类拼接错位的说明会变成「请通过官方渠道确认」，用户可自行核实；无来源语料降权后可能在 evidence 排序里被挤出前三，预约提示可能减少，但不会更错。历史行程的 `overview` 已持久化，需要重新生成或刷新才会带上新结论。

## Out of Scope

- 不修改 `canonical_places.payload`（上游导出产物），不新增预约种子表条目。
- 不批量重算既有行程快照。
- 不改变目录/价格字段的展示逻辑（`xhs_price` 仅参与强度，不参与展示判定）。

## Technical Notes

- `apps/server/src/generation/researchQuality.ts` — `normalizeReservation`、`UNKNOWN`/`CONFLICT` 文案。
- `apps/server/src/generation/tools/researchTools.ts:395-425` — 种子覆盖与 `known`/`xhs` 分支如何写入 `reservationNote`。
- `apps/server/scripts/seed-xhs-places.ts:208-231` — 语料批量插入（当前不含 `strength` 列）。
- 数据现状（2026-10-06 实测）：`xhs_reason` weak 6665 条（有 url）、`xhs_warning` risk_only 627 条、`xhs_price` direct 且无 url 268 条、`xhs_reservation` direct 且无 url 131 条；`payload.reservationNote` 含两处「提前…」的 14 个地点，其中 4 个数字确实不同。
- `apps/server/src/__tests__/researchQuality.test.ts` — 现有单测入口。
