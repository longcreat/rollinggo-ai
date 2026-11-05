# 无封面卡片文字占满宽度

## Goal

上一轮为「所有卡片文字宽度一致」给右侧图片列保留了空占位。实测无封面时右侧留白太大，文字被压窄。改回：**只有真的有封面时才占位**，无封面卡片文字独占整行；有封面卡片仍固定列宽、照片列内居中。

## Requirements

1. `ActivityCard` 无可用封面（无 `coverUrl` 或加载失败）时不渲染 `.activity-photo` 占位，`.activity-main` 自然占满。
2. 有封面时行为不变：固定列宽 180px（≤600px 时 128px），照片在列内水平 + 垂直居中。
3. 回归同步：`photo-layout-browser.mjs` 把「无图也占位」断言改为「无图不占位且文字占满」。
4. 规范同步：`component-guidelines.md` 中「always reserves space」的表述改掉。

## Acceptance Criteria

- [x] 无封面卡片里 `.activity-photo` count 为 0，`.activity-main` 宽度 > 卡片宽度的 60%。
- [x] 有封面卡片仍满足 180/128px 固定列宽与列内居中（既有断言保留通过）。
- [x] `npm run typecheck`、`node apps/web/tests/photo-layout-browser.mjs`、`node --import tsx apps/web/tests/editor-browser.mjs`、`trip-weather-browser.mjs` 通过。

## Definition of Done

- 只动 `apps/web/src/components/editor/ActivityCard.tsx`、一个浏览器回归、一份 spec。
- 不改数据字段、不改图片尺寸约束（`object-contain` 与 `max-height` 保持）。

## Technical Approach

把 `PoiCover` 的三元渲染改回条件渲染：

```tsx
{showCover && matchedPoi && <span className="activity-photo flex w-[180px] shrink-0 items-center justify-center max-[600px]:w-[128px]"><PoiCover … /></span>}
```

`.activity-content` 保持 `items-center`，无图时 flex 里只剩 `.activity-main`（`flex-1`）自然占满。

## Decision (ADR-lite)

**Context**: 2026-10-06 先按「文字宽度全部一致」实现空占位，同一天用户看实际效果后要求无图时文字占满。

**Decision**: 有图为固定列宽，无图不留占位。不同卡片文字宽度可以不同。

**Consequences**: 同一屏内卡片文字右边界会不齐；换来无图卡片的信息密度。

## Out of Scope

- 不改有封面的列宽数值与照片尺寸上限。
- 不改紧凑卡（生成时间线）与候选卡。

## Technical Notes

- `apps/web/src/components/editor/ActivityCard.tsx:52` — 图片列渲染行。
- `apps/web/tests/photo-layout-browser.mjs:~118` — 「empty photo column still reserves space」断言。
- `.trellis/spec/web/frontend/component-guidelines.md` — Photo layout 段落里的固定列宽说明。
