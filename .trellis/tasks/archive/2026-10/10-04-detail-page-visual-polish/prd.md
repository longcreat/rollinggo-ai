# 详情页视觉与交互收尾

## 背景

本任务是一次集中的人工视觉复核（2026-10-04），逐条按用户现场反馈改详情页。改动落在 `10-04-trip-weather-overview` 引入的同一批文件上（`TripEditorPage` / `DaySection` / `DayWeather` / `TripOverview`），两者无法拆成两次可编译的提交，因此与天气任务同一个提交落地。

## 改了什么

- **分隔符**：详情页不再用 `·`，改成拆 `span` + 容器 `flex flex-wrap items-center gap-2` 供间距；覆盖顶栏 `editor-trip-meta`、天数头、总览总站数、天气两行、交通方式选项三处、两个地图气泡。
- **每日行程天气**：删掉独立天气卡片，只把「图标 + 天气 + 温度」移到「第N天」旁边；`DayWeather` 根元素改 `inline-flex`，`detailed` 变体（城市、白天/夜间风力、更新时间和未配置说明）整个删除。
- **备选清单**：按钮、弹窗与 `CandidateDrawer` 删除。
- **地图交互**：去掉 InfoWindow / Leaflet Popup 气泡，点地点改为让中间行程栏切到那天并滚到对应景点（`jumpToActivity`，同时把移动页签切回「行程」，与对话「查看编辑结果」共用）。
- **地图页签**：删掉地图上方的天数页签，地图只跟随左栏 `dayFilter`；`TripEditorPage` 里配套的 `[&_.day-filter]` / `[&_.day-filter-btn]` 覆盖一并清理。
- **栅格回退**：详情页栅格改回 `26fr 41fr 33fr`。`9b4a7b5` 曾改成 `31fr 37fr 33fr`，中栏变窄后 POI 照片从 `min(180px, 44%)` 的 180px 固定档掉到 44% 档（1440 下只剩 161px）；回退后照片尺寸与 10-02 基线逐像素一致。
- **对话开场**：开场文案保留，「已包含主要景点、交通和住宿信息」改为「已包含主要景点与交通安排」（生成结果里没有住宿信息）。

## 验收条件

- [x] 详情页正文与控件中不再出现作为分隔符的 `·`。
- [x] 每日行程卡片无天气卡片，天气只在「第N天」旁显示图标 + 天气 + 温度。
- [x] 编辑器内不再有「备选清单」入口；`CandidateDrawer` 已删除。
- [x] 点地图编号 pin：中间栏切到那天并滚到该景点，不弹气泡；移动端切回「行程」页签。
- [x] 地图上方无天数页签；选天仍会淡化其他天。
- [x] 1440 下 POI 照片宽度回到 180px（`photo-layout-browser.mjs` 的 170 阈值重新成立）。
- [x] `typecheck`、`npm run build -w apps/web`、`editor-browser.mjs`、`route-options-browser.mjs`、`trip-weather-browser.mjs`、`photo-layout-browser.mjs`、`handwriting-browser.mjs`、`generation-browser.mjs`、`styles.test.mjs` 通过。

## 已知遗留

- 地图气泡同时去掉了「坐标为估算」提示与来源笔记链接；这些信息仍在活动卡片里，但地图上不再有入口。
- `PoiCard` 组件在 `CandidateDrawer` 删除后已无调用方，保留未删（`PoiCover` / `PexelsCredit` 仍在用）。
- `photo-layout-browser.mjs` 原先因 mock 缺 `/versions` 与未点天数页签而整测试崩溃，本次一并修好，并删掉依赖备选清单的照片用例。
