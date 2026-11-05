# 织程 TripWeaver · 开发计划

- 项目名称：**织程 TripWeaver**（仓库名 `tripweaver`）
- 文档版本：v0.6
- 日期：2026-09-20
- 关联文档：[PRD](./PRD.md) · [技术架构](./TECHNICAL_ARCHITECTURE.md)

> **修订记录**
> - v0.2：按全栈 + 多 Agent + 小红书重排阶段（29.5h）。
> - **v0.3**：并入开源运营姿态——邀请码/配额/Key 双轨（A2、C2）、SSRF 强制（A2）、设置分级（B1）、微信真机实测（D2）、新增 E 段开源工程化；总估时 **34.5h**。
> - **v0.4**（2026-07-09）：小红书抓取整体移除，调研数据源改为「高德搜索 POI 2.0 + Web 搜索 API」双层 + 预约种子表；`ContentSource` 抽象随之退役。
> - **v0.5**（2026-07-12）：坐标决策反转（行程坐标统一高德 GCJ-02，Nominatim 仅兜底）；新增地理编码/路径规划适配器与 `TripDay.legs` 通勤段；机械工作移出 LLM 循环。
> - **M0-A/B/C**（2026-07-14 ～ 07-19）：可行性引擎 + 时序前移（M0-A）、金集 eval harness 与长途日纪律（M0-B）、远郊 anchor 清零后解除公网部署阻塞（M0-C）；期间完成 ST1–ST3 地理数据层重构与住宿锚点契约。
> - **v0.6（本版）**：持久层自 SQLite 迁至 PostgreSQL 16 + pgvector（09-18），并落地 RAG 检索链路；§1 策略、§2 里程碑、§5 风险、§6 交付物已对齐现状。

> **状态说明**：§3 的 A–E 段是 2026-07-05 ～ 07-07 的**执行记录**，条目与验收快照保留原状（含当时的小红书 / SQLite 表述）。v0.4 之后的数据源替换、坐标反转、PG 迁移与 RAG 地基的实时状态，以 [技术架构](./TECHNICAL_ARCHITECTURE.md) 与 `.trellis/spec/` 为准。

---

## 1. 总体策略

- **增量可验证**：每 Phase 结束可运行、可验收，标准明确到「点什么、看到什么」。
- **纵向切片**：先通「注册(邀请码) → 示例行程 → 编辑 → 历史」全栈闭环（M1），再接多 Agent 生成（M2），再导出打磨（M3），最后开源发布件（M4）。
- **外部依赖早冒烟**：pi-agent-core（C0）、高德 / Web 搜索适配器（`scripts/smoke-sources.mjs`）放在段首，失败立即走 Null 降级；PostgreSQL 连接与 pgvector 扩展在启动迁移中幂等校验（缺扩展不阻断，向量层静默跳过）。
- **单入口隔离**：前端只认 HTTP API；Orchestrator 只暴露 `runGeneration`；调研数据源只认 `PoiSource` / `SearchSource` 适配器；LLM 配置只认 `resolveLlmConfig`；检索只认 `retrieveContext`——实现替换均不返工上层。
- **移动端基准**：B 段起所有 UI 按 <768px 先行设计，桌面是放大而非另做。

## 2. 里程碑

| 里程碑 | 包含 Phase | 达成标志 |
|---|---|---|
| **M1 全栈行程编辑器** | A0–A3, B1–B3 | 邀请码注册登录 → 示例行程 → 编辑（清单/地图/预算）→ 自动保存 → 历史回访；全程无 Key |
| **M2 多 Agent 智能生成** | C0–C3 | 站点 Key + 调研数据源（现为高德 POI + Web 搜索；v0.4 前为小红书 MCP）：三阶段生成可见/可取消/可恢复；配额与降级全路径可用 |
| **M3 功能完备** | D1–D2 | 三种导出 + 响应式 + 微信真机 + 安全走查 + 回归全过 |
| **M4 开源发布就绪** | E1 | Docker Compose 一键部署 + CI + README/LICENSE，站长 30 分钟可复现 |
| **M0 生成质量硬化**（v0.4 后追加） | M0-A/B/C | 可行性引擎 + 时序前移、金集 eval harness、远郊 anchor 清零；解除公网部署阻塞 |

> M1–M4 均已于 2026-07-07 达成（§3 各段验收快照）；M0 系列为之后追加的质量里程碑。

---

## 3. 阶段拆解

### A — 服务端与工程基础

#### Phase A0 — Monorepo 脚手架（1h）

- [ ] 根 workspaces + `git init` + 首次提交（含 docs/）；shared/web/server 三包骨架
- [ ] 安装依赖并**冒烟 better-sqlite3**（失败即切 `node:sqlite`）
- [ ] Vite dev proxy `/api`；concurrently 一键 dev；`/api/health`

**验收**：SPA 壳 + health OK；三包 `tsc --noEmit` 过。

#### Phase A1 — shared 领域模型 + DB（1.5h）

- [ ] `shared`：types / schemas（TypeBox）/ constants；`lib/budget.ts` 同构；示例行程
- [ ] Drizzle 五表：users / sessions / user_settings（含 `byok_enabled`）/ trips / **generations（v0.3）** + 迁移

**验收**：迁移产出五表；budget 聚合手动验证。

#### Phase A2 — 认证、设置与安全基座（3h）

- [ ] `auth/`：bcrypt、会话签发校验、守卫、**邀请码校验（invite.ts）**
- [ ] 路由：register（邀请码）/login/logout/me + 限流；`crypto/secretBox.ts`
- [ ] settings 读写：BYOK 字段 + `byok_enabled`，Key 加密入库、GET 仅 last4
- [ ] **`integrations/ssrfGuard.ts`**：scheme 校验 + 私网/环回段拒绝 + `SSRF_ALLOWLIST` 豁免；接入 settings 保存
- [ ] `env.ts` 全量环境变量校验（架构 §10 表）

**验收**：无/错邀请码注册被拒；curl 全流程通；库内无明文；`PUT /settings` 填 `http://192.168.1.1` 被拒、填 allowlist 地址通过；401 路径正确。

#### Phase A3 — 行程 CRUD + 用量 API（2h）

- [ ] trips 五路由（冗余列/归属校验/导入校验）
- [ ] `quotaService`（基于 generations 表计数）+ `GET /api/usage`

**验收**：curl 全链路 + 越权测试；手工插 generations 行后 usage 计数正确。

### B — 前端基础与编辑器

#### Phase B1 — 前端骨架：路由/认证/历史/设置分级（3h）

- [ ] router + 登录/**注册（含邀请码字段）**页 + 守卫；api client + react-query hooks
- [ ] TripListPage（历史：字段/重命名/删除/打开 + 空态引导）
- [ ] **SettingsDialog 分级**：普通视图（账号 + 今日配额）/「高级选项」折叠区（BYOK 全字段 + 厂商预设 + last4 + 小红书自检位）

**验收**：PRD F6/F7 验收项通过；普通视图无任何技术字段。

#### Phase B2 — 行程编辑器（3.5h）

- [ ] TripEditorPage + editorStore + 「加载示例」；v0.1 组件族（Toolbar/清单/卡片/编辑弹窗，含来源笔记链接展示）
- [ ] 防抖自动保存 + 指示器；global.css（**移动端先行**）

**验收**：PRD F4 通过（含跨浏览器一致）。

#### Phase B3 — 地图 + 预算（3h）—— 🏁 M1

- [ ] MapView（divIcon/折线/Popup 含来源链接/FitBounds/DayFilter/Leaflet 坑清单）
- [ ] BudgetPanel + 费用内联编辑

**验收**：PRD F2/F3 通过。**M1 走查：邀请码注册→示例→编辑→地图→预算→历史，全程无 Key、手机视口。**

### C — 多 Agent 智能层

#### Phase C0 — 双冒烟实验（1h，风险闸门）

- [x] **pi 冒烟**：核对架构 §12 前三项（v0.73.0 类型层离线核对全过；在线脚本 `scripts/smoke-pi.mjs` 留待站长填 `SITE_LLM_*` 后复验）
- [x] **MCP 冒烟**：SDK 握手方式核对 + 上游 13 工具映射表（原 §12.1）；在线复验脚本随小红书 MCP 集成一并保留至 v0.3（**该集成已于 2026-07-09 v0.4 移除**，数据源冒烟改为 `scripts/smoke-sources.mjs`）
- [x] 后备处置：API 形状吻合，**不启用**手写工具循环；小红书按 `NullContentSource` 先行（本机未配 MCP 地址），已回记架构文档 §12

**验收**：冒烟脚本出预期结果；§12 清单逐项处置。✅（2026-07-06，在线复验项已在 §12 标注）

#### Phase C1 — 集成层（2h）

- [x] `ContentSource` + `XhsMcpContentSource`（§12.1 映射/串行限速 2s/TTL 24h 缓存/任务级上限 6 搜索+8 详情）+ Null 降级 + `/api/settings/xhs-status`
- [x] `geocode.ts`（Nominatim 1.1s 串行限流 + 24h 缓存 + 超时回 null）
- [x] 追加：`lib/proxy.ts` 出站代理接管（开发机系统代理下 Node fetch 不认 HTTP_PROXY 的坑；localhost 豁免保 MCP 直连）

**验收**：自检状态正确；关 MCP 变红不抛错。✅（2026-07-06 实测：未配置→降级说明；MCP 离线→ok:false 且 search 静默回空；浅草寺地理编码 859ms 命中缓存）

#### Phase C2 — 三 Agent + Orchestrator + 配额（4.5h）

- [x] **`model.ts` Key 双轨解析**（settingsService.resolveLlmConfig + buildModel；使用时二次过 ssrfGuard）
- [x] `prompts.ts` 三份 system prompt；`tools/` 四组工具（xhs/geo/draft/review，defineTool 泛型助手）+ DraftTrip（draft.ts）+ 完整性校验兜底
- [x] `orchestrator.ts`（三阶段 + ≤2 轮修订 + token/xhs 用量聚合 + 全站 XHS 日额度闸门 + 10min 兜底超时）；`jobManager.ts`（状态机/512 环形缓冲/取消/30min 终态保留）；agents/runner.ts 公共运行器（轮次上限/事件转发/中止）
- [x] 路由：POST /generations（**配额检查→429+重置时间**）、GET :jobId（快照）、SSE（Last-Event-ID 重放+心跳）、cancel；任务落 `generations` 表（取消/失败不计配额）
- [x] 追加：`scripts/verify-c2.mjs` 离线端到端验收（mock OpenAI 兼容端点驱动全流水线，28 项断言）

**验收**：curl 建任务→SSE 三阶段→job_done 落 trips + generations；配额用尽被拒；cancel 无残留且不计数；BYOK 用户走自己端点（日志验证）且计次。✅（2026-07-07 `node scripts/verify-c2.mjs` 28/28 PASS；真实模型联调待站长填 Key 后跑 smoke-pi + 手工走查）

#### Phase C3 — 生成前端（2.5h）—— 🏁 M2

- [x] PlannerPage 表单（含「今日剩余 N 次」+ 配额尽禁用文案）→ GenerationTimeline（三阶段/轮次徽章/工具时间线/思考折叠/token 用量/取消）
- [x] EventSource 重连（Last-Event-ID）/刷新恢复（sessionStorage + 快照 + 全量重放）；完成展示审校提示后自动跳编辑器
- [x] 异常文案全套：配额尽（含重置时间）/无 Key 双轨指引（联系站长 vs 高级选项自填）/401/降级标注（gen-banner）/审校遗留（📝 列表）；409 已有任务 → 自动接管进度
- [x] 追加：SettingsDialog 高级折叠区补上小红书自检位（展开才探测）；`scripts/verify-c3.mjs` 浏览器级验收（生产模式静态托管 + mock LLM，14 项断言）

**验收**：PRD F1 五项 + F8 三项全过。✅（2026-07-07 `node scripts/verify-c3.mjs` 14/14 PASS；`verify-c2` 28/28 与 `verify-m1` 18/18 回归全绿。**M2 走查通过**——真实模型联调留待站长填 Key）

> C 段实现备注：① agents/ 三文件合并为 runner.ts 公共运行器 + orchestrator 内联装配（KISS，每 Agent 装配仅 ~10 行）；② SSE 监听器故障隔离（emit try/catch + 写死连接即退订），浏览器刷新绝不拖垮流水线；③ 开发机系统代理坑收录于 lib/proxy.ts。

### D — 功能完备

#### Phase D1 — 导出三件套（2h）

- [x] PrintView + print.css（visibility 打印隔离 + break-inside 防截断）；export.ts（toPng 2x/JSON v2/打印/微信 UA 探测）；ExportMenu（含微信「长按保存」引导层）
- [x] 导入→POST /api/trips（列表页已有）+ 列表卡片「导出 JSON」（F7 补齐）

**验收**：PRD F5 通过（跨账号导入还原）。✅（2026-07-07 `node scripts/verify-d1.mjs` 6/6 PASS：JSON v2/长图 521KB/打印隔离/列表导出/跨账号 100% 还原/坏文件报错；微信真机项待 D2 清单回填）

#### Phase D2 — 响应式、微信真机与安全走查（3h）—— 🏁 M3

- [x] ≤768px 三页签（M1 已达标并回归）；空态/长文本/无坐标标识（既有）；生成表单与时间线移动端视口通过（C3 验收覆盖）
- [~] **微信内置浏览器真机实测（暂时搁置）**：自动化不可覆盖 → 已交付 [docs/WECHAT_CHECKLIST.md](./WECHAT_CHECKLIST.md)（10 项，含长按保存兜底说明）；2026-07-19 决定暂不阻塞发布验证，恢复后由站长真机回填
- [x] 安全走查：`scripts/verify-security.mjs` 23 项全过（横向越权 404 全路径/注册登录限流 429/Key 不见于响应·日志·库文件三重检/Cookie HttpOnly+Lax+生产 Secure/ssrfGuard 四类拦截+白名单/邀请码/失败不泄露账号存在性）
- [x] 全量回归：三包 tsc + build + 生产模式复验（C3/D1 脚本即生产静态托管链路）+ verify-m1 18/18 + verify-c2 28/28 + verify-c3 14/14 + verify-d1 6/6

**验收**：PRD §7 成功标准 1、3、5 达成。✅（2026-07-07；标准 3 的微信端子项待真机清单回填）

### E — 开源发布

#### Phase E1 — 开源工程化（3.5h）—— 🏁 M4

- [x] Dockerfile（多阶段）+ docker-compose.yml（app + 可选小红书 MCP 注释模板 + caddy，数据卷；该 MCP 模板已随 2026-07-09 v0.4 数据源替换移除）+ Caddyfile（SSE `flush_interval -1`）——A0 期已建，E1 复核与实现一致
- [x] `.env.example` 全量注释（补 compose 内 MCP 主机名提示）；GitHub Actions（三包 typecheck + build，分支覆盖 main/master）
- [x] LICENSE（MIT）+ README：截图（docs/screenshots）、三分钟部署指引、小红书专用小号声明、成本与配额说明、**推荐模型量级**、安全说明、验证与冒烟脚本清单
- [x] 干净目录部署演练：git archive → npm ci（349 包/27s）→ typecheck+build → 生产模式启动 → health/注册 201/SPA 托管全通。**本机无 Docker**，compose 构建烟测待有 Docker 的环境执行（Dockerfile 与演练用的同一套 npm 命令）

**验收**：PRD §7 成功标准 2 + 4；CI 绿。✅（2026-07-07；CI 实际运行待推送 GitHub 后确认，配置已按 master/main 双分支覆盖）

---

## 4. 工作量汇总

| 段 | 阶段 | 估时 | 累计 |
|---|---|---|---|
| A 服务端基础 | A0–A3 | 7.5h | 7.5h |
| B 前端与编辑器（M1） | B1–B3 | 9.5h | 17h |
| C 多 Agent 智能层（M2） | C0–C3 | 10h | 27h |
| D 功能完备（M3） | D1–D2 | 5h | 32h |
| E 开源发布（M4） | E1 | 3.5h | **35.5h** |

> 净工时；C0 冒烟失败触发后备约 +2–3h。相比 v0.2（29.5h）增量 6h 来自：邀请码/配额/双轨（+2.5h）、SSRF 与安全走查（+1h）、微信真机（+1h）、开源工程化并入正式计划（+1.5h 净增）。

## 5. 风险跟踪（对应架构 §11）

| 风险 | 触发信号 | 应对落点 |
|---|---|---|
| R10 自建 PG 未装 pgvector | 启动迁移跳过 embedding 列 | 检索退化为纯关键词召回，生成不受影响（技术架构 §4.4） |
| pi API 偏差 | C0 冒烟失败 | 手写工具循环（接口不变） |
| R7 调研数据源不稳（高德配额 / 搜索 API 无 SLA） | 自检红/生成中报错 | 适配器隔离 + Null 降级不断服 + 全站日额度 + 预约种子表离线兜底 |
| R2 模型工具调用弱 | C2/C3 频繁不终止 | prompt 调优 + 完整性兜底 + 推荐模型标注 |
| R11 成本滥用 | usage 异常增长 | 换邀请码/调低配额（均 env 级操作） |
| R12 微信怪癖 | D2 真机 | 长按保存兜底等 |
| R8 token 成本 | 用量透明化后偏高 | 收紧摘要与上限 |

## 6. 交付物清单

1. 可运行 monorepo（dev 一键 / 生产 build + 托管）
2. Docker Compose 部署件（`app` + `pgvector/pgvector:pg16` db）+ `nginx.host.conf` + `.env.example`
3. SQLite → PostgreSQL 一次性迁移脚本；`docs/` 文档随实现同步修订（§12 核对结果、调研源适配器速查；RAG 链路见技术架构 §4.4 与 `.trellis/spec/server/backend/rag-guidelines.md`）
4. README（部署/数据源与合规声明/成本说明/安全说明/截图）+ LICENSE + CI
