# 织程 TripWeaver · 技术架构文档

- 项目名称：**织程 TripWeaver**（仓库名 `tripweaver`）
- 文档版本：v0.6
- 日期：2026-09-20
- 关联文档：[PRD](./PRD.md) · [开发计划](./DEVELOPMENT_PLAN.md)

> **修订记录**
> - v0.2：纯前端 → 前后端分离（Fastify API + SQLite + 会话认证）；单 Agent → 三 Agent 流水线；新增小红书 MCP 接入层。
> - v0.3：面向「开源 + 站长运营 + 非 IT 用户」——① LLM Key 双轨解析（站点 Key / BYOK）；② 邀请码 + 配额体系（新增 `generations` 用量表）；③ SSRF 私网黑名单升为强制；④ 小红书定为站长专用小号单账号模式；⑤ 新增开源工程与部署章节（Docker Compose / CI）。
> - v0.4：小红书抓取风控不可持续，**彻底移除该集成**——调研数据源替换为「高德搜索POI 2.0（结构化底座）+ Web 搜索 API（攻略语义层，默认 LangSearch）」双层方案 + 预约种子表；调研产物升级为结构化候选池（`Trip.overview`），SSE 新增 `candidate` 事件；`generations` 用量列泛化（`amap_calls`/`search_calls`）。
> - **v0.5**：**坐标决策反转**——Nominatim 在中国的 POI 级覆盖实测不可用，且 WGS-84 与高德 GCJ-02 混用不可行；行程坐标全面切换高德 GCJ-02（活动新增可选 `coordSystem`，缺省 wgs84 兼容旧数据）。新增高德地理编码/路径规划适配器与活动间通勤段 `TripDay.legs`（walk/transit/drive，`source=amap|heuristic`）；坐标解析与通勤估算移出 LLM 循环，改为审校后确定性后处理 pass（解析链：高德 POI text → v3 geocode → Nominatim+wgs84ToGcj02 → estimated 降级）。协议 3.5 缓解措施：只存活动坐标点值与通勤时长/距离数值、polyline 抽稀且 ≤4000 字符、不批量囤 POI、24h TTL 缓存、图片热链不转存不变。
> - **v0.6（本版）**：**RAG 检索链路成文**——补 §4.4（`retrieveContext` 混合召回三层结构、两处注入入口、embedding 客户端参数、离线数据脚本、四级降级链、明确不做项）；同步修正 PostgreSQL 迁移后的文档残留（§1 地图坐标、§2 架构图、§10 部署与环境变量、§11 R10）。

---

## 1. 技术选型总览

| 层 | 选型 | 理由 |
|---|---|---|
| 仓库形态 | npm workspaces monorepo：`apps/web` + `apps/server` + `packages/shared` | 前后端共享领域类型与 TypeBox schema，杜绝双份定义漂移 |
| 前端 | React 18 + TypeScript + Vite + react-router-dom | 多页面 SPA；生态与 react-leaflet 匹配 |
| **样式** | **Tailwind CSS 4，统一入口 tailwind.css，关闭 preflight** | 全站页面使用 JSX 工具类；语义色、基础默认值、字体和关键帧集中在 Tailwind 入口，无旧页面例外（2026-09-29） |
| 状态 | @tanstack/react-query（服务端状态）+ zustand（编辑器交互态，不持久化） | 两类状态生命周期不同，分治 |
| **API 层** | **Fastify + `@fastify/type-provider-typebox`** | TypeBox 即 JSON Schema，shared schema 直接挂路由，校验零胶水 |
| **数据库** | **PostgreSQL 16 + pgvector + Drizzle ORM（node-postgres）** | 多实例部署 + JSONB 查询；pgvector 扩展让 RAG 向量检索与业务数据同库（09-18 自 SQLite 迁入，理由见 §4.3） |
| 认证 | 自实现：bcryptjs + 会话表 + httpOnly Cookie + **邀请码** | 需求简单；会话表支持吊销 |
| **LLM 调用层** | **`@mariozechner/pi-ai`**（服务端） | 统一多厂商；自定义 Model 适配任意 OpenAI 兼容端点 |
| **Agent 运行时** | **`@mariozechner/pi-agent-core`**（服务端） | 工具执行 + 事件流 + 循环控制，三 Agent 复用 |
| **调研数据源** | 高德搜索POI 2.0 + Web 搜索 API（LangSearch，博查同族可切换）—— HTTP 直连 | 免费额度内近零成本；官方 API 无风控包袱；适配器隔离 + Null 降级 |
| 地理编码 / 地图 | 高德 GCJ-02 主链（POI text → v3 geocode）+ OSM Nominatim 兜底（经 `wgs84ToGcj02` 转换）/ Leaflet + react-leaflet | 主链覆盖中国 POI；行程坐标统一 GCJ-02（v0.5 反转原 WGS-84 决策，活动 `coordSystem` 缺省 wgs84 兼容旧数据，见 §12.1） |
| 长图 / 弹层 | html-to-image / 原生 `<dialog>` | 轻量 |
| **部署** | **Docker Compose（`app` + `pgvector/pg16` db），宿主机前置反代** | 站长 30 分钟内可用（PRD 成功标准 2）；复用站长现有证书体系（`nginx.host.conf`）；容器化内置反代场景见 `docker-compose.release.yml` |
| CI | GitHub Actions：typecheck + build | 开源项目基础卫生 |

**明确不引入**：NestJS、Prisma、Redis/队列、图表库、@dnd-kit、UI 组件库、CSS Modules、CSS-in-JS、zod、K8s/水平扩展。

> ⚠️ 版本匹配：`react-leaflet@5.x` 要求 React 19（`npm ls react` 为准）；自建 PostgreSQL 需装 `pgvector` 扩展（compose 已用 `pgvector/pgvector:pg16`；本地 PG 缺扩展时向量层静默降级，见 §4.4）。

---

## 2. 系统分层架构

```
┌── 浏览器（手机/微信内置浏览器为一等目标） ────────────────────┐
│  React SPA：登录注册(邀请码) · 我的行程 · 规划表单 ·           │
│  生成进度页(SSE) · 行程编辑器(清单+地图+预算) · 导出           │
└───────────────┬──────────────────────────────────────────┘
                │ HTTPS(宿主反代) · JSON API + SSE · httpOnly Cookie
┌───────────────▼──────────────────────────────────────────┐
│  API 路由层（Fastify）                                     │
│   /api/auth/*(邀请码) · /api/settings · /api/usage         │
│   /api/trips/* · /api/generations/*(配额检查/SSE/取消)      │
│   TypeBox 校验 · 会话守卫 · 限流 · 数据隔离                  │
├──────────────────────────────────────────────────────────┤
│  服务层                                                    │
│   Auth · Trip · Settings(Key加解密) · Quota(配额/用量)       │
│   GenerationJobManager(内存任务表+事件环形缓冲→SSE 重放)      │
├──────────────────────────────────────────────────────────┤
│  Agent 模型层（pi-agent-core / pi-ai）                      │
│   Orchestrator（代码级流水线 research → plan → review）  │
│     ①调研 Agent ─▶ 地点搜索(天地图) / Web 搜索源         │
│     ②确定性排程 ─▶ 纯代码选点/排日/通勤（不走模型）      │
│     ③审校+撰写  ─▶ DraftTrip / 知识库证据 / 专属建议     │
│     ④检索层 retrieveContext ─▶ pgvector 混合召回（09-19）      │
│   （Key 双轨解析：用户 BYOK → 站点 Key）                      │
├──────────────────────────────────────────────────────────┤
│  数据层：PostgreSQL 16 + pgvector（users/sessions/            │
│           user_settings/trips/generations/                   │
│           canonical_places / research_evidence）             │
   外部：站点或用户的 LLM 端点 · 高德 Web 服务 · LangSearch ·
         OSM(瓦片/Nominatim)
```

**关键原则**：前端只与 API 层对话；Key 只在服务端解密使用；Agent 产出经工具写入内存 `DraftTrip` 与候选池，审校通过才一次性入库；**站长的钱包与数据源额度由「注册管控 + 双层配额 + 限速缓存」三道闸保护**。

---

## 3. Monorepo 结构

```
travel-planner/
├─ docs/                              # 三份文档
├─ docker-compose.yml · nginx.host.conf · .env.example
├─ .github/workflows/ci.yml           # typecheck + build
├─ LICENSE (MIT) · README.md
├─ package.json                       # workspaces: apps/*, packages/*
├─ packages/shared/src/
│  ├─ types.ts / schemas.ts / constants.ts
├─ apps/server/src/
│  ├─ index.ts · env.ts               # env 校验（见 §10 环境变量表）
│  ├─ db/ schema.ts · client.ts · migrate.ts
│  ├─ auth/ password.ts · session.ts · guard.ts · invite.ts
│  ├─ crypto/ secretBox.ts            # AES-256-GCM
│  ├─ routes/ auth.ts · settings.ts · trips.ts · generations.ts · usage.ts
│  ├─ services/ tripService.ts · settingsService.ts · quotaService.ts
│  ├─ data/ reservationSeeds.json(.ts)   # 预约种子表（~50 条热门需预约景点）
│  ├─ generation/
│  │  ├─ jobManager.ts · orchestrator.ts · draft.ts
│  │  ├─ agents/ runner.ts
│  │  ├─ tools/ researchTools.ts · geoTools.ts · draftTools.ts · reviewTools.ts
│  │  ├─ model.ts                     # Key 双轨解析 + buildModel
│  │  └─ prompts.ts
│  ├─ integrations/
│  │  ├─ amap/ poiSource.ts           # 高德搜索POI 2.0 适配 + Null 降级
│  │  ├─ websearch/ searchSource.ts   # LangSearch(博查同族) 适配 + Null 降级
│  │  ├─ geocode.ts                   # Nominatim 限流+缓存
│  │  └─ ssrfGuard.ts                 # v0.3：baseUrl 私网黑名单
│  └─ lib/ serialQueue.ts · ttlCache.ts · proxy.ts
└─ apps/web/src/
   ├─ main.tsx · App.tsx · router.tsx
   ├─ api/ client.ts · hooks.ts
   ├─ pages/ Login · Register(邀请码) · TripList · Planner(表单+进度) · TripEditor
   ├─ store/ editorStore.ts
   ├─ components/ …（v0.2 组件族沿用；SettingsDialog 分级：普通视图+高级折叠区）
   └─ styles/ tailwind.css
```

---

## 4. 数据模型

### 4.1 领域类型（`packages/shared`）

同 v0.2 基础上（Activity 含 `coordSource`/`sourceNotes`，Trip 含 `title`/`meta{usedXhs, reviewNotes}`），v0.4 新增：`ResearchPoi{id, name, category(attraction|food|hotel), coverUrl?, intro, reservation(required|none|unknown), reservationNote?, sourceLinks}`；`Trip.overview?: ResearchPoi[]`（≤40，调研候选池）；`TripMeta.dataSources?: ('amap'|'websearch')[]`（实际用到的数据源）。全部为可选字段，旧行程 JSON 原样可读；`usedXhs` 仅作旧数据只读兼容，新生成恒 `false`。JSON 导出 `{ version: 2, trip }`。

**v0.5 ST3（OTA 场景降级）增量**（均为可选字段，旧行程/导入导出 v2 完全兼容）：

- `Trip.transportMode?: 'transit'|'drive'|'walk'`（出行方式基调，缺省 transit；`GenerateForm.transportMode?` 同构。geoPipeline 通勤段 >1.5km 按基调选 mode，<1.5km 恒 walk）。
- `Lodging{name(≤60), area?, lat?, lng?, coordSystem?}`：`Trip.lodging?`（整程默认）+ `TripDay.lodging?`（day 级覆盖，多城市场景）。住宿仅是**通勤锚点**，不做酒店推荐/比价/预订；用户留空时规划 Agent 经 `set_lodging` 建议一个区域（禁止具体酒店与价格）。坐标由 geoPipeline 同一解析链补全（计入 GEOCODE_MAX_PER_TASK），成功才生成住宿 leg；编辑器改名即清空坐标并丢弃相关住宿 leg。
- **TransitLeg 哨兵契约**：`fromActivityId`/`toActivityId` 允许哨兵值 `'lodging'`（leg 挂在 day 上，作用域限当天）——`{from:'lodging', to:首活动id}` 与 `{from:末活动id, to:'lodging'}`；前端经 `lodgingLegsForDay(day)` 严格 id 匹配，失配（重排/删改）静默丢弃。
- `Activity.cost` 必填 → **可选**（粗估档位值：免费=0，不确定缺省；旧数据带值照读，读取方 `?? 0` 兜底）。派生 `BudgetSummary` 改区间 `{perPersonPerDayMin, perPersonPerDayMax, coveredDays}`（日成本=当天 cost 求和÷partySize，区间=[0.8×,1.3×] 十位取整），删除精确总额与 `overBudget` 超支判定；`trips.total_cost` 冗余列保留（列表页「约 ¥」展示）。

### 4.2 数据库表（Drizzle / PostgreSQL）

| 表 | 字段要点 |
|---|---|
| `users` | id · email(unique) · password_hash · created_at |
| `sessions` | id · user_id(FK) · token_hash(unique) · expires_at |
| `user_settings` | user_id(PK/FK) · **byok_enabled(bool)** · base_url · api_key_ciphertext · api_key_last4 · model · **amap_api_key_ciphertext · amap_api_key_last4 · amap_key_revision** · **search_api_key_ciphertext · search_api_key_last4 · search_api_base_url · search_credential_revision** · updated_at |
| `trips` | id · user_id(FK+索引) · title · destination · days_count · activity_count · total_cost · used_xhs · data(**JSONB**) · created_at · updated_at |
| `generations` | id · user_id(FK+索引) · trip_id(可空 FK) · status(done/error/cancelled) · used_xhs(旧数据) · used_byok · tokens_in · tokens_out · xhs_calls(旧数据) · **amap_calls · tianditu_calls（v0.6 拆分） · search_calls（v0.4）** · created_at —— **配额计数与用量核算的事实来源** |
| `canonical_places` | id · city · name · category · lng/lat · source(goldset/xhs/amap/manual) · **verified** · payload(JSONB) · **embedding vector(1024) 可空** —— 已验证地点池，金集 9 城 POI 资产化（RAG 地基，09-18） |
| `research_evidence` | id · place_id(可空 FK) · city · kind · content · source_url · fetched_at · **embedding vector(1024) 可空** —— 调研语料（小红书口碑/价格/预约/避坑），挂载到地点池 |

配额查询即 `count(generations where user_id=? and status='done' and created_at>=今日零点)`——无需独立计数器表（KISS，且天然免「重置」逻辑）。

### 4.3 向量检索选型：pgvector 而非独立向量数据库（09-18）

**决策**：RAG 的向量与业务数据存同一个 PostgreSQL（pgvector 扩展），**不引入** Qdrant/Milvus/Pinecone 等独立向量数据库。

**存储模型**：向量不是独立数据集，而是已有行的派生列——`canonical_places.embedding` / `research_evidence.embedding` 与原文、verified、city 等业务列**同一行、同事务写入**。一条 SQL 同时完成语义召回与结构化过滤：

```sql
SELECT ... FROM research_evidence
WHERE verified_place AND city = $1 AND kind IN ('xhs_warning','xhs_reservation')
ORDER BY embedding <=> $query_vec LIMIT 8
```

**理由**：

1. **规模不匹配专用库**：全量语料为万级（当前 ~1.7k 行），pgvector 在百万级内与专用向量库无实质性能差距；<1000 行时顺序扫描已足够，连 ivfflat/hnsw 索引都暂不建（YAGNI）。
2. **混合过滤是刚需**：本项目检索永远附带 `verified=true`、`city=X`、`kind IN (...)` 等 SQL 谓词。pgvector 原生表达；专用向量库需两次查询 + 应用层合并，或依赖其私有过滤语法。
3. **数据一致性**：独立向量库意味着「向量库存 (id, vector)，PG 存原文」的双写架构——多一次网络往返，且需自行保证两套存储的一致性。pgvector 下向量列与事实列天然同事务。
4. **部署哲学**：开源自部署定位下，compose 多一个向量库服务 = 部署门槛 +1；pgvector 只是把镜像从 `postgres:16` 换成 `pgvector/pgvector:pg16`，零新增组件。
5. **可演进**：若未来数据量破百万或检索 QPS 过百，`canonical_places`/`research_evidence` 作为一等公民表可直接导出迁移，pgvector 层不构成锁定。

**明确不引入**：独立向量数据库服务、向量索引（数据量达标前）、Repository 抽象层。

**降级链**：pgvector 扩展不可用 → 启动告警不阻断，retrieveContext 退化为纯关键词召回；EMBEDDING_* 未配置 → 跳过向量生成与向量层检索；embedding HTTP 失败 → 单批置 null 继续。

### 4.4 SQL 优先的调研检索（2026-10-02）

**定位**：为调研提供已验证候选与证据。编排由确定性排程承担；模型筛选候选、写简介，标题阶段常规一次 `update_titles` 自动结束。

**实现**：`retrieveContext.ts` 连接应用依赖；`placeRetrieval.ts` 执行参数化 SQL；`retrievalRanking.ts` 负责有界候选排序与实体归并；`researchContext.ts` 预取并渲染首轮上下文。

1. **SQL 召回**：始终过滤 verified 和目的地，可按类别限制。名称、别名、前缀、主题及结构化类别匹配先取最多 256 行，再按精确命中、推荐分、主景点和适度空间多样性选取。泛称别名与父子景点不会互相串用事实。
2. **按需语义补充**：普通查询在归并后足量时跳过向量；复杂偏好允许显式 semantic 补查。向量查询同样限制城市、verified 和类别。语义相似不代表满足无障碍、不拥挤等硬条件。
3. **证据挂载**：按实体成员 ID 查询，每个地点最多 3 条，SQL LATERAL 内限制返回行数。按避坑、预约、价格、其他，以及 direct/risk_only/weak 与新鲜度排序；提示保留证据强度，来源 URL 在任务 catalog 内保留并在入池时自动附上。
4. **批量调研提交**：预取足量时一次 `submit_research(candidates: [{placeId, intro}], summary?)` 写入已知地点并结束；程序复用名称、类别、预约、来源、坐标与照片，仍逐条发候选 SSE。整批先校验、同名去重、可取消；外部地点沿用 `add_candidate` 降级。调研优先复用上游完整介绍（通常120～180字，上限200字），仅补齐缺失内容；日期/路线由排程处理。上游负责来源提纯及别名/组成实体归一；行程端不按关键词删句。组成地点政策保留在 `components`，导入为旧行写 `canonicalRedirectTo` 后检索排除重复候选。

生成阶段的原生 DeepSeek V4 ID（`deepseek-v4-flash/pro`）通过 SDK 的 DeepSeek 兼容格式显式发送 `thinking: {type: 'disabled'}`；仅写 `reasoning:false` 不会关闭服务端默认思考。其他模型、别名和对话入口沿用原有配置。实际网关是否采纳及提速幅度需真实样本验证，不以模拟端点耗时替代。

**两个调研入口**：生成开始时先按表单预取景点候选，美食偏好才加餐饮候选；模型首轮即可引用 placeId 写入候选池。`search_verified_places(keyword, category?, semantic?)` 只补缺项。已检索候选复用坐标、预约事实与证据，不逐条重查 XHS；没有预取结果时沿用外部搜索与模型知识降级。

**Embedding**：在线 `embedQuery` 单次请求 2.5 秒超时，可取消，无重试/节流，成功结果缓存 10 分钟（最多 256 项）；离线 `embedTexts` 保留 32 条批处理、30 秒超时及重试，300ms 节流仅在批间发生。两者都只使用站点 EMBEDDING_*（可回落 SITE_LLM_*），不使用用户 BYOK，维度固定 1024。

完整边界与验证命令见 `.trellis/spec/server/backend/rag-guidelines.md`。`scripts/benchmark-place-retrieval.mts` 只读当前知识库、不触发迁移或外部模型；其中需要向量的样本不能当成完整 RAG 耗时。

**数据入口（全部离线脚本，非在线写入）**：

| 脚本 | 作用 |
|---|---|
| `seed-canonical-places.ts` | 金集 9 城 POI → `canonical_places`（`verified=true, source='goldset'`） |
| `seed-xhs-places.ts` | 社区地点库导出 JSON → `canonical_places` + `research_evidence`（`source='xhs'`）；同名同 id 撞金集时**不覆盖** |
| `embed-backfill.ts` | 幂等回填两张表的 embedding；`--tables places` 可只跑地点（检索路径取语料一律按 `place_id`，`research_evidence.embedding` 目前无一处被查询，属纯支出） |
| `restore-goldset.ts` | 从 eval 快照修复被社区库导入误改 `source` 的金集记录 |

**降级链（四级，全静默，不抛错）**：

1. pgvector 扩展不可用 → 启动迁移跳过 `embedding` 列，启动告警不阻断。
2. `EMBEDDING_*` 未配置 → 跳过向量层，仅关键词召回。
3. embedding HTTP 失败 → 单批置 `null`，其余批次继续。
4. `retrieveContext` 任何异常 → 返回 `[]`，生成流程不受影响。

**刻意不做（YAGNI，触发重评估的条件见 §4.3）**：chunking（evidence 整条进 prompt）、rerank、查询改写、ivfflat/hnsw 索引、Repository 抽象层、独立向量数据库。

---

## 5. 多 Agent 协作设计

三 Agent 流水线（调研/编排/审校 + 代码级 Orchestrator + ≤2 轮修订循环）、工具集、终止条件、上下文隔离、SSE 事件映射、token 成本控制——**全部沿用 v0.2 §5 设计，此处不重复**。v0.3 仅改动模型解析入口：

### 5.1 Key 双轨解析（`generation/model.ts`）

```
resolveLlmConfig(userId):
  s = user_settings(userId)
  if s.byok_enabled && s 完整:   return { baseUrl: s.base_url, key: 解密(s.api_key), model: s.model, byok: true }
  elif env.SITE_LLM_* 完整:      return { ...站点配置, byok: false }
  else:                          throw NoLlmConfigured  → PRD F1 异常文案
```

- BYOK 的 `base_url` 在**保存时**与**使用时**均过 `ssrfGuard`（§9）；站点 Key 的 baseUrl 来自环境变量，属站长自配，不受黑名单限制（Ollama 内网场景合法）。
- `used_byok` 落入 `generations` 表——BYOK 生成不烧站点 Key，但**计入次数配额**（配额限的是外部数据源调用与服务资源，不只是钱）。

---

## 6. 调研数据源接入层（高德 + Web 搜索，v0.4）

> **⚠️ 本章为 v0.4/v0.5 方案记录，已非现行口径。**
> **2026-09-21 更正**：实测「高德 + Web 搜索」速度慢、内容质量差，已放弃。现行调研链路为 **抓取小红书笔记 → 清洗提纯入库 → RAG 检索召回**（小红书回归主数据源，但改为离线语料 + 向量检索，而非 v0.3 的实时 MCP 抓取）。
> 下文与 §12.1 保留旧方案参数作为历史依据：**§12.1 的高德坐标编码与通勤估算仍在用**（仅调研层的「高德搜索 POI」退役），合规红线（协议 3.4/3.5）仍适用。
> 口径以 [PRD 2026-09-21 注记](./PRD.md) 与 [竞品与差异化分析](./COMPETITIVE_ANALYSIS.md) 为准。**本章待完整同步（另立任务）。**

小红书抓取因风控与账号纪律包袱于 v0.4 移除（ADR 见任务 `07-09-replace-xhs-research-with-amap-web-search-add-trip-overview-page`）。现行方案为「结构化底座 + 攻略语义层」双层数据源，模型知识兜底：

- **高德搜索POI 2.0**（`integrations/amap/poiSource.ts`）：`GET /v5/place/text`，`show_fields=business,photos`，按类目码搜索（景点 110000 / 餐饮 050000 / 住宿 100000）。每次自检或新生成任务按当前用户动态解析“个人加密 Key → 站点 `AMAP_KEY` → Null 源”，不把个人凭据放入全局单例；用户更新或清除后无需重启。返回名称/类型/地址/评分/人均/营业时间/图片热链，**v0.5 起并返回 `location`（GCJ-02）与 `adcode`**——v0.4「不返回坐标」决策已反转（Nominatim 中国 POI 覆盖不可用、坐标系混用不可行），行程活动坐标统一 GCJ-02，Nominatim 仅作兜底并经 `wgs84ToGcj02` 转换。
- **高德地理编码/路径规划**（`integrations/amap/geocoder.ts` · `route.ts`，v0.5）：v3 `geocode/geo` 地名编码 + v5 `direction/{walking,driving,transit/integrated}` 通勤估算（`show_fields=polyline,cost`，折线抽稀 ≤4000 字符否则丢弃）。与 POI 共用 350ms 串行队列 + 24h TTL 缓存；任务级上限 geocode ≤40 / route ≤30，全部计入 `amap_calls` 与 `AMAP_DAILY_BUDGET`；失败/超额/无 Key 静默降级（坐标走 Nominatim 转换、通勤走 `legEstimator` 启发式：haversine×1.4，walk 4.5km/h / transit 20km/h+10min / drive 30km/h+5min）。坐标解析与通勤段生成在审校完成后由 orchestrator 确定性后处理 pass 执行（机械工作移出 LLM 循环）。
- **Web 搜索**（`integrations/websearch/searchSource.ts`）：`POST {baseUrl}/v1/web-search`（Bearer 认证，`{query, summary, count, freshness}`）。每次自检或新生成任务动态解析“个人加密 Key + Base URL → 站点 `SEARCH_API_KEY` + `SEARCH_API_BASE_URL` → Null 源”；个人 Base URL 保存与使用时均执行 SSRF 校验，用户更新或清除后无需重启。默认 LangSearch（免费）；博查同族 schema 可直接切换。承担玩法/避雷/**预约政策**的语义检索，带来源链接。
- **预约种子表**（`data/reservationSeeds.json`，~50 条）：全国热门「需预约」景点（故宫/国博/莫高窟/陕历博等），`add_candidate` 命中即强制 `reservation=required` 并附官方渠道链接；离线可用、随仓库维护（数据截至 2026-07）。
- **调研产物**：结构化候选池 `ResearchPoi[]`（挂 `Trip.overview` 持久化）+ 文本摘要；候选写入时经 SSE `candidate` 事件实时推送前端概览卡片。
- **纪律四道闸**（沿用原 ContentSource 骨架）：串行限速（高德 350ms / 搜索 1s）+ 24h TTL 缓存 + 任务级上限（高德 ≤8 / 搜索 ≤10 次）+ 全站日额度（`AMAP_DAILY_BUDGET` 默认 150 / `SEARCH_DAILY_BUDGET` 默认 500，从 `generations` 用量列聚合 + 60s 内存缓存）。
- **降级链**：某源未配置/超额/故障 → 该源注入 Null 实现（搜索回空、自检变红），生成流程**永不因数据源失败而失败**；两源皆缺时纯模型知识调研，`phase_start` note 与 `meta.dataSources` 明示实际来源。
- **合规红线**（高德服务协议 3.5/3.4）：结果仅供展示，图片**热链不转存**；候选落库只留名称+短摘要+来源链接；不做批量采集，不用于模型训练。

---

## 7. API 设计

普通 JSON 响应统一为 `{ code, message, data }`：成功 `code=0`，业务载荷在 `data`；失败保留 HTTP 4xx/5xx，业务码与可读消息分别在 `code`、`message`。下表中的业务结构均指 `data`。SSE 帧、OAuth 重定向及静态文件保留各自协议。前端请求层统一解包、处理超时和业务 401。详见 [API 响应与请求约定](API_CONTRACT.md)。

| 方法 & 路径 | 说明 | 校验/限制 |
|---|---|---|
| `POST /api/auth/register` | 邮箱+密码（`REGISTRATION_MODE=invite` 时另需邀请码，比对 `INVITE_CODE` env） | 密码≥8；3 次/min/IP |
| `GET /api/auth/config` | 公开：注册模式 + GitHub 登录是否启用（前端据此渲染） | 无需会话 |
| `GET /api/auth/github` · `GET /api/auth/github/callback` | GitHub OAuth 登录（state 防 CSRF；verified 邮箱自动绑定；token 用完即弃） | 5 次/min/IP；未配置时 404 |
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` | 会话签发/销毁/查询（`/me` 无会话返回 200 + `data: null`，访客态不是错误） | 登录 5 次/min/IP；失败不泄露账号存在性 |
| `GET /api/settings` | 普通字段 + LLM BYOK + 个人高德/搜索配置状态（仅 Key 存在性、尾号、个人搜索 Base URL 与站点回退存在性） | 需会话 |
| `PUT /api/settings` | 写 LLM BYOK、个人高德 Key 与个人搜索 Key + Base URL；搜索配置用显式 `clearSearchConfig` 同时清除 Key 与 URL（Key 均加密入库） | 需会话 |
| `GET /api/settings/sources-status` | 调研数据源自检 `{searchProvider, routeProvider, poi, websearch}`（搜索固定天地图、路线链高德优先；`poi`/`websearch` 真实探测，`routeProvider` 只报配置归属；结果按 userId + credential revision 隔离记忆化） | 需会话 |
| `GET /api/usage` | 今日剩余配额 / 已用次数 / 重置时间 | 需会话 |
| `GET /api/trips` · `POST /api/trips`(导入) · `GET/PUT/DELETE /api/trips/:id` | 历史/导入/详情/自动保存/删除 | TripSchema；user_id 归属校验 |
| `POST /api/generations` | **先查配额**（quotaService）→ 创建任务，HTTP 202，`data: {jobId}` | GenerateFormSchema；并发 1/用户；配额尽 → 429 + 重置时间 |
| `GET /api/generations/:jobId/events` | SSE 进度（Last-Event-ID 重放） | 归属校验 |
| `POST /api/generations/:jobId/cancel` | 取消（丢弃草稿，**不计配额**） | 归属校验 |
| 生产 | `@fastify/static` 托管 web/dist + SPA fallback；开发 Vite proxy 同源 | |

**JobManager**：同 v0.2（内存任务表 + 512 条事件环形缓冲；单实例边界；重启则进行中任务置失败）。任务结束时把 status/tokens/amap_calls/tianditu_calls/search_calls/used_byok 写入 `generations`（地图调用按当前生效的服务商计入各自列）。

---

## 8. 前端架构要点

- 路由：`/login` `/register` `/trips` `/trips/new` `/trips/:id`；未登录守卫。
- react-query 管 `me/settings/usage/trips/trip(id)`；zustand 管编辑器态；防抖 800ms PUT 自动保存 + 指示器。
- 生成进度页 EventSource 断线重连 + Last-Event-ID 重放 + 刷新恢复。
- **SettingsDialog 分级**：普通视图（账号 + 今日配额）默认；「高级选项」折叠区收纳 LLM BYOK、个人高德 Key，以及个人 Web 搜索 API Key + Base URL。两类个人数据源凭据均支持保存、更新、空 Key 保留和显式清除；搜索清除会同时删除个人 Key 与 URL。
- **移动端基准**：核心流程按 <768px 设计再放大到桌面；微信内置浏览器实测入 D2 验收（长图保存/分享、SSE、地图手势）。
- **样式双轨（09-26 起）**：
  - 新页面 / 新组件用 **Tailwind 原子类**写在 JSX 里；颜色**只**允许取 `apps/web/src/styles/tailwind.css` 中 `@theme` 定义的语义色生成的类 —— 六组：`brand*`（主蓝、渐变两端、禁用态）、`accent-*`（四段图标与地图打点的点缀色）、`ink*`（文字层级，含地图标签与未选态）、`canvas`（页面底色）、`hairline*`（玻璃面板与分隔条）、`map-*`（省界、国界、背景城市点）。**不写** `bg-[#2f6bf3]` 这类硬编码 hex：要新颜色就先在 `@theme` 里加 token，改色只改一处。
  - 包括登录、列表、编辑器、生成页在内的所有页面统一使用 Tailwind；已删除 global.css、print.css、map-canvas.css 和独立字体样式文件，不再保留旧页面普通 CSS 例外。
  - 引入 theme 与 utilities，关闭 preflight；基础默认值放在低优先级的 `@layer base`，页面工具类可正常覆盖。
  - 字体定义和动画关键帧集中在 tailwind.css；响应式、打印、SVG 外观和父子选择器使用 Tailwind variants。Leaflet 与字体包自带的第三方 CSS 保留。
  - 数据驱动的值（按天路线色、进度宽度、背景图 URL、marker HTML 内联样式）继续用内联 `style` / CSS 变量，不为它们造类名。
  - **两类字面值留在原地**：中性色的半透明（`bg-white/72`、`border-white/70`、SVG 的 `fill="rgba(255,255,255,0.5)"`）；以及阴影里的深蓝字面量（`shadow-[0_18px_50px_rgba(31,64,124,0.14)]` —— 它比品牌蓝更深，且只出现在四处，往任意值里嵌变量得不偿失）。token 只管品牌色与文字色。
  - 组件样式直接写 JSX 工具类；不要重建旧 CSS 选择器层或运行时类名转换层。

## 9. 安全设计

| 项 | 方案 |
|---|---|
| 密码 / 会话 | bcryptjs(cost 12)；256bit token 存 sha256；Cookie `httpOnly+SameSite=Lax+Secure(生产)`；TTL 30 天滑动 |
| **注册管控** | 三态 `REGISTRATION_MODE`：open（默认开放）/ invite（邀请码，可随时切回的防滥用刹车）/ closed；未设置时按 `INVITE_CODE` 是否非空推断（向后兼容）。GitHub 登录仅信 verified 邮箱做账号绑定，invite/closed 下不创建新账号 |
| **配额** | 用户日配额 + 全站数据源日额度（§6）——第二道闸；生成并发 1/用户 |
| 用户凭据 | LLM、个人高德与个人搜索 Key 均用 AES-256-GCM（`MASTER_KEY` env）；API 仅回存在性与 last4；日志禁 Key；个人数据源凭据和源实例不进入全局单例或跨用户缓存 |
| **SSRF（v0.3 升为强制）** | `ssrfGuard`：用户提供的 LLM/搜索 baseUrl 仅允 http(s)，**解析后 IP 落私网/环回/链路本地段一律拒绝**（保存与使用时双查，防 DNS 重绑定）；`SSRF_ALLOWLIST` env 供站长豁免自有内网端点 |
| 越权 | trips/generations 全量 user_id 过滤；jobId uuid + 归属校验 |
| 输入 | 全路由 TypeBox；React 转义；外链 `rel="noopener noreferrer"` |
| 限流 | 注册 3/min/IP · 登录 5/min/IP · 生成配额制 |

## 10. 开源工程与部署（v0.3 新增）

- **Docker Compose**：`app`（多阶段构建：web build → server 托管）+ `db`（`pgvector/pgvector:pg16`）。app 只绑 `127.0.0.1:${APP_PORT:-3001}`，由宿主机前置反代转发（`nginx.host.conf` 含 SSE 关键参数）；容器化内置反代场景见 `docker-compose.release.yml`。数据卷：`pg_data`（PostgreSQL 数据目录）；媒体与图源索引默认在宿主机 `./data`（`data/media` 只读挂载、`data/media/share-posters` 可写子挂载），`MEDIA_STORE=s3` 时不再使用。
- **环境变量**（`.env.example` 全量注释）：

| 变量 | 说明 |
|---|---|
| `PORT` / `DATABASE_URL` / `POSTGRES_PASSWORD` | 服务端口 / PostgreSQL 连接串（09-18 起唯一运行态数据库）/ compose 内 `db` 服务密码 |
| `MASTER_KEY` | 32 字节 hex，Key 加密主钥 |
| `REGISTRATION_MODE` / `INVITE_CODE` | 注册三态 open/invite/closed（未设置时按 INVITE_CODE 推断）/ 邀请码（invite 模式必填） |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `APP_BASE_URL` | GitHub OAuth 登录（可留空=隐藏该入口）/ 站点对外地址（启用 GitHub 时必填） |
| `SITE_LLM_BASE_URL` / `SITE_LLM_API_KEY` / `SITE_LLM_MODEL` | 站点供 Key（可留空=纯 BYOK 模式） |
| `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL` / `EMBEDDING_DIMS` | RAG 向量召回（可选；缺省回落 `SITE_LLM_*`，默认模型 `cf/bge-m3`，维度 1024 须与 schema 对齐）。未配置时向量层静默跳过（§4.4） |
| `GEN_DAILY_LIMIT` | 用户日生成配额（默认 3） |
| `AMAP_KEY` / `AMAP_DAILY_BUDGET` | 站点默认高德 Web 服务 Key（用户个人 Key 优先；均为空=该源降级）/ 全站日额度（默认 150） |
| `TIANDITU_KEY` / `TIANDITU_DAILY_BUDGET` | 天地图 Web 服务 Key（`tk`）。**两家互补、无切换开关**：地点搜索固定天地图；路线 + 地理编码高德优先、缺 `AMAP_KEY` 时用它 / 天地图全站日额度（默认 150，与高德分别计数） |
| `SEARCH_API_KEY` / `SEARCH_API_BASE_URL` / `SEARCH_DAILY_BUDGET` | Web 搜索 Key（可留空=该源降级）/ 端点（默认 LangSearch，博查同族可切）/ 全站日额度（默认 500） |
| `SSRF_ALLOWLIST` | 逗号分隔的内网豁免地址 |
| `MEDIA_STORE` / `MEDIA_S3_*` / `MEDIA_BASE_URL` | 图片与图源索引（`data/photo-store`）的存储后端：`local`（默认，宿主机 `data/`，容器只读挂载 `data/media`）或 `s3`（R2 / MinIO / S3，桶内 key 与 `data/` 下的相对路径一一对应）。`MEDIA_S3_ENDPOINT` / `_BUCKET` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` 在 `s3` 模式下缺一即启动报错；`MEDIA_BASE_URL` 是封面与海报共用的展示前缀（默认 `/media` 同源，CDN 时填桶的自定义域名 + `/media`），切 CDN 只改它、不动库，但桶需配 `GET/HEAD` 的 CORS 供海报下载。迁移与用量报告：`apps/server/scripts/migrate-media-to-s3.mts`（默认预演，幂等；`--report` 只读看体积） |

- **CI**（GitHub Actions）：push/PR → 三包 `tsc --noEmit` + `npm run build`。
- **开源卫生**：MIT LICENSE；README（截图 + 三分钟部署指引 + 小红书小号声明 + 安全说明）；语义化版本 + CHANGELOG。

## 11. 风险与后备方案

| # | 风险 | 概率 | 缓解 / 后备 |
|---|---|---|---|
| R2 | 小参数模型多轮工具调用弱 | 中 | prompt 强约束 + 工具纠错自愈 + 完整性兜底；README 标注推荐模型量级 |
| R3 | Nominatim 限流 | 中 | 服务端限流队列 + 缓存 + estimated 降级 |
| R7 | 外部数据源不稳（高德配额/搜索 API 无 SLA） | 中 | 适配器隔离 + 自检 + Null 降级不断服务 + 全站日额度 + 预约种子表离线兜底 |
| R8 | 多 Agent token 成本 | 确定 | 摘要化返回/轮次上限/用量落库透明化 |
| **R11** | **开源后站点被滥用（Key 盗刷/爬注册）** | 中 | 三态注册开关（滥用时一键切回 invite）+ 双层配额 + 限流 + 用量表审计——三道闸缺一不可 |
| **R12** | **微信内置浏览器兼容性怪癖**（下载/长按保存/SSE） | 中 | D2 真机实测；长图导出用「长按保存」引导而非 download 属性兜底 |
| R9 | SSE 被反代缓冲 | 低 | `nginx.host.conf` 已含 `proxy_buffering off` / `proxy_cache off` 等关键参数（`docker-compose.release.yml` 同）；README 注明等价配置 |
| R10 | 自建 PG 未装 pgvector 扩展（向量层静默失效） | 低 | 启动迁移对扩展与 `embedding` 列均为幂等可跳过；检索退化为纯关键词召回，生成不受影响（§4.4 降级链） |
| R6 | react-leaflet 版本 | 低 | §1 规则 |

## 12. 待实现期确认清单

> C0 核对方式说明（2026-07-06）：本机 `.env` 暂无 `SITE_LLM_*`，真实端点在线冒烟延后；已按已安装包（pi-agent-core / pi-ai 0.73.0）的类型声明完成**离线核对**，并落地可复跑脚本 `scripts/smoke-pi.mjs`（站长填好 env 即可在线复验）。API 形状全部与设计吻合，**无需启用手写工具循环后备**。
> v0.4 变更（2026-07-09）：小红书 MCP 集成整体移除（含其冒烟脚本与 SDK 依赖），调研数据源改为高德 + Web 搜索，连通冒烟脚本为 `scripts/smoke-sources.mjs`。

- [x] pi-agent-core：`Agent` 构造形状 / `getApiKey` / 中止方式 / 工具返回与 `terminate` —— 已核对（v0.73.0）：
  - 构造：`new Agent({ initialState: { systemPrompt, model, thinkingLevel, tools, messages }, getApiKey, transport })`
  - Key：`getApiKey(provider)`（按 `model.provider` 回查，可返回 Promise）
  - 中止：`agent.abort()` + `agent.waitForIdle()`；中止后 assistant 消息 `stopReason: "aborted"`
  - 工具：`AgentTool.execute(toolCallId, params, signal, onUpdate)` → `{ content, details, terminate? }`；失败**抛异常**（勿在 content 里编码错误）；`terminate: true` 需**整批**工具皆置位才提前终止
  - 事件：`subscribe()` → `agent_start/turn_start/message_start|update|end/tool_execution_start|update|end/turn_end/agent_end`；SSE 映射齐备
- [x] pi-ai 自定义 `Model` 最小必填集 + compat 探测 —— 已核对：必填 `id/name/api("openai-completions")/provider/baseUrl/reasoning/input/cost/contextWindow/maxTokens`；`compat` 缺省按 baseUrl 自动探测；用量在 `AssistantMessage.usage`（`input/output/totalTokens`），apiKey 走 `StreamOptions.apiKey`（Agent 内部经 `getApiKey` 注入）
- [x] 高德搜索POI 2.0 请求参数与字段（2026-07-09 官方文档核对）→ 见 §12.1 适配器速查
- [x] LangSearch / 博查 web-search 同族 schema（2026-07-09 官方页面核对；在线连通跑 `scripts/smoke-sources.mjs`）
- [x] better-sqlite3 本机安装（A0 已过）
- [ ] 微信内置浏览器：长图保存路径、EventSource 行为（D2 真机）

### 12.1 调研数据源适配器速查（v0.5；地图服务商切换 v0.6）

> **2026-11-05 变更**：天地图已整体下线。路线规划、地理编码、地点搜索全部走高德（`integrations/amap/poiSource.ts`），
> 按服务分别记账（`amap_service_usage`）。本节以下关于天地图的内容为历史记录，仅存档。

地图侧**两条链互补**（09-25 二次调整，不再有 `MAP_PROVIDER` 开关）：地点搜索固定天地图；
路线规划 + 地理编码由 `integrations/geoProvider.ts` 解析为**高德优先**（缺 `AMAP_KEY` 时降级天地图）。
形状由 `integrations/geoContracts.ts` 定义，**进出坐标一律 GCJ-02**
（天地图侧的 WGS-84 ↔ GCJ-02 互转收敛在 `integrations/tianditu/*` 内部）。

| 适配器方法 | 端点 | 关键入参 | 返回要点 |
|---|---|---|---|
| `amapPoiLocate(key, name, city)`（地理编码主路径） | `GET https://restapi.amap.com/v5/place/text` | `key` · `keywords`(≤80字) · `region`+`city_limit=true` · `page_size=1` | `pois[0]`：location（GCJ-02）+ adcode；**与 POI 搜索共用同一份个人配额，实测会被打满（`10044`）**，失败回退 `amapGeocode` → 天地图 → Nominatim |
| `amapGeocode(key, name, city)`（v0.5） | `GET https://restapi.amap.com/v3/geocode/geo` | `key` · `address`(city+name) · `city` | `geocodes[0]`：location（GCJ-02）+ adcode；失败回 null |
| `routeEstimate(key, origin, dest, mode, opts)`（v0.5） | `GET /v5/direction/walking` · `/v5/direction/driving` · `/v5/direction/transit/integrated` | `origin`/`destination`（「lng,lat」）· `show_fields=polyline,cost` · transit 另需 `city1`/`city2`（adcode） | `paths[0]`/`transits[0]`：cost.duration（秒）+ distance（米）+ steps[].polyline（抽稀 ≤4000 字符，超长丢弃）；失败回 null → 启发式降级 |
| `tiandituGeocodeActivity(tk, name, city)`（v0.6） | `GET https://api.tianditu.gov.cn/geocoder` | `ds={"keyWord":"城市+名称"}`（**JSON 字符串**）· `tk` | `location{lon,lat}`（CGCS2000/WGS-84 → 转 GCJ-02）；成功状态是**字符串** `status:"0"`，且**无 adcode**（回空串）；失败回 null → Nominatim 兜底 |
| `tiandituRouteEstimate(tk, origin, dest, mode, opts)`（v0.6，实测校正） | `GET /drive?type=search` · `GET /transit?type=busline` | drive：`postStr={"orig","dest","style":"0"}`（WGS-84）；transit：`postStr={"startposition","endposition","linetype":"1"}`（**无城市参数**） | drive 是 **XML**：`<distance>`(km)/`<duration>`(秒)/`<routelatlon>`(整条折线)；transit 是 **JSON**：`results[].lines[]` 是 ≤5 条互斥候选，`segments[].segmentLine[]` 是平行备选，`segmentTime`(**分钟**)/`segmentDistance`(米) 需按「单方案单备选」累加；`style=3` 实测是驾车最短路线（**步行无端点**）；**无骑行端点**；隐含速度超出 1~150km/h 即回 null |
| `TiandituPoiSource.searchPois(...)`（v0.6，**POI 搜索唯一实现**） | `GET https://api.tianditu.gov.cn/v2/search` | `postStr={"keyWord","level","mapBound","queryType":"1","start","count"}` · `type=query` · `tk`（**`mapBound` 必需**，由城市名先经 `/geocoder` 解析中心再取 ±0.5°，按 region 24h 缓存） | `pois[]`：name/address/**lonlat**（WGS-84 → 转 GCJ-02）/poiType；**无评分、人均、营业时间、图片，无 adcode**（均留空）；成功判定 `status.infocode===1000`；**需单独申请权限**，不可用时回空数组、**不回落高德** |
| `SearchSource.search(query)` | `POST {SEARCH_API_BASE_URL}/v1/web-search` | Bearer `SEARCH_API_KEY`；body `{query, summary: true, count, freshness}` | `data.webPages.value[]`：name/url/snippet/summary/siteName/datePublished（LangSearch 与博查同族） |
| `selfCheck()`（两源各一） | 同上（最小探测请求） | — | `SourceStatus{configured, checked, ok, message}`；`GET /api/settings/sources-status` 数据源 |

- **POI 搜索换成天地图后，`rating`/`cost`/`opentime`/`photoUrls` 在运行时恒为空**
  （天地图 `pois[]` 不提供这四类字段）。`SourcedPoi` 保留它们是为了契约稳定与将来换源，
  **不是「现在还有数据」**；`add_candidate` 的 `coverUrl` 参数已随之移除，前端封面图留空。
  高德侧保留了同样的字段填充（`v3/geocode/geo` 仍会回 adcode），但那是地理编码链，不经候选池。
- **天地图不做骑行近似**：`drive` 结果冒充骑行会系统性低估时长，故 `cycle` 恒回 null 走启发式；
  骑行在熔断器的**前置拦截**层处理，不计失败也不扣额度（否则一队骑行段会打穿熔断器）。
- **前端底图不得随服务商切换**：Leaflet 高德瓦片与库内 GCJ-02 同系；换成天地图（WGS-84）瓦片会让所有
  marker 偏移约 500m。地图服务商切换只影响服务端数据源。
