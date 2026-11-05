# 行程手册封面质感修正与城市 SVG 素材接入

## Goal

对照原始「我的行程」UI 图修正封面左侧书脊立体感，查找免费的城市标志性元素线稿 SVG 来源，方便用户手动下载到本地作为静态资源。

## Requirements

- 参考 `.trellis/tasks/09-28-my-trips-redesign/research/ui-reference.png`：窄圆弧书脊、柔和亮暗层、靠近书脊的压痕、上下两处短装订线；消除当前厚白边和双平面竖条。
- 保持现有整卡链接、搜索、筛选、排序、色系、无图居中文字与响应式布局。
- 仅推荐免费 SVG 下载来源；区分免费使用与署名/单个素材授权条件，标明未能核实之处。
- 预留本地静态 SVG 目录，按城市文件名自动发现，单色图按封面色系着色；资源缺失/加载失败回退文字封面。
- 用户自行选择下载素材。本次不下载第三方资产，不接入运行时外网图库请求。

## Acceptance Criteria

- [x] 左侧书脊的弧面、压痕与装订线接近原图，小屏不溢出。
- [x] 放入城市命名 SVG 后可展示，未配置及失败素材不影响行程访问，不请求每个行程详情。
- [x] 素材目录包含中文说明、命名示例、来源与免费授权说明。
- [x] 类型检查、Web 构建、样式检查与行程列表浏览器回归通过，保存截图。

## Decisions / Scope

- 用户确认：继续，只要免费。接受用户手动下载本地 SVG 的方向，当前授权包含封面样式修改。
- 使用现有 Tailwind 单样式入口，不添加库或后端接口。
- 多城市行程不猜测匹配地标，只有完整目的地名（允许单城市“市”后缀）匹配时展示。
- 暂不新增素材管理界面、付费图库、AI 生图或在线搜索接口。

## Research / Constraints

- 原实现位于 `apps/web/src/pages/TripListPage.tsx`，现有回归为 `apps/web/tests/trip-collection-browser.mjs`。
- 旧任务的“无手绘图”要求由本次可选本地素材需求补充：无资源时仍保持原文字封面。
- Trellis Codex start skill 在当前项目缺失，已读取 workflow.md 并运行 get_context.py 完成等效启动；before-dev / brainstorm 从项目 `.claude/skills/` 读取。
- UI 技能附带搜索脚本缺失，按技能的视觉层级、可读性、响应式及减少动效原则执行。
- 内置浏览器连接返回 unavailable，采用项目现有 Playwright 本地测试与截图。
