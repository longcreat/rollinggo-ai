# 统一编辑器横向滚动条样式

## 目标与需求

- 编辑器页两个横向滚动区域的滚动条，视觉与同页竖向滚动条一致：细滚动条 + 半透明蓝色滑块、透明轨道。
  - 左栏天数标签 `.editor-day-tabs`（`TripEditorPage.tsx` 内联 class）。
  - 地图面板天数筛选 `.day-filter`（`TripEditorPage.tsx` 对 `MapView` 的 `.day-filter` 覆盖规则）。
- 复用竖向滚动已使用的 `--color-editor-page-scrollbar-color-65` token，不新增颜色。

## 验收条件

- [x] 天数标签溢出时，横向滚动条轨道透明、滑块为 `#aabde166`，与 `.editor-left-scroll` 竖向滚动条一致。（2026-10-04 用户看图验收）
- [x] 地图面板 `.day-filter` 横向滚动条同样一致。
- [x] 不改滚动条粗细（仍为 `thin`），不影响其他滚动区域。
- [x] typecheck 与既有浏览器回归脚本通过。

## 技术方案

在 `apps/web/src/pages/TripEditorPage.tsx` 已有的 `[scrollbar-width:thin]` 旁补上 `[scrollbar-color:var(--color-editor-page-scrollbar-color-65)_transparent]`，与 `.editor-left-scroll` / `ChatPanel` 的写法保持一致。

## 边界

不调整滚动条尺寸、不引入 `::-webkit-scrollbar` 全局样式、不改 `ChatPanel` / `Modal` / `HomeCapsule` 等竖向滚动区域。
