# 织程 TripWeaver · 技术架构文档

- 项目名称：**织程 TripWeaver**（仓库名 `tripweaver`）
- 文档版本：v0.7
- 日期：2026-11-07
- 关联文档：[PRD](./PRD.md) · [开发计划](./DEVELOPMENT_PLAN.md) · [Person Agent 计划](./PERSON_AGENT_PLAN.md) · [行前体检方案](./TRIP_REFINEMENT_PLAN.md)

> **修订记录**
> - v0.2~v0.6：历史演进（前后端分离 → 三 Agent 流水线 → 小红书语料 RAG → GCJ-02 坐标 → pgvector 检索），细节见 git 历史与本文件旧版。
> - **v0.7（本版）**：**产品范式切换为 Agent harness 中心**——
>   ① 生成主链路改为「调研 Agent → 规划 Agent（选点/分天/排序/时刻）→ 确定性校准层」；旧的确定性排程引擎（`scheduling/schedule.ts`）退出生成主链，仅剩「对话加天」路径待迁移；
>   ② 详情对话升级为**单一读写主 Agent**（pi-durable harness：每人一份 SQLite durable 会话、19 工具、只读子代理、ask_user 人机协作、回合内存草稿 + 提交钩子、改动清单 + rewind 撤销），旧的 understanding→editOps 确定性编辑链已下线；
>   ③ 新增**行前体检**（Pass1 确定性审计 → 决策卡 → 实时核验 → Pass2 确定性重排）；
>   ④ 天地图整体下线，数据源收敛为**高德单源**；图片体系收敛为**高德 POI 单源**（四层图库 + 审图队列删除）；
>   ⑤ 高德配额默认**只计量不拦截**（`AMAP_QUOTA_ENFORCE=false`，测试环境口径）；Agent 无灰度开关，无条件启用。
>   ⑥ 生成前端取消独立进度页，`/agent/:jobId` 直接进编辑器直播模式（`plan_day` 逐日长出行程）。

---

## 1. 技术选型总览

| 层 | 选型 | 理由 |
|---|---|---|
| 仓库形态 | npm workspaces monorepo：`apps/web` + `apps/server` + `packages/shared` | 前后端共享领域类型与 TypeBox schema，杜绝双份定义漂移 |
| 前端 | React 19 + TypeScript + Vite + react-router-dom | 多页面 SPA；路由级分包、地图按需加载 |
| **样式** | **Tailwind CSS 4，统一入口 tailwind.css，关闭 preflight** | 全站 JSX 工具类；语义色集中在 `@theme` |
| 状态 | @tanstack/react-query（服务端状态）+ zustand（编辑器交互态） | 分治 |
| **API 层** | **Fastify + `@fastify/type-provider-typebox`** | TypeBox 即 JSON Schema，校验零胶水 |
| **数据库** | **PostgreSQL 16 + pgvector + Drizzle ORM** | 业务数据 + 向量同库；理由见 §4.3 |
| **Agent 会话存储** | **pi-durable（每人一份 SQLite，`data/agent-runs/<userId>.sqlite`）** | 对话、子代理与生成任务共用一份存储：崩溃恢复 `resume()`、上下文压缩、transcript 持久化；单实例部署假设（一个存储只能被一个进程打开） |
| **Agent 运行时** | **`@earendil-works/pi-agent-core` / `pi-ai` / `pi-durable` 1.5**（原 badlogic/pi-mono 生态） | 生成三 Agent 与详情 harness 共用同一循环底座；harness 设计对照 `~/Desktop/work/harness`（pi/openclaw/zcode/opencode/dsh） |
| 认证 | 自实现：bcryptjs + 会话表 + httpOnly Cookie | 需求简单；会话表支持吊销 |
| **数据源** | **高德 Web 服务单源**（POI text/around/polygon + geocode + 路径规划）+ Web 搜索（LangSearch）+ 和风天气 | 天地图已于 11-05 下线；图片收敛为高德 POI photos 单源 |
| 地图前端 | Leaflet + 高德栅格瓦片（配 `AMAP_JS_KEY` 可切 JS API 渲染） | 与库内 GCJ-02 同系 |
| **部署** | **Docker Compose（`app` + `pgvector/pg16` db），宿主机前置反代**；本地开发用 **Doppler 注入环境**（`npm run dev:doppler`） | 站长低成本自托管 |
| CI | GitHub Actions：typecheck + build + eval 离线回归 + 部署栈冒烟 | 开源基础卫生 |

**明确不引入**：NestJS、Prisma、Redis/队列、图表库、UI 组件库、CSS-in-JS、zod、K8s/水平扩展。

---

## 2. 系统分层架构

```
┌── 浏览器（手机/微信内置浏览器为一等目标） ─────────────────────┐
│  React SPA：首页(地图+自然语言) · 生成直播编辑器(/agent/:jobId)  │
│  · 行程编辑器(对话 Agent + 体检 + 地图 + 历史) · 我的行程 · 导出  │
└───────────────┬───────────────────────────────────────────┘
                │ HTTPS(宿主反代) · JSON API + SSE · httpOnly Cookie
┌───────────────▼───────────────────────────────────────────┐
│  API 路由层（Fastify）                                       │
│   /api/auth · settings · usage · trips(含 health-check/*)   │
│   · conversations(含 questions/* HITL) · generations        │
│   · destinations · /api/chat/parse-prompt                    │
├───────────────────────────────────────────────────────────┤
│  Agent 层（统一循环底座 pi-agent-core / pi-ai / pi-durable）  │
│   【生成】orchestrator：①调研 Agent → ②规划 Agent            │
│     （list_areas→search_area_places→plan_day→validate→submit）│
│     → ③文案 Agent；之后确定性校准层（见 §5.1）                 │
│   【详情对话】读写主 Agent harness（19 工具 + spawn_subagents │
│     只读子代理 + ask_user HITL + 回合草稿提交钩子）            │
│   【体检】Pass1 确定性审计 → 决策卡 → 实时核验 → Pass2 重排     │
├───────────────────────────────────────────────────────────┤
│  数据层：PostgreSQL 16 + pgvector（业务表 + 知识库 + 体检会话） │
│          pi-durable SQLite（Agent transcript，每人一份）       │
│  外部：LLM 端点(站点/BYOK) · 高德 · LangSearch · 和风天气       │
└───────────────────────────────────────────────────────────┘
```

**关键原则**：
- **一切结果经 Agent harness 产出**——生成、对话改稿、体检修复都是「模型决策 + 工具执行」；代码保留的是**校准与验证**（顺路排序、时刻推演、真实路线、可行性引擎、远郊修复），不与模型抢决策，只给模型工具和事后兜底。
- 前端只与 API 层对话；Key 只在服务端解密使用。
- **写操作一律走「回合内存草稿 → 提交钩子」**：模型改的是 `tripDraft` 内存副本，回合结束经 `commitOperation` 幂等事务落**一个新版本**（版本链），绝不半成品落库。
- 测试环境口径：高德数据源额度**只计量不拦截**（`AMAP_QUOTA_ENFORCE=false`）；Agent 无灰度开关。

---

## 3. Monorepo 结构（关键部分）

```
├─ package.json                        # workspaces + eval scripts
├─ packages/shared/src/                # 领域 schema/纯函数（可行性引擎、legs、openHours、chat 契约）
├─ apps/server/src/
│  ├─ chat/agent/                      # ★ 详情 Agent harness
│  │  ├─ runtime.ts                    #   pi-durable Harness 适配（每人一份 SQLite、watch→SSE、resume、并发锁）
│  │  ├─ turn.ts                       #   回合装配（工具组/事件→steps/parts 映射/提交事务）
│  │  ├─ tools.ts · writeTools.ts      #   19 工具（读5+片区/美食/HITL/brief/生成 + 9 写）
│  │  ├─ tripDraft.ts                  #   回合内存草稿（写工具唯一作用域）
│  │  ├─ subagent.ts · toolPolicy.ts   #   spawn_subagents（只读白名单、深度1、结构化 JSON 产出）
│  │  ├─ humanInLoop.ts                #   ask_user 阻塞语义（pending Map、120s 超时、answer 回注）
│  │  ├─ placePoints.ts                #   本回合可信点位/图片缓存（写工具零解析复用）
│  │  └─ overviewSync.ts · turnState.ts
│  ├─ generation/
│  │  ├─ orchestrator.ts               # 生成三阶段编排 + 确定性校准层
│  │  ├─ planner/                      # ★ 规划 Agent（prompt/tools/validator，6 工具）
│  │  ├─ scheduling/dayPlanner.ts      #   时距推演引擎（到达/离开时刻、餐次窗、收工线）
│  │  ├─ mealPlanning.ts · mealEnrichment.ts  # 补餐兜底 + 锚点换真实餐厅
│  │  ├─ geoPipeline.ts · geoSanity.ts · routeCoherence.ts · longHaulFixer.ts
│  │  └─ scheduling/schedule.ts        # 旧确定性排程（仅剩「对话加天」消费，待迁移）
│  ├─ services/
│  │  ├─ healthCheckService.ts · healthAudit.ts · healthVerifyService.ts · healthRepairService.ts  # ★ 行前体检
│  │  ├─ geofenceImport.ts             # 景区面状子点导入口径（classifySubPoi 三方共用）
│  │  └─ tripService.ts · tripHistoryService.ts · detailChatService.ts · quotaService.ts
│  ├─ integrations/amap/               # poiSource · geocoder · route · poiPhotos · placeArea(周边/多边形)
│  ├─ integrations/qweather/ · websearch/ · embedding.ts
│  └─ db/ · auth/ · routes/ · lib/
└─ apps/web/src/                       # 直播编辑器(/agent/:jobId) · ChatPanel+AgentActivity+QuestionCard
                                       # · HealthCheckSheet · LiveAgentStream · editorStore
```

---

## 4. 数据模型

### 4.1 存储分工（v0.7 新增）

| 存储 | 内容 | 理由 |
|---|---|---|
| PostgreSQL（Drizzle） | 业务表 + 知识库 + 体检会话 + `agent_conversations` 绑定 | 可查询、可删、事务一致 |
| pi-durable SQLite（每人一份） | Agent transcript、run、工具调用、压缩摘要 | durable 会话/续跑是 harness 核心能力；「先提交再展示」顺序由 pi-durable 保证 |
| `data/media` / 对象存储 | 图片（高德 POI photos 回写索引、分享海报） | 内容寻址，`MEDIA_BASE_URL` 换 CDN 不动库 |

### 4.2 业务表（PostgreSQL，v0.7 现状）

| 表 | 要点 |
|---|---|
| `users` / `sessions` / `user_settings` | 认证与 BYOK 凭据（AES-256-GCM） |
| `trips` | **版本链**：root_id/version/parent_id/change_summary + data JSONB（全量 Trip 唯一事实源）；rewind 删除目标版本之后的链 |
| `conversations` / `chat_messages` | 会话与消息；assistant 消息 attachment 携带 `steps/parts/questions/edit{version,previousTripId,outcomes}`（改动清单持久化） |
| `agent_conversations` | 业务会话 ↔ pi-durable conversation 绑定 |
| `detail_operations` | 操作幂等（fingerprint + 断线重试回放） |
| `generations` | 生成审计（tokens/各源调用数/used_byok）——配额计数来源（见 §6 配额口径） |
| `canonical_places` / `research_evidence` | 已验证地点池（**新增围栏列**：`parent_id/geom_kind/area_polygon/area_radius_m/center_*/junk/dedupe_key`）+ 社区语料 + pgvector embedding |
| `trip_health_checks` | 体检会话（findings/decisions/result，版本绑定过期） |
| `amap_service_usage` | 高德按服务记账（**只计量，`AMAP_QUOTA_ENFORCE=false` 时不拦截**） |

### 4.3 pgvector 选型（09-18 决策，仍有效）

向量与业务同行同事务、SQL 混合过滤是刚需、万级语料无需专用库/索引；四级静默降级（扩展缺失→关键词、EMBEDDING_* 未配→跳过、HTTP 失败→单批 null、retrieveContext 异常→空数组）。完整决策记录见 git 历史 v0.6 版本文档。

### 4.4 知识检索（现状）

`retrieveContext`（placeRetrieval + retrievalRanking）为生成调研与 Agent 工具提供已验证候选：关键词 SQL（≤256 行）+ 按需 pgvector 语义补充（≤48），实体归并 + 地理格子多样性 + 证据挂载（每实体 ≤3 条，direct/risk_only/weak 分级）。Agent 的 `search_places`/`search_area_places` 命中的高德坐标进**本回合点位缓存**，写工具优先复用（零重复解析）。

---

## 5. Agent 体系（v0.7 核心）

### 5.1 生成：调研 Agent → 规划 Agent → 确定性校准层

```
① 调研 Agent：预取知识库候选 → 模型筛选/写简介（submit_research 提交协议）→ 候选池 + 坐标
② 规划 Agent（generation/planner/，maxTurns 24，submit_plan 提交协议）：
   list_areas（2.5km 单链聚片区）→ search_area_places（高德周边/多边形，classifySubPoi 过滤设施点）
   → plan_day（模型只给地名顺序；工具侧 optimizeRouteOrder 顺路重排 + dayPlanner 推演时刻/闭馆，
     闭馆冲突直接报错退回换点）→ validate_plan（PLAN_POLICY：景点数/段距 p50p90/重复坐标/跨度）
   → submit_plan；每天排完发 SSE plan_day（前端直播逐日长出）
③ 文案 Agent（update_titles 单工具）与地理增强并发
确定性校准层（Agent 之后，全部代码）：
   geocodeAll（geoSanity 出口校验）→ meal_repair（仅美食导向）→ meal_enrich（锚点换真实餐厅）
   → computeLegs（真实路线，熔断+启发式降级）→ feasibility → repair_long_haul（远郊混排修复，
   单步验证递减才采纳）→ optimize_cross_day_grouping → applyDraftTimings（真实 legs 后再校准时刻）
   → 闭馆硬检（不过即 GenerationFailure）
```

**纪律**：模型不自己算距离/时间（工具算）；候选坐标优先本回合缓存与知识库；「模型提交 → 代码验证 → 不过退回」的循环贯穿全程。模型产出的活动类别目前统一为「文化」，靠补餐链补「美食」（已知简化）。

### 5.2 详情对话：单一读写主 Agent harness

- **运行时**（`chat/agent/runtime.ts`）：每人一份 SQLite（`storagePathFor`），每会话一个 durable conversation；`watch()` → SSE；关停/崩溃后 `resume()` 续跑；pi-durable 按阈值自动压缩上下文（工具结果**不截断**——没有可读文件工具，截断即丢数据）。
- **并发保护**：同一用户同时只允许一个回合，第二个请求 409 `AGENT_BUSY`；停止/超时中断 durable 运行并释放锁。
- **19 工具**：读 `get_trip/get_day/search_places/search_area_places/web_search/get_weather/search_food`；交互 `ask_user`；状态 `update_brief/start_generation`；写 `add_activity/update_activity/delete_activity/move_activity/reorder_day/add_day/update_day/delete_day/update_trip`。写工具只改回合内存草稿（校验语义对齐旧编辑链：id 双锚、每天上限、名称去重 + allowRevisit、改名须 ≤50km 锚点校验）。
- **子代理**（`spawn_subagents`）：≤3 个只读探索子代理并行（白名单 5 读工具、深度恒 1、父会话+槽位复用），产出结构化 JSON（places/notes），坐标进本回合缓存。
- **HITL**（`ask_user`）：工具内 await + 独立 answer 接口回注，同一 run 内 resolve；同会话单 pending、120s 超时、`GET pending` 刷新恢复；问答记录随消息持久化并回放到真实位置。
- **提交钩子**：回合结束 `draft.changed()` → overview 补齐（新活动进候选池，缺封面走高德图）→ `repairChangedRoutes` 重算动线 → `commitOperation` 事务（`assertLatestTrip` 乐观锁 + 配额复查）→ **一回合一个新版本**，改动清单随消息落库。
- **撤销**：前端「撤销这次修改」= `rewindTrip`（删除目标版本之后的所有版本，目标重新成为当前版）；`/restore`（复制式恢复）保留但非主路径。历史面板「回到此版本」同走 rewind。

### 5.3 行前体检（`services/healthCheck*`，入口：编辑器工具栏）

```
Pass 1a 确定性审计（零 LLM）：simulateTrip 全量 feasibility 违规 + 远郊混排补报 → 结构化 HealthFinding
Pass 1b 实时核验（按需）：高德最新营业时间 / web_search 预约政策 / 和风天气窗口，15s 超时，查不到如实说
决策卡：每条 Finding 一张卡（建议动作 + accept/self_handle/skip + 一键全按建议），落库 trip_health_checks
Pass 2 确定性重排（零 LLM）：accept → 挪/删 → 重验 hard 违规严格递减否则单步回滚 → repairChangedRoutes
   → 新版本（changeSummary「体检修复：…」）
```

与对话共享 `commitOperation`/版本链/路线重算链路；体检绑定 trip 版本，旧版本自动过期。

### 5.4 Key 双轨解析（保留）

BYOK（用户自带 LLM Key，AES-256-GCM 加密存储，baseUrl 保存+使用双过 SSRF）→ 站点 Key → 无配置报错；`used_byok` 落审计表。个人高德 Key 同样双轨（个人 → 站点 → Null 降级）。

---

## 6. 数据源与配额口径（v0.7 现状）

- **高德单源**（11-05 天地下线）：POI 文本/周边/多边形检索（v5）、geocode（v3）、路径规划（v5 walk/drive/transit）、POI photos。按服务分项记账（`amap_service_usage`，UTC+8 日界）。
- **配额口径：只计量不拦截（2026-11-06 起，测试环境）**。`AMAP_QUOTA_ENFORCE=false`（默认）时 `budgetRemaining()` 返回 Infinity，预检不会把链路降级 Null 源；超额每服务每天记一条 `over_budget`。置 `true` 恢复硬闸门。**实际消耗只受高德账户自身月配额与 QPS 约束**——开源部署者若需闸门必须显式开启 enforce。
- **图片单源**（81e8b3f）：景点图只来自高德 POI photos（名字闸门 + 类型白名单 + 24h 缓存 + 库内回写「同一地点终身只花一次配额」）；四层图库（pexels/unsplash/pixabay/wikimedia + 审图队列）已删除。单任务上限 `AMAP_PHOTO_MAX_PER_TASK`（默认 40）。
- **Web 搜索**（LangSearch，博查同族可切）：承担攻略/预约政策语义检索；Agent 轮级预算 `CHAT_WEB_BUDGET`（默认 4）、POI 检索 `CHAT_POI_BUDGET`（默认 8）。
- **和风天气**：Ed25519 JWT 现签 / API Key 双模式；城市同名候选按 `type=city` + rank 消歧；15 日预报，城市 24h / 预报 1h 缓存。
- **降级纪律不变**：某源未配置/故障 → Null 源或启发式，生成与对话**永不因数据源失败而失败**；账本错误例外（必须冒泡，不许伪装成「没查到」）。

---

## 7. API 设计（增量）

响应信封 `{code,message,data}` 不变。v0.7 新增/变化：

| 方法 & 路径 | 说明 |
|---|---|
| `POST /api/chat/parse-prompt` | 首页自然语言意图理解（公开，限流 10/min/IP，8s 超时，异常确定性兜底） |
| `POST /api/conversations/:id/messages/stream` | 详情 Agent 主通道（SSE：accepted/progress(+step)/answer_delta(+replace)/question*/recommendations/edit_result/done/error） |
| `GET/POST /api/conversations/:id/questions/*` | HITL 问题 pending 查询与回答回注 |
| `POST /api/trips/:id/rewind` | 撤销到历史版本（删除其后版本） |
| `POST /api/trips/:id/health-check` · `GET .../latest` · `POST .../findings/:fid/verify`（10/min）· `POST .../decisions` | 体检四端点 |
| `GET /api/generations/:jobId/projection` | 统一投影快照/补帧（客户端携 `fromSeq` 重订阅） |
| `GET /api/generations/:jobId/projection/events` | 生成投影 SSE（row/state delta，不再有独立事件环形缓冲） |

---

## 8. 前端架构要点

- 路由：`/` `/trips` `/trips/new` `/trips/:id` `/agent/:jobId`（直播编辑器）`/login` `/register`；未登录守卫。
- **生成直播（11-06）**：`/agent/:jobId` 与 `/trips/:id` 复用同一编辑器工作区；直播期 SSE 合成只读行程（`plan_day` 逐日替换），AI 栏 `LiveAgentStream` 播报阶段/工具/候选；完成后原地切 `/trips/:id`。旧独立生成页已删除。
- **对话 UI**：`ChatPanel` + `PendingAnswer`（parts 交错渲染 text/steps/question）+ `AgentActivity`（工具步骤）+ `QuestionCard`（HITL 问题卡）；改动清单卡片带「撤销这次修改」（rewind）。
- **体检 UI**：工具栏「体检」按钮 + `HealthCheckSheet`（决策卡列表 / 实时核验 / 硬冲突全按建议改）；直播模式下禁用。
- 样式双轨与移动端基准（<768px 先行设计）沿用 09-26 规范：语义色只取 `@theme` token，数据驱动值用内联 style。

## 9. 安全设计

| 项 | 方案 |
|---|---|
| 密码 / 会话 | bcryptjs(cost 12)；256bit token 存 sha256；httpOnly+SameSite=Lax+Secure；30 天滑动续期（trustProxy 已启用，限流按真实客户端 IP） |
| 注册管控 | 三态 open/invite/closed；GitHub 仅信 verified 邮箱绑定 |
| **配额** | 高德数据源：只计量不拦截（`AMAP_QUOTA_ENFORCE`，见 §6）；生成/对话用户日配额（`GEN_DAILY_LIMIT`/`CHAT_DAILY_LIMIT`）仍生效；Agent 单用户单回合 |
| 用户凭据 | AES-256-GCM；API 仅回 last4；BYOK baseUrl 双过 SSRF（`ssrfGuard`，私网/环回/链路本地全拒，`SSRF_ALLOWLIST` 豁免） |
| 越权 | 全量 user_id 谓词；operationId 幂等 + 乐观锁 409 |
| 输入 | 全路由 TypeBox；`ChatText` 白名单渲染（只解析 `**加粗**`）；markerHtml 转义；外链 noopener |

## 10. 环境变量（事实来源 = `.env.example`，此处只列 v0.7 关键变化）

| 变量 | 说明 |
|---|---|
| `AMAP_QUOTA_ENFORCE` | 默认 `false`：高德额度只计量不拦截；`true` 恢复硬闸门 |
| `AMAP_LBS/SEARCH_MONTHLY_BUDGET` · `AMAP_{GEOCODE|PLACE|WALK|CYCLE|DRIVE|TRANSIT}_DAILY_BUDGET` | 高德分服务记账口径（enforce 时生效；0=禁用该服务） |
| `AMAP_PHOTO_MAX_PER_TASK` | 景点图查询单任务上限（默认 40） |
| `CHAT_POI_BUDGET` / `CHAT_WEB_BUDGET` | 详情 Agent 单轮 POI/联网检索上限（默认 8/4） |
| `QWEATHER_*` | 和风：专属 API Host + Ed25519 JWT 四件套（推荐）或 API Key；`QWEATHER_DAILY_BUDGET` |
| `IMAGE_API_*`（多中转站 `_2/_3`） | AI 分享海报生图（独立凭据，不复用 LLM Key） |
| `PEXELS/UNSPLASH/PIXABAY_*`、`TIANDITU_*`、`PHOTO_REVIEW_*`、`AGENT_*` | **已删除**（图片单源、天地图下线、Agent 无开关） |
| 本地开发 | `npm run dev:doppler`（Doppler 注入）；`npm run secrets:sync` 拉取密钥 |

## 11. 风险与后备（v0.7 增量）

| # | 风险 | 缓解 |
|---|---|---|
| R13 | **配额不拦截导致高德月配额被打穿** | 测试环境有意为之；生产前置 `AMAP_QUOTA_ENFORCE=true`；`over_budget` 日志可观测 |
| R14 | pi-durable 为 experimental（API 变动） | 锁版本 1.5；只用 Harness/watch/compact/tools 四入口；单存储单进程与单实例部署一致 |
| R15 | 双写不一致（durable SQLite vs Postgres 消息） | transcript 以 durable 为准；Postgres 只存展示副本；提交一次性写 |
| R16 | Agent 写错行程 | 版本链 + rewind 一键撤销 + 改动清单可视；hard 违规由校准层兜底 |
| R17 | 多轮 Agent 成本上升 | 测试环境不限；生产需重新引入轮次/配额策略（当前代码位：maxTurns、CHAT_*_BUDGET、GEN/CHAT 日配额） |
| 保留 | R2 模型工具调用弱 · R7 数据源不稳 · R9 SSE 反代缓冲 · R10 pgvector 缺失 · R12 微信兼容 | 降级策略不变 |

## 12. 历史决策存档（v0.2~v0.6 要点，已被上文章节取代或收缩）

- **确定性排程（09-21~11-05）**：曾被列为「最值钱的设计」（纯代码选点/分天/排序，实测 4.7 万 token/432s 的 LLM 排程不可接受）。11-06 起被「规划 Agent + 确定性校准层」取代：选点/分天/时刻交还模型（工具给足事实与验证），代码保留顺路排序、时刻推演、真实路线、可行性、远郊修复。算法细节见 [DETERMINISTIC_SCHEDULING.md](./DETERMINISTIC_SCHEDULING.md)（其 buildSchedule 现仅剩「对话加天」路径，待迁移）。算法文档中的打分公式/闭馆检测/节假日豁免仍是校准层的事实来源。
- **天地图双链（09-25~11-05）**：POI 搜索固定天地图 + 路线/geocode 高德优先。11-05 整体下线，全走高德。历史适配器教训（XML/单位/无骑行端点等实测记录）见 git v0.6 版本文档 §12.1。
- **四层图库体系（~11-04）**：curated/selected/reviewed/审图队列 + pexels/unsplash/pixabay/wikimedia 多源。11-04 收敛为高德 POI photos 单源。
- **小红书语料管线**：离线导入 + RAG 检索仍是知识库地基（`canonical_places`/`research_evidence`），消费方从生成调研扩展到 Agent 工具。
- **pi 0.73 → 1.5 迁移**：详情对话与生成阶段都已迁至 pi-durable harness（`runDurablePhaseAgent`）；旧 `runPhaseAgent` / `agents/runner.ts` 已删除，重试与提交协议由 durable 负责。
