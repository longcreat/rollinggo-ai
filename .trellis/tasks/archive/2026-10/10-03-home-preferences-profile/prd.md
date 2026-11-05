# 首页个性化备注、偏好记忆与个人资料

## 目标与已确认范围

用户于 2026-10-03 选择“按账号记住最近设置”：保存最近一次偏好、出行方式和个性化备注；下次首页自动带入；个人资料可查看、修改、清空。目的地、日期、节奏及同行人数不纳入长期记忆，不提供多套历史版本。

## 需求

- 首页“偏好与出行”增加备注输入，例如“带小孩一起”，最多 200 字，与现有 GenerateForm / PlanningBrief 限制一致。
- 首页改动只存本地草稿，**不写账号**；只有行程生成成功后才把这一轮选择记入账号。生成失败、刷新、退出都丢弃草稿，下次首页回到账号已记住的值。
- 右上角增加“个人资料”弹窗，展示当前账号与同一份偏好设置，支持修改、清空。
- 备注从首页传至 NewTripPage、Brief 和生成请求，复用 extraNotes，不新增平行约束模型。
- 账号持久化隔离；更改未来偏好不改写已生成行程或进行中的快照。
- 数据库不可用时不得伪称已保存；加载失败允许重试。

## 技术方案

- shared 增加 TravelPreferences schema / 派生类型。
- 专用 user_travel_preferences 表保存账号最近设置；GET/PUT /api/settings/travel-preferences，复用鉴权和 API envelope。
- AppLayout 中共享偏好草稿：React Query 持有服务器快照，`change()` 只改本地草稿。`persist()` 是唯一的写入入口，个人资料弹窗 500ms 防抖后调用它；NewTripPage 在生成成功的 `onDone` 里调用它。mutation scope 串行提交，旧回执不能清除新草稿；失败保留草稿并重试。
- 首页与个人资料共用输入组件；首页不显示保存状态，改动静默留在本地草稿里。

## 验收标准

- [x] 首页改动不写账号；生成成功后刷新、重新登录可恢复；生成失败与刷新后回到账号已记住的值。
- [x] 个人资料修改 500ms 自动保存，和首页共用同一份值；清空后刷新仍为空。
- [x] 两个账号互不影响；未登录拒绝读写；非法输入被拒绝。
- [x] 生成的 Brief 和请求含完整备注。
- [x] 快速连续修改及保存失败重试不丢最新值。
- [x] 桌面/手机布局、键盘关闭弹窗、错误反馈可用。
- [x] typecheck、web build、针对性测试通过。

2026-10-04 用户确认验收并归档。本轮重跑：`travel-preferences-browser.mjs`、`shared-ui-browser.mjs`、typecheck、web build 均通过；`verify-travel-preferences.mts` 因本机 18797 端口无 PostgreSQL 未能重跑，仍以 `research/verification.md` 记录的上次通过为准。

归档时的提交范围：只提「偏好线」——本轮另做的详情页视觉/交互改动（`·` 间距、每日卡片天气、地图点跳转、栅格回退、备选清单与地图页签删除）与其他 4 个任务（天气/补图/评估/总览）的改动仍留在工作区，未随本任务提交。

## 调研记录

HomeCapsule 当前仅组件内保存偏好及交通方式；HomePage 经 URL 传参至 NewTripPage。shared 的 PlanningBriefData、PlanningBriefPatch、GenerateForm 已支持 extraNotes（200 字），无需改造生成域。现有 user_settings 存放服务凭据，因此使用独立偏好表避免覆盖凭据。个人资料使用共享 Modal，保留原设置入口。

## 交付状态

实现与自测后交付用户验收；验收前不提交、不归档、不标记完成。

2026-10-03 续作：已恢复并审查现有实现，补充旧会话保存队列的身份校验及原始请求严格校验，修复 `null` 备注被隐式转换为空字符串的问题。针对性数据库与浏览器回归已通过；验收项保留未勾选，等待用户确认。详见 `research/verification.md`。

2026-10-04 改为“生成后才记忆”：用户明确要求首页选择不再每次保存。`TravelPreferencesProvider` 去掉按 draft 自动 PUT 的副作用，改为显式 `persist()`；`TravelPreferencesFields` 新增 `autoSave`（个人资料弹窗仍即时保存并保留清空/重试），首页仅在生成成功后由 NewTripPage 的 `onDone` 提交。浏览器回归已按新契约改写（含一条 SSE 成功生成与一条失败生成）并通过。

2026-10-04 视觉副审：首页面板不再显示任何保存提示；备注输入框聚焦改为边框/底色变化（`Field` 的 `panel` 变体，必须显式 `focus:outline-none`，否则会露 UA 默认黑框）；偏好/出行方式选中态与圆角对齐目的地卡片；面板小字统一为 `calc(12*max(1px,var(--ui,1px)))`。

2026-10-04 生成完成直接进详情：NewTripPage 去掉 1.8 秒停留与进度面板终态卡片（`run.jobId && !doneTripId` 才渲染面板），生成成功、快照恢复两条路都直接跳 `/trips/:id`。审核说明不再在生成页展示，但仍是 `trip.meta.reviewNotes`，在详情总览「注意事项」与导出里可见。

2026-10-04 详情页文案排版：详情页不再用 `·` 当分隔符，改为 flex 间距（顶栏、天数头、总览、天气、交通方式选项、地图气泡）；每日卡片的天气卡片删掉，只把天气图标 + 「天气 温度」移到「第N天」旁，白天/夜间风力与更新时间不再展示（`DayWeather` 的 `detailed` 变体随之删除）。

2026-10-04 地图与备选清单：备选清单入口、弹窗与 `CandidateDrawer` 删除（`PoiCard` 组件保留未用）；地图不再弹气泡，点地点改为让中间行程栏切到那天并滚到对应景点（`TripEditorPage.jumpToActivity`，同时把移动页签切回「行程」，与对话「查看编辑结果」共用同一个 helper）。`AmapCanvas` 的 `InfoWindow` 类型与 `popupHtml` 一并删除。回归：`editor-browser.mjs` 新增点 pin 跳转断言。

2026-10-04 栅格与地图页签：详情页栅格回退到 `26fr 41fr 33fr`（`9b4a7b5` 曾改成 `31fr 37fr 33fr`，把中栏改窄后 POI 照片从 180px 固定档掉到 44% 档，只剩 161px）；地图上方的天数页签删除，地图只跟随左栏天数页签的 `dayFilter`，`TripEditorPage` 里的 `[&_.day-filter]` / `[&_.day-filter-btn]` 覆盖一并清理。

2026-10-04 对话开场：开场文案保留，但把「已包含主要景点、交通和住宿信息」改成「已包含主要景点与交通安排」（生成结果里没有住宿信息）；首页发起生成前的那次 Brief 留档改走 `PATCH /api/conversations/:id/brief?snapshot=1`，不再往对话里追加「目的地改为…」和「已更新：…信息齐了，可以开始生成。」这两条系统消息。
