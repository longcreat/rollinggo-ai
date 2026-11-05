# 行程卡片布局与照片标签微调

## Goal

行程编辑器每日卡片还有一批需要收敛的视觉与信息层级问题：底部「＋ 添加活动」按钮与插入式布局冲突、照片版权行占位置、放大弹窗标题冗余、预约状态与类别标签分处两行、右侧照片列宽随内容浮动导致文字列忽宽忽窄。本次统一为「固定图片列 + 居中照片 + 标签同行」的稳定布局，并按要求移除添加活动入口。

## Requirements

1. 删除每日卡片底部的「＋ 添加活动」按钮，且不保留其它新增活动入口。
2. 删除行程详情列表底部的「Photos provided by Pexels」署名行（`PexelsCredit`）；照片放大弹窗内的 `PhotoCredit` 署名保留。
3. 照片放大弹窗标题由「{名称} · 完整照片」改为「{名称}」（触发按钮的无障碍名称保持不变）。
4. 活动卡片的预约徽章（`ReservationBadge`）从独立一行移到与类别标签同一行（`.cat-badge` 所在行）；`reservationNote` 说明文字仍留在原位置，没有 note 时不再渲染空块。
5. 活动卡片右侧照片列固定宽度：桌面 180px、≤600px 时 128px；照片保持现有比例与 `object-contain`（不裁剪），在列内水平 + 垂直居中；无封面的活动保留同宽空白占位，使所有卡片文字列宽度一致。
6. 清理第 1 项产生的死代码：`ActivityEditDialog` 组件、`TripEditorPage` 的 `editing` 状态链路、`editorStore` 的 `addActivity` / `updateActivity`，以及 `DaySection` 的 `onEditActivity` prop。

## Acceptance Criteria

- [x] 编辑器任何状态下都找不到「＋ 添加活动」按钮。
- [x] 行程详情列表底部不再出现「Photos provided by Pexels」；放大弹窗内仍有指向 Pexels 的可点击署名。
- [x] 放大弹窗无障碍名称等于 POI 名称（不再带「· 完整照片」后缀）。
- [x] 「需预约」徽章与「文化」等类别标签同行显示；有 `reservationNote` 时说明文字仍在。
- [x] 横向照片列宽 180px（桌面）/ 128px（≤600px），纵向照片同布局；无封面卡片文字列宽度与有封面卡片一致。
- [x] 照片在列内水平垂直居中，比例不变（横版不裁切、竖版不拉伸）。
- [x] `npm run typecheck` 与 `npm run build -w apps/web` 通过；`editor-browser.mjs`、`photo-layout-browser.mjs` 按新行为更新并通过。

## Definition of Done

- 改动只涉及 `apps/web` 与 `.trellis/spec/web`、`.trellis/spec/server` 文档同步。
- 不新增依赖、不引入第二套样式系统。
- 浏览器回归按新行为更新，不靠删除断言绕过。

## Technical Approach

- `DaySection.tsx`：删除按钮与 `onEditActivity` prop；`TripEditorPage.tsx` 相应删除 `editing`、`editingActivity`、`ActivityEditDialog` 渲染与 `PexelsCredit`，并清理 import。
- `ActivityEditDialog.tsx` 无引用后整文件删除；`editorStore` 删除只服务它的 `addActivity` / `updateActivity`（先确认无其它调用点）。
- `ActivityCard.tsx`：`.cat-badge` 行内追加 `<ReservationBadge poi={matchedPoi} />`；`activity-reservation` 块降级为「有 note 才渲染的 `<p>`」。
- `ActivityCard.tsx` 右侧列：`activity-content` 改 `items-center`；新增固定宽容器 `w-[180px] max-[600px]:w-[128px] shrink-0 flex items-center justify-center`（无封面时渲染同宽空 `span`，`aria-hidden`），`PoiPhotoGallery` 的 trigger 去掉 `self-start` 与 44% 宽度限制，改为在列内 `justify-center`，保留 `max-h` 比例约束与 44px 点击目标。
- `PoiCard.tsx`：`Modal title` 去掉 `· 完整照片`；删除 `PexelsCredit` 与只服务它的 `isPexelsCover`，同步移除 `PoiCard` 里不再使用的注释引用。

## Decision (ADR-lite)

**Context**: 09-28 曾移除三个入口后被撤回，09-29 明确「保留添加活动」；同时 Pexels API 条款要求使用其图片的页面提供指向 Pexels 的链接，卡片底部 `PexelsCredit` 是当时的实现方式。

**Decision**: 2026-10-06 用户确认两者都改：添加活动入口彻底移除（改用对话/重新生成）；卡片底部署名移除，仅保留放大弹窗内的可点击署名。卡片布局固定图片列宽，无图也占位。

**Consequences**: 新增活动只剩对话与重新生成两条路径，纯手工微调能力消失；Pexels 条款满足方式从「列表页显眼链接」收敛为「弹窗内署名 + 回链」，需同步 `integration-guidelines.md` 与 `env.ts`/`cover.ts` 中的旧描述。

## Out of Scope

- 不改生成页与候选抽屉的 `PoiCard` 紧凑卡布局。
- 不改地图、导出、通知。
- 不动后端预约状态判定逻辑。
- 不调整竖版/横版的最大高度数值（沿用现状）。

## Technical Notes

- `apps/web/src/components/editor/ActivityCard.tsx` — `activity-content` / `activity-main` / `PoiCover variant="photo"`。
- `apps/web/src/components/editor/DaySection.tsx:45` — 添加活动按钮。
- `apps/web/src/pages/TripEditorPage.tsx:14,73,146-148,172,180-182,240-247` — PexelsCredit、editing、ActivityEditDialog。
- `apps/web/src/components/PoiCard.tsx:104`（弹窗标题）、`152-174`（PexelsCredit / isPexelsCover）。
- `apps/web/src/store/editorStore.ts:40-41,179` — addActivity / updateActivity。
- 回归：`node --import tsx apps/web/tests/editor-browser.mjs`（第 130-133 行含添加活动流程，需改）、`node apps/web/tests/photo-layout-browser.mjs`（弹窗名称与照片尺寸断言）。
- 规范同步：`.trellis/spec/web/frontend/component-guidelines.md`（照片尺寸段、添加活动决策）、`.trellis/spec/server/backend/integration-guidelines.md:616-619`（PexelsCredit 描述）。
