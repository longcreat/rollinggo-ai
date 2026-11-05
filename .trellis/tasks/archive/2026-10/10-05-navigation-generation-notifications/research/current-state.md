# 顶部导航、生成与站内通知现状

调研日期：2026-10-05。只读代码与规范，不做实现。

## 代码证据

| 文件 | 事实与设计影响 |
| --- | --- |
| apps/web/src/components/AppLayout.tsx | 已有胶囊导航与 /trips 链接；个人资料、设置为本地弹窗状态；退出依赖偏好保存状态。适合挂载账号级生成监听。 |
| apps/web/src/router.tsx | 登录页独立，认证后使用共享 AppLayout。当前仅 /、/trips、/trips/new、/trips/:id；拟新增具体生成进度路由。 |
| apps/web/src/hooks/useGenerationRun.ts | sessionStorage tw.activeJobId，页面级 EventSource，卸载只断流不取消服务端；409 接管；成功触发回调；不能独自覆盖网页关闭后的未读消息。 |
| apps/web/src/pages/NewTripPage.tsx | 建会话、Brief 与 autostart；成功回调 persist 当前偏好并设置 doneTripId，随后 Navigate 到详情。全局化必须防止旧任务回调保存新草稿或从其他页强制跳转。 |
| apps/web/src/components/GenerationRunPanel.tsx | 候选照片、阶段时间线、真实耗时及独立取消操作，标题优先使用 job_start 元数据；可复用，不另造假进度。 |
| apps/web/src/pages/TripListPage.tsx | 已完成行程卡片，目前没有后台生成卡片。 |
| apps/web/src/hooks/useEditorSave.ts | 自动保存有 flush 和修订回执，失败保留草稿；待路线重规划时 flush 可提前退出，不能简单视为所有修改均已保存。 |
| apps/server/src/routes/generations.ts | POST 返回 202，runGeneration 脱离 HTTP 请求执行；SSE close 只退订；当前无按账号查询 active job 的 HTTP 接口。 |
| apps/server/src/generation/jobManager.ts | jobs、runningByUser 为进程内 Map；一个账号一个运行任务；事件缓冲 512 条；完成内存保留 30 分钟；getRunningJobId 已可复用。 |
| apps/server/src/generation/orchestrator.ts | 成功时事务写 trip 与 generations 审计，再 completeJob；审计用 uid，非 jobId。失败先释放终态再尽力记审计。 |
| apps/server/src/db/schema.ts | PostgreSQL generations 为配额与用量核算，不是运行任务表，无通知 readAt。需要独立的通知持久化，不以浏览器在线写消息为成功前提。 |
| apps/web/src/components/SettingsDialog.tsx | 设置含 BYOK、外部数据源等配置。删除入口时应同步处理 no_llm 文案，不能误删个人已保存配置。 |
| apps/web/src/styles/tailwind.css | 品牌 #2f6bf3，浅底 #eef3fd，正文 #16325c；继续用现有语义 token 与 Tailwind。 |

在 web/src、server/src、shared/src 与 web/public 中检索 Notification、serviceWorker、pushManager、web-push、notifications，未找到既有通知实现。

## 已读取的规范

- .trellis/workflow.md：本轮处于设计 planning，用户要求先出方案，不能自动进入实现。
- .trellis/spec/web/frontend/index.md、state-management.md：React Query 服务端状态、URL 身份、编辑草稿隔离、订阅清理。
- .trellis/spec/server/backend/index.md、generation-guidelines.md 的生命周期相关段落：提交成功后才发布成功事件、单实例执行限制、失败释放运行锁。
- .trellis/tasks/10-04-home-pace-party-memory/prd.md：首页节奏与同行人数记忆任务尚在进行；不能由此任务覆盖他人改动，完成记忆与快照需协同。

## 方案取舍

1. 页面内任务状态：当前模式，导航后无法持续展示／提醒。
2. 共享任务状态加浏览器通知缓存：支持站内切换，但页面关闭期间无客户端写消息，不满足用户选定范围。
3. 共享任务状态加服务端持久化站内通知：满足未读恢复；不需要系统推送权限或 Service Worker。推荐。

## 工作流工具可用性

- 指定 .agents/skills/trellis-start/SKILL.md 不存在；检索项目与全局技能目录未找到同名技能。按 .trellis/workflow.md 读取开发者、git、任务与规范索引完成上下文初始化。
- trellis-brainstorm 从现存 .claude/skills/trellis-brainstorm/SKILL.md 读取，采用其中 Codex 内联调研例外。
- ui-ux-pro-max 的 SKILL.md 可读，scripts/search.py 不存在；设计参考已读取的导航、触摸、反馈与无障碍规则，以及项目现有样式；未伪称完成设计系统脚本检索。

## 交付边界

本次只新增设计任务文件，未改产品实现、未构建、未功能测试、未提交、未归档。其他并行任务与既有未提交修改保持原状。
