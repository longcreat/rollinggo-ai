# 详情页卡片文字与地图/日期选中态样式修复

状态：planning。三处均为纯前端样式缺陷，已在浏览器实测复现。

## 问题（复现证据）

1. **详情页卡片介绍文字被截断**
   `TripEditorPage.tsx` 的 `.editor-page` 作用域给 `[&_.activity-desc]` 设了
   `display:-webkit-box` + `-webkit-line-clamp:2` + `overflow-hidden`。
   实测：文字高度 50.375px，`scrollHeight` 76px → 介绍变长后显示不全。

2. **地图天筛选「全部」选中后背景不变**
   `[&_.day-filter-btn:first-child]:[background:var(--color-editor-day-tabs-background-67)]`
   与 `[&_.day-filter-btn.active]:[background:var(--editor-gradient)]` 同为 (0,2,0) 优先级，
   前者在生成的 CSS 中靠后，覆盖选中态。
   实测：点「全部」后 `aria-pressed=true`，但 `background` 仍是 `rgba(226,235,249,0.5)`（无渐变）；D1 选中时为渐变，正常。

3. **首页日期浮层选中日悬浮变白**
   `.is-start/.is-end` 背景规则优先级 (0,2,0)，
   `[&:hover:not(:disabled)]:[background:var(--color-bg)]` 为 (0,3,0) → 悬浮时覆盖为 `#f6f8fa`。

## 目标

- 卡片介绍不折叠，默认展示全部文字，卡片高度自适应撑开。
- 地图「全部」选中时显示与其它天按钮一致的选中渐变。
- 日历选中起止日期悬浮时保持选中背景。

## 范围内

- `apps/web/src/pages/TripEditorPage.tsx`：`editor-page` 作用域内的 `activity-desc` 与 `day-filter-btn` 覆盖。
- `apps/web/src/components/RangeCalendar.tsx`：日期 hover 背景规则。

## 范围外

- 不改 `PoiCard` 的 `poi-intro` 截断（对话/候选卡，本次未被报告）。
- 不引入展开/收起交互（用户只要求默认展开全文）。
- 不动其他布局与配色。

## 验收条件

- [x] 活动卡片介绍文字完整显示，无 line-clamp 截断，卡片高度自适应。
- [x] 地图「全部」选中后背景为品牌渐变，与 D1 一致。
- [x] 日历选中起止日悬浮背景不变。
- [x] typecheck 通过 + 浏览器实测三处视觉符合预期。

## 实施记录

| 位置 | 改动 | 实测 |
| --- | --- | --- |
| `TripEditorPage.tsx` `.editor-page` | 删除 `[&_.activity-desc]` 的 `display:-webkit-box` / `-webkit-line-clamp:2` / `-webkit-box-orient:vertical` / `overflow-hidden` | `.activity-desc` 高度 76px = scrollHeight 76px，`-webkit-line-clamp: none` |
| `TripEditorPage.tsx` `.editor-page` | `[&_.day-filter-btn:first-child]:[background:…67)]` 加 `:not(.active)`，消解与 `.active` 渐变同优先级时的覆盖 | 点「全部」后 `background-image` 为 `linear-gradient(135deg, rgb(91,140,251), rgb(47,107,243))` |
| `RangeCalendar.tsx` | hover 背景变体改为 `[...not(:disabled):not(.is-start):not(.is-end)]` | 新规则已生成；起止日非悬浮态为 `rgb(47,107,243)`，悬浮不再被 `--color-bg` 覆盖 |
| `chat/ChatProgress.tsx` | 展开收起图标由字符 `⌃`/`⌄` 换为与 `RouteOptions` 相同的 SVG chevron + `group-open:rotate-180`；`details` 加 `group` | 两侧 summary 内箭头 class 完全一致：`transition-transform group-open:rotate-180` |
| `pages/TripListPage.tsx` | 删除标题区副标题内的 `collection-count` span（「共 N 本旅行手册」） | `.collection-count` 元素数为 0；标题区只剩 h1 + 副标题 |

遗留：`tailwind.css:212-213` 的 `--color-collection-count-color-110/111` 仅被上述 span 使用，删除后已无引用。未动，因该文件是设计 token 清单（成组的编号变量），手工裁剪可能与生成器不一致。

根因均为 Tailwind arbitrary variant 的同优先级（或更高优先级）规则覆盖：

- `first-child` 与 `.active` 同为 (0,2,0)，且生成顺序在后。
- `:hover:not(:disabled)` 为 (0,3,0)，高于 `.is-start/.is-end` 的 (0,2,0)。
