# 图片版权信息仅在照片放大查看时展示

## 目标与授权

用户 2026-10-02 要求：图片版权信息改为只在详情页把照片放大查看时展示，其余位置隐藏。本轮不提交、不归档，等用户验收。

## 已确认需求

1. 版权行只在照片放大弹窗（`PoiPhotoGallery` 的 `Modal size="photo"`）内保留，位置维持现状（放大图下方的文档流，不改成叠加在照片上）。
2. 非放大位置全部隐藏：生成页立得卡、编辑器活动卡片、候选抽屉（候选抽屉通过 `PoiCard` 复用，随之生效）。
3. 弹窗内去掉末尾的 ` · {credit.changes}` 说明文字（如「复用已选图尺寸版本，未额外裁切」），同时去掉承载它的 `title`。
4. 列表页的 Pexels 统一链接（`PexelsCredit`，文案 “Photos provided by Pexels”）保留不动，规避 Pexels API 条款风险。
5. 署名数据本身（`coverAttribution`、`PoiPhoto.attribution`、`changes` 字段）不改，只改渲染位置；导出/分享图本来就未渲染版权行，不受影响。

## 影响文件（预期）

- `apps/web/src/components/PoiCard.tsx`：`PhotoCredit` 去掉 `changes` 与 `title`；compact 与非 compact 分支移除 `<PhotoCredit />`（含 compact 卡片的 `[&_.poi-body]` 间距微调如不再需要一并处理）。
- `apps/web/src/components/editor/ActivityCard.tsx`：移除活动卡片底部版权行与对应 import。
- `apps/web/src/components/GenerationRunPanel.tsx`：移除立得卡内 `<PhotoCredit />` 与 import；移除 `gen-fan` 上依赖 `.photo-credit` 的 `:has()` 下外边距媒体查询（失去匹配对象后成为死样式）。
- `apps/web/tests/photo-layout-browser.mjs`：断言改为「卡片内不存在 `.photo-credit`，放大弹窗内仍存在且随切换更新」。

## 验收条件

- [ ] 生成页立得卡、编辑器活动卡片、候选抽屉都不再出现版权行
- [ ] 放大弹窗仍显示作者 / 来源 / 许可三个链接，切换照片后署名随之切换
- [ ] 弹窗内不再出现 changes 文案
- [ ] Pexels 统一链接行为不变（列表内出现 Pexels 图时才渲染）
- [ ] 定向浏览器回归与 `npm run typecheck` 通过

## 参考

- `.trellis/spec/web/frontend/component-guidelines.md`
- `apps/web/tests/photo-layout-browser.mjs`
- `.trellis/tasks/09-30-ranked-place-photography/research/selection-analysis/findings.md`
