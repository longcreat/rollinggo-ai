# 总览建议灯泡图标与卡片对齐微调

## Goal

行程编辑器的总览页（TripOverview）与单日面板（DaySection）有三处视觉细节需要修正：旅行建议区块的图标语义不贴切、行程卡片里路线前的定位图标与路线文本未垂直居中、单日面板标题栏重复显示「第 N 天」。均为纯前端展示调整，不改变数据结构与交互行为。

## Requirements

1. 总览页「旅行建议」标题前的图标由 `pin`（定位钉）换成灯泡图标 `bulb`。
2. 总览页行程卡片中，路线行前方的定位图标相对该行路线文本垂直居中（多行折行时居中于整块文本）。
3. 单日面板标题栏里删除重复的「第 N 天」文本，保留「N月N日」与天气/温度。
4. 「注意事项」标题继续沿用 `alert` 图标；天数页签（`第N天` 按钮）不受影响。

## Acceptance Criteria

- [x] 总览「旅行建议」标题前缀为灯泡线稿图标，视觉尺寸与其它 `EditorIcon` 一致（22px）。
- [x] 行程卡片路线行折行时，定位图标垂直居中于路线文本块（不再固定顶对齐 `mt-1.5`）。
- [x] 单日面板标题栏不再出现「第 N 天」，日期与天气仍在。
- [x] 天数页签中的「第N天」按钮文本保持不变。
- [x] typecheck 与 `npm run build -w apps/web` 通过（仓库无 lint 脚本）。

## Definition of Done

- 改动只涉及 `apps/web/src`，无后端 / shared 包变更。
- lint + typecheck 绿。
- 不新增依赖。

## Technical Approach

- `EditorIcon` 的 `name` 联合类型新增 `'bulb'`，`paths` 补一条灯泡 path（与既有图标同为 24 视图、`stroke` 细线风格）。
- `TripOverview.tsx` 的 `AdviceList` 把非 caution 分支的图标名由 `pin` 改为 `bulb`。
- 同一文件行程卡片的路线 `<p>`：`flex items-start gap-1.5` → `flex items-center gap-1.5`，图标 span 去掉 `mt-1.5` 改为 `shrink-0`。
- `DaySection.tsx` 标题栏 `<p>` 中移除 `<span>第{day.dayIndex}天</span>`（`aria-label` 与删除对话框里的天数说明保留）。

## Out of Scope

- 不改 `buildTripAdvice` 的建议生成逻辑与文案。
- 不改总览信息栏（共 N 站 / 点击查看当天）。
- 不动导出、通知、地图等其它模块。

## Technical Notes

- `apps/web/src/components/editor/EditorIcon.tsx` — 现有图标集：pin / calendar / back / send / walk / cycle / drive / route / place / reset / export / history / food / clock / sparkle / forward / alert。
- `apps/web/src/components/editor/TripOverview.tsx` — `AdviceList`（第 7–21 行）、行程卡片路线行（约第 50–53 行）。
- `apps/web/src/components/editor/DaySection.tsx` — 标题栏第 33 行。
- 天数页签在 `apps/web/src/pages/TripEditorPage.tsx` 第 228 行，本次不改。
