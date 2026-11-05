# 更新 README 项目介绍

## Goal

README 上一次更新停在 `2d139b8`（10-13 媒体对象存储 + CDN），此后合并的详情对话、历史版本、确定性排程、向量检索、行程天气、行程专属建议、首页选城改版、`eval/` 评测框架都没有进正文，且正文里还留着**已删除的功能**。目标是让 README 与代码现状一致，读者定位为 GitHub 访客：先讲能做什么，再给快速上手，部署细节保持现状不搬家。

## Requirements

* 删掉已不存在的功能描述：`💰 预算计算` 功能条目、架构图里「审校 Agent ─▶ 预算/动线审查」、截图表格里的「+ 预算」、开头的「算预算」；`computeBudgetSummary` 在 `apps/web` 已无调用点（只剩 `apps/server/src/__tests__/budget.test.ts`），前端也不收集 `budgetLevel`/`totalBudget`
* 功能清单补入：行程内对话（流式问答/改稿/真实餐厅入餐次）、历史版本查看与恢复、行程天气、行程专属建议、确定性排程、pgvector 混合检索、首页 SVG 选城
* 架构图改为反映现状：地点搜索走天地图、排程是纯代码环节、审校/撰写 Agent 负责地理编码·动线·天气
* 环境变量表补 `CHAT_DAILY_LIMIT`、`EMBEDDING_*`、`QWEATHER_*`
* 「验证与冒烟脚本」改写为「评测与验证」：先介绍 `eval/` 框架与四条 `eval:*` 命令，再列关键 `scripts/` 脚本；`typecheck` 的注释从「三包」修正为「四包」（shared/server/web/eval）
* 文档索引补齐 `DETERMINISTIC_SCHEDULING.md`、`COMPETITIVE_ANALYSIS.md`、`AMAP_QUOTAS.md`、`AI_SHARE_IMAGES.md`、`CITY_LANDMARK_ASSETS.md`、`eval/README.md`
* 路线图打勾 M5/M6/M7，「对话式改稿」从 V1.1 候选移除（已实现）
* 快速部署补一句镜像双轨（默认拉 ghcr，`TRIPWEAVER_IMAGE=''` 本地构建）与反代约定

## Acceptance Criteria

* [x] README 中不再出现「预算计算 / 超支预警 / 算预算」等已删除功能的描述
* [x] 新增功能条目均可指向代码或文档佐证（对话流 → `.trellis/spec/server/backend/detail-chat-history.md`；天气 → `trip-weather.md`；建议 → `trip-advice.md`；检索 → `rag-guidelines.md`；排程 → `docs/DETERMINISTIC_SCHEDULING.md`）
* [x] 环境变量表中每一项都能在 `.env.example` 或 `apps/server/src/env.ts` 找到同名键
* [x] 所有相对链接指向存在的文件（`docs/*.md`、`eval/README.md`、`LICENSE`）
* [x] `npm run typecheck` 不受影响（仅改 Markdown，不触碰代码）
* [x] 改动停在提交前，等用户验收

### 第二轮：主页化重构（用户验收反馈）

用户要求「改成符合现有项目的介绍，优化 GitHub 项目主页」，故放弃「结构不动」的初版决策：

* [x] 站长向细节（环境变量表、数据源细节、图片存储/CDN、GitHub 登录、成本、安全）整体迁到 `docs/DEPLOYMENT.md`，README 保留两行快速开始 + 一句话链接
* [x] README 顶部加 4 枚 badge（在线体验 / CI / Docker / License），不加 logo 图片
* [x] 功能列表从 12 条技术条目改写为 8 条用户收益，「确定性排程烧 4.7 万 token」等技术论证降级到「技术亮点」小节
* [x] `docs/DEPLOYMENT.md` 的环境变量覆盖 `.env.example` 全部键（含此前 README 缺失的 `RESEND_API_KEY`/`MAIL_FROM`/`PEXELS_API_KEY`/`UNSPLASH_ACCESS_KEY`/`PIXABAY_API_KEY`/`PHOTO_REVIEW_*`/`POSTGRES_PASSWORD`）
* [x] 相对链接自检通过（README / DEPLOYMENT 内所有 `docs/*.md`、`eval/README.md`、`LICENSE`、截图、脚本路径均存在）
* [x] 正文不含「预算计算 / 超支预警 / 算预算」等已删除功能

## Definition of Done

* README 正文与 `apps/web` 路由/组件、`apps/server/src/routes/` 实际能力一致
* 无失效相对链接
* 交付时给出改动摘要，未执行任何 git 写操作

## Technical Approach

单文件改动：`README.md`。保留原有章节顺序与详尽的部署/环境变量内容（用户明确不搬家），只做「删过期、补现状、修索引」。事实来源按优先级取：`.trellis/spec/server/backend/*.md`（功能契约）→ `apps/server/src/env.ts` 与 `.env.example`（配置键）→ `apps/web/src` 与 `apps/server/src/routes/`（实际能力）→ `docs/*.md`（长文入口）。

## Decision (ADR-lite)

**Context**：README 是唯一对外的功能说明书，但它靠人工维护，跟不上 10-03 之后的高频迭代；且它描述的是「曾经做过」而不是「现在能用」，对开源访客是误导。用户选择「全文同步到最新状态」，同时明确不重构结构（不把部署细节搬去 `docs/`）。

**Decision**：
1. 以「代码/契约是否仍存在」为唯一判据删除条目，而不是靠记忆判断功能是否被砍
2. 部署与环境变量章节保持原样，仅做增行，降低这次改动的回归面
3. 验证脚本章节改为「评测与验证」：`eval/` 是主力验收手段，`scripts/` 里的零散脚本只保留代表性入口，不逐一列举（`scripts/` 已有 30+ 个文件）

**Consequences**：
* README 篇幅略有增长（新增 7 条功能、12 个环境变量行、6 个文档链接），但部署信息一条没丢
* `scripts/` 中未列出的验证脚本（`verify-amap-settings.mjs`、`verify-websearch-settings.mjs`、`verify-route-options.mts` 等）不再有 README 入口，后续若需要对外说明得回到 `eval/README.md` 或脚本自身的注释
* 未改动 `docs/*.md`：`PRD.md` 仍是 v0.3 快照（其内部已注明「现状以 README 与技术架构为准」），本次不动

### 追加决策（第二轮）

**Decision**：推翻原第 2 条「部署与环境变量章节保持原样」。改为按受众分层——README 面向 GitHub 访客（能做什么 / 截图 / 三步跑起来），`docs/DEPLOYMENT.md` 面向站长（Key、配额、存储、成本）。README 从 236 行降到 99 行。

**Consequences**：
* 环境变量表从此有唯一权威位置（`docs/DEPLOYMENT.md`），改配置只需改一处；`.env.example` 是注释详版，两者不重复维护表格语义
* README 的「评测与验证」章节被删除，验证入口只剩 `eval/README.md` 链接——因为 `eval:*` 与 `scripts/` 脚本清单属于贡献者向内容，与主页定位不符
* 样式约定（Tailwind `@theme` 语义色）段落从 README 移除，仍在 `docs/TECHNICAL_ARCHITECTURE.md §8`
