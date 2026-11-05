# 活动卡片不再展示预约说明正文

## Goal

活动卡片上的预约说明正文（`activity-rsv-note`，即 `ResearchPoi.reservationNote` 原文）信息密度低、常出现「提前7天；提前1天00:00预约」这类拼接文案。按要求去掉这行展示，预约信息只保留「需预约」徽章与总览「注意事项」条目。

## Requirements

1. `ActivityCard` 删除预约说明正文段落，卡片上只留标签行里的 `ReservationBadge`。
2. `ReservationBadge` 的 `title` 仍带 `reservationNote`（悬停可见，不占版面）。
3. `ResearchPoi.reservationNote` 字段与总览「注意事项」的预约条目保持不变。
4. 规范同步：在 `component-guidelines.md` 记录「卡片不展示预约说明正文」。

## Acceptance Criteria

- [x] 详情卡片上不再出现 `.activity-rsv-note`（页面里 count 为 0，类名无残留）。
- [x] 「需预约」徽章仍在类别标签同行（trip-weather 回归断言通过）。
- [x] 总览「注意事项」仍列「提前预约」条目（`buildTripAdvice` 未改动）。
- [x] `npm run typecheck`、`editor-browser.mjs`、`photo-layout-browser.mjs`、`trip-weather-browser.mjs` 通过。

## Definition of Done

- 改动只涉及 `apps/web/src/components/editor/ActivityCard.tsx` 与一份 spec。
- 不删除数据字段、不改生成链路。

## Technical Approach

删除 `ActivityCard.tsx` 中 `{matchedPoi?.reservation === 'required' && matchedPoi.reservationNote && <p className={"activity-rsv-note ..."}>…</p>}` 一行；`ReservationBadge` 自带 `title={reservationNote}` 已覆盖悬停查看。

## Out of Scope

- 不动 `reservationNote` 的生成与冲突判定（上一个任务已改）。
- 不动总览、导出、打印视图。

## Technical Notes

- `apps/web/src/components/editor/ActivityCard.tsx:48` — 目标行。
- `apps/web/src/components/PoiCard.tsx` — `ReservationBadge`（`title` 传 note）。
- 相关回归：`apps/web/tests/trip-weather-browser.mjs` 断言 `.activity-tags .rsv-badge` 存在，不受影响。
