# 织程 TripWeaver · PRD（产品需求文档）

- 项目名称：**织程 TripWeaver**（仓库名 `tripweaver`）
- 文档版本：v0.7（全面对齐 Agent Harness、高德单源与行前体检体系）
- 日期：2026-11-08
- 关联文档：[技术架构](./TECHNICAL_ARCHITECTURE.md) · [开发计划](./DEVELOPMENT_PLAN.md) · [Person Agent 计划](./PERSON_AGENT_PLAN.md) · [行前体检方案](./TRIP_REFINEMENT_PLAN.md)

---

## 1. 产品概述

### 1.1 一句话定位

**开源的 Agent 旅行工作台** —— 一个 harness Agent 全程编排：查高德真实地点、规划行程、陪你逐句改稿、行前体检兜底风险，全程在对话与动线地图上完成。

### 1.2 核心设计哲学

**“模型负责决策与表达，代码负责物理校准与硬约束”**：
- 空间、时间、距离、营业状态具有不可妥协的物理刚性，大模型直接计算极易出现严重时空幻觉（如“上午故宫下午八达岭”或无视周一闭馆）。
- 织程通过给 Agent 装配完备的工具组（高德地理编码、驾乘步骑路线、周边展开、天气核算），并由事后确定性校准层与规则审计引擎兜底，将幻觉从结构上杜绝。

### 1.3 核心用户旅程：三阶段生命周期

| 阶段 | 核心形态 | 用户体验与心理 | Agent 角色 |
|---|---|---|---|
| **Planning 规划中** | 自然语言意图理解 → 直播编辑器（逐日长出） | “它在认真帮我查证和规划” | **编排者**：调研取材、聚类分片、顺路排序、推演时刻 |
| **Editing 编辑中** | 三位一体工作台（对话 + 行程日历 + 动线地图） | “改动看得见、听得懂，改错了能一键退回” | **助手**：19 工具读写草稿、派生只读子代理、HITL 确认 |
| **Preparing 行前体检** | 规则审计 → 实时核验 → 决策卡拍板 → 自动重排 | “帮我把所有潜在违规和风险都兜住了” | **审计员**：10 条硬规则审计、预约与天气核查、确定性修复 |

---

## 2. 目标用户与运营形态

| 角色 | 是谁 | 关键诉求 |
|---|---|---|
| **普通用户（主角）** | 自由行规划者、结伴出行组织者、非 IT 亲友 | 微信/手机随时可用；零技术门槛（无 Key、无复杂术语）；对话就能改稿；一键导出分享长图发群里 |
| **站长（运营者）** | 部署实例的开发者/开源用户 | Docker Compose 一键起；成本可控（用户日配额、高德单源、BYOK 支持）；数据自持 |
| **极客用户（少数）** | 拥有自己 API Key 的技术型用户 | 高级设置中配置 BYOK（自定义模型与 Base URL，AES-256-GCM 保护） |

---

## 3. 核心功能需求

### F1 自然语言建单与行前回合

1. **首页意图解析（`POST /api/chat/parse-prompt`）**：
   - 用户可直接输入自由文本（如：“下周带父母去西安玩 3 天，想吃泡馍，节奏慢一点”）。
   - 服务端大模型在 8 秒内解析出目的地、天数、偏好、人群特征与节奏，并结构化跳转新建页。
2. **行前主 Agent 确认（Planning Turn）**：
   - 并非前端直接开 Job，而是「建会话 → 写 Brief → 把首条消息交给主 Agent（`POST /api/conversations/:id/messages/stream`）」；
   - 主 Agent 确认条件齐备后，调用工具 `delegate_task(kind: 'trip_generation')` 委派后台任务，随后页面平滑转入直播态。

### F2 智能生成与“逐日长出”直播编辑器（`/agent/:jobId`）

1. **多阶段生成流水线**：
   - **调研 Agent**：从知识库（`canonical_places` + `pgvector` 语义检索）与高德真实 POI 筛选候选池，生成实证卡。
   - **规划 Agent**：2.5km 单链聚片区（`list_areas`）→ 搜片区（`search_area_places`）→ 顺路排序与时刻推演（`plan_day`）。
   - **建议与文案 Agent**：并发修饰每日标题与生成专属旅行建议。
   - **确定性校准层**：纯代码执行 `geocodeAll` → 补餐锚点换真实餐厅 → 真实高德路线计算 → 远郊混排修复（`repair_long_haul`）→ 闭馆硬检。
2. **直播编辑器体验**：
   - `/agent/:jobId` 与 `/trips/:id` 复用同一 `TripEditorPage` 工作区。
   - 左侧展示 `LiveAgentStream` 播报阶段、工具胶囊与思考过程，支持点击查看子代理详情；
   - 右侧行程卡片与 Leaflet 动线地图根据 `plan_day` 事件**逐天长出**；
   - 完成后**原地无缝切入编辑态**，无需重新跳页加载。

### F3 详情对话主 Agent 与内存草稿（Chat as Editor）

1. **单一读写主 Agent（pi-durable harness）**：
   - 运行于每人独占的 SQLite 会话存储中（`data/agent-runs/<userId>.sqlite`），支持断点恢复 `resume()` 与上下文压缩。
   - 包含 19 个工具：读行程（`get_trip` / `get_day`）、查证（`search_places` / `search_area_places` / `web_search` / `get_weather` / `search_food`）、交互（`ask_user`）、后台委派（`delegate_task` / `task_status` / `update_brief`）以及 9 个写工具（`add_activity` / `update_activity` / `delete_activity` / `move_activity` / `reorder_day` / `add_day` / `update_day` / `delete_day` / `update_trip`）。
2. **内存草稿与原子版本链**：
   - 写工具操作仅作用于内存副本 `tripDraft`；
   - 回合结束前自动修复动线（`repairChangedRoutes`）并重算时刻（`scheduleDays`）；
   - 提交钩子由 `commitOperation` 在单一数据库事务中乐观锁写入，**一轮对话只落一个新版本**。
3. **改动清单与一键撤销（Rewind）**：
   - 机器人回答末尾附带本次改动清单卡片，明确告知新增、修改或移动的节点；
   - 卡片提供**「撤销这次修改」**按钮，调用 `POST /api/trips/:id/rewind` 物理回滚目标版本之后的所有修改，上一版本重新成为当前版。
4. **人在回路（HITL）交互卡片**：
   - 遇重大权衡时调用 `ask_user`，服务端挂起，前端渲染 `QuestionCard`；
   - 用户在界面点选后通过 `POST /questions/:id/answer` 回注，主 Agent 在同一回合内继续执行；120s 超时兜底。
5. **并发只读子代理（`spawn_subagents`）**：
   - 主代理可派生最多 3 个只读探索子代理并发检索片区或美食，深度恒为 1，结构化 JSON 回传，坐标自动进入主回合缓存。

### F4 行前体检（Health Check）与决策卡

1. **Pass 1a 纯确定性审计（零 LLM，<100ms）**：
   - 规则引擎审计 10 条物理违规（闭馆冲突、特种兵超载、远郊市区混排、就餐时刻异常、换乘过紧等），生成结构化 `HealthFinding`（分为 hard 硬冲突与 soft 可优化）。
2. **Pass 1b 实时情报核验**：
   - 针对重点景点，支持调高德核验最新营业时间、LangSearch 核验预约放票政策、和风核验天气窗口。
3. **决策卡交互**：
   - 每一个 Finding 生成一张决策卡，提供三选一：**【按建议改】/【我自己处理】/【跳过】**（或顶部一键【硬冲突全按建议改】）。
4. **Pass 2 纯确定性重排（零 LLM）**：
   - 消费 accept 的决策进行活动删除或跨天移动；
   - 严格单步递减验证：每步操作后重新审计，hard 违规不严格递减则单步回滚；
   - 重新调度时刻与高德路线，生成带有 `体检修复：...` 标识的新版本。

### F5 地图与多形态导出

1. **Leaflet 动线地图**：
   - GCJ-02 坐标体系，高德栅格瓦片；
   - 按天配色标记、序号色标、高德真实路线连线；支持单日过滤与视窗自动聚焦（fitBounds）。
2. **多形态导出**：
   - **AI 分享长图海报**：专门为微信环境优化的手账风与水墨风海报（服务端 AI 绘图引擎生成）；
   - **PDF 打印稿**：排版友好的便携打印格式；
   - **标准 JSON**：完整结构化数据导出与导入。

### F6 认证、设置与配额

1. **多用户与认证**：
   - 开放注册 / 邀请码模式（`REGISTRATION_MODE` 可配置）/ GitHub OAuth 一键登录；
   - 密码找回与邮箱验证码流程；httpOnly Cookie 会话保持。
2. **BYOK 与安全隔离**：
   - 支持极客配置自有 LLM Key 与 Base URL，AES-256-GCM 服务端加密，全路由 `userId` 越权防护，Base URL 严格经过 SSRF 拦截（内网/环回地址强制拒绝）。
3. **配额管理**：
   - 用户级每日生成与对话独立限额（`GEN_DAILY_LIMIT` / `CHAT_DAILY_LIMIT`）；
   - 高德数据源默认**只计量不拦截**（`AMAP_QUOTA_ENFORCE=false`，开源部署友好）。

---

## 4. 关键非功能性指标

| 维度 | 指标与实现 |
|---|---|
| **前端基准** | 移动端与微信内置浏览器为一等目标，纯 CSS 语义化 Token，首屏路由分包与地图按需加载 |
| **数据一致性** | 业务表 + 版本链 + 向量知识库统一位于 PostgreSQL 16；Agent 会话状态由 pi-durable SQLite 保证 |
| **防幻觉标准** | 所有地点来自高德真实 POI；交通时间来自高德路线；闭馆日与营业时间具有硬闸门拦截 |
| **可逆性** | 所有对话写操作与体检重排均产生新版本快照，支持秒级 Rewind 物理撤销 |
| **部署形态** | Docker Compose（应用容器 + PostgreSQL pgvector 容器），宿主机轻量反代 |
