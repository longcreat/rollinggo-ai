# Replace XHS research with Amap + web search, add trip overview page

## Goal

小红书抓取风控严重、不可持续。将调研 Agent 的数据来源替换为「高德 POI API（结构化底座）+ Web 搜索 API（攻略语义层）」双层方案，模型知识兜底；同时把调研产物从纯文本摘要升级为**结构化 POI 候选池**，前端新增**行程概览页**：按景点/美食/住宿分类展示卡片（预览图、简介、**是否需要预约**徽章、来源链接）。

## What I already know

**来自需求讨论（已确认方向）**
- 双层数据源：高德搜索POI 2.0（名称/坐标/评分/人均/营业时间/图片）+ Web 搜索 API（玩法/避雷/预约政策，带来源链接）
- 「是否需要预约」无公开 API，采用：搜索抽取 + 三态展示（需预约/无需/未知）+ 来源链接 + 「以官方为准」免责 + 审校复核
- 高德协议 3.5 不得存储/缓存数据与图片 → 图片热链不转存；候选池仅落名称+短摘要+来源（与 XHS 纪律同构）
- 行程活动坐标继续走 OSM Nominatim（geoTools 不动），高德仅作调研候选源

**来自代码勘察**
- `ContentSource` 抽象（串行限速/TTL缓存/任务级上限/Null降级/selfCheck）是新数据源的现成骨架
- 调研产物 `research.summary`（≤2000字纯文本）注入编排 Agent 的 userPrompt；需升级为结构化池 + 摘要并存
- `trips.data` 全量 JSON 是唯一事实源 → 概览池挂 Trip JSON，无需库表迁移；TypeBox schema 加**可选字段**保证旧行程兼容
- `SourceNote {title,url}` 类型现成；`TripMeta {usedXhs, reviewNotes}` 需扩展
- SSE 事件体系（`jobManager.emit`）可加 `candidate` 事件让概览卡片实时长出
- 设置页有数据源状态展示（`routes/settings.ts` → selfCheck），新源需接入
- `quotaService` 的 XHS 全站日额度模式可泛化给搜索 API

## Assumptions (temporary)

- 站长愿意注册高德开放平台个人/企业 Key（免费额度：搜索 5,000 次/月 个人认证）
- 搜索 API 由站点级配置（不做用户 BYO 搜索 Key）
- 概览页为生成产物的一部分（随 Trip 持久化），非独立探索功能

## Open Questions

- [x] MVP 范围：**基线 + 预约种子表**（编辑器 POI 补全、概览页勾选重排 → Out of Scope，2026-07-09 已确认）
- [x] 搜索 API 供应商策略：**仅 LangSearch**（免费），适配器默认端点可被 `SEARCH_API_BASE_URL` 覆盖以兼容博查同族 schema（2026-07-09 已确认）
- [x] XHS 集成去留：**彻底移除**（README 卖点改写为「高德+全网搜索调研」；旧行程 usedXhs 只读兼容，2026-07-09 已确认）
- [x] 概览页形态：**PlannerPage 生成中 SSE 实时长卡片 + TripEditorPage 新增「行程概览」区块**（数据读 Trip JSON）

## Requirements (evolving)

- 调研 Agent 工具组替换：`search_pois`（高德，按类目搜景点/美食/住宿）+ `search_web`（搜索 API）+ `add_candidate`（写入结构化候选池，闭包持有，R8 纪律）+ `submit_research`（收尾摘要）
- 候选池类型（TypeBox，shared）：`ResearchPoi { id, name, category: attraction|food|hotel, coverUrl?, intro, reservation: required|none|unknown, reservationNote?, sourceLinks: SourceNote[] }`（**卡片不含评分/人均/营业时间**——2026-07-09 确认裁剪；高德返回的这些字段仅作为调研/编排工具输出文本供 Agent 参考，不入池不落库）
- 概览池随 Trip JSON 持久化（可选字段，旧数据兼容）；编排 Agent 可按 poiId 引用候选生成活动
- 降级链完整：高德+搜索 → 仅高德 → 仅搜索 → 纯模型知识（复用 Null 源模式，任一源缺失不断服，前端明示所用数据源）
- 新源沿用 `ContentSource` 骨架：串行限速、TTL 缓存、任务级调用上限、全站日额度闸门、selfCheck 接入设置页
- env 新增：`AMAP_KEY`、`SEARCH_API_KEY`（LangSearch，免费申请）、`SEARCH_API_BASE_URL`（可选，默认 `https://api.langsearch.com`；博查同族 schema，改 URL+Key 即可切换，零代码改动）、`SEARCH_DAILY_BUDGET`
- 高德图片热链展示不转存，`onerror` 占位图；候选落库仅短摘要+来源链接
- **预约种子表**：静态 JSON（~50 条全国热门需预约景点：名称/别名/预约渠道说明/来源链接，随仓库维护）；候选命中种子表时预约字段直接置信，未命中才走搜索抽取
- `generations` 用量列泛化（amapCalls/searchCalls），成本可审计
- **XHS 彻底移除**：删除 `integrations/xhs/`、`xhsTools.ts`、`XHS_*` env、docker-compose `xiaohongshu-mcp` 服务、`scripts/smoke-mcp.mjs`、设置页 XHS 状态；README「小红书数据源」章节与产品叙事改写；`ContentSource` 骨架（串行限速/TTL/任务上限/Null 降级）迁移为新源基座
- 兼容策略：`trips.usedXhs` 列与 `TripMeta.usedXhs` 保留只读兼容（旧行程徽章正常显示），新生成恒为 false；`TripMeta` 新增可选 `dataSources?: ('amap'|'websearch')[]`
- 概览页前端：PlannerPage 生成过程中经 SSE `candidate` 事件实时渲染候选卡片；TripEditorPage 新增「行程概览」区块（景点/美食/住宿三类卡片栅格），从 Trip JSON 读取

## Acceptance Criteria (evolving)

- [ ] 配齐 AMAP_KEY + 搜索 Key 时：生成流程产出含三类候选的概览池，卡片含预览图/简介/预约徽章/来源链接
- [ ] 任一数据源缺失/超额时自动降级且生成不失败，行程标注实际所用数据源
- [ ] 预约徽章三态正确渲染，「需预约/未知」附来源链接或「以官方为准」提示
- [ ] 旧行程（无概览池字段 / usedXhs=true）打开编辑器不报错，历史徽章正常
- [ ] 全库无 `XHS_MCP_URL` / `xiaohongshu-mcp` 残留引用（含 docker-compose、README、.env.example）
- [ ] `npm run typecheck` 三包通过；`verify-c2.mjs` 端到端（mock LLM）通过并覆盖新工具面
- [ ] README/.env.example 更新（高德 Key 申请指引、搜索供应商对比、配额说明）

## Definition of Done (team quality bar)

- 单测/集成脚本更新（新数据源适配器 + 降级链）
- Lint / typecheck 全绿
- README、TECHNICAL_ARCHITECTURE §6/§12（数据源章节）同步更新
- 无破坏性 schema 变更（旧 Trip JSON 可读）

## Decision (ADR-lite)

**Context**：小红书抓取风控严重、账号纪律包袱重，调研数据源不可持续；同时需要把调研产物升级为可视化概览。
**Decision**（2026-07-09 与站长确认）：
1. 调研源 = 高德 POI 2.0（结构化底座）+ LangSearch Web Search（语义层；`SEARCH_API_BASE_URL` 可覆盖，博查同族 schema 零代码切换）+ 模型知识兜底
2. MVP 含预约种子表；编辑器 POI 补全、概览页勾选重排延后
3. XHS 集成彻底移除，README 产品叙事改写
**Consequences**：
- 免费额度内近零成本；LangSearch 无 SLA → 靠降级链兜底（缺搜索层 → 仅高德 → 纯模型）
- 高德协议 3.5 限制存储/缓存 → 图片热链不转存、候选仅短摘要落库；行程坐标仍走 Nominatim，规避条款与 GCJ-02 转换
- 失去 UGC 口碑独特性，换取稳定性与合规；未来可切博查或评估内容合作

## Out of Scope (explicit)

- 抓取任何 UGC 平台（小红书/抖音/大众点评）正文
- 预约系统对接/代预约
- 编辑器 `ActivityEditDialog` 的 POI 自动补全（未来演进，本期不做）
- 概览页勾选/剔除候选并触发重排（对话式改稿的前置，本期只读）
- 概览页进导出长图（本期不做，导出仍为行程本体）
- 用户自带搜索/地图 Key（BYO 仅限 LLM，维持现状）

## Technical Notes

- 高德协议红线与配额、搜索 API 价格、预约数据可得性结论：见 research/data-sources.md
- 每次生成外部调用成本估算：高德 3–6 次 + 搜索 4–8 次 ≈ ¥0–0.3
- 关键改造锚点：`contentSource.ts`（骨架复用）、`xhsTools.ts`（替换）、`orchestrator.ts`（阶段1产物）、`prompts.ts`（调研/编排提示词）、`schemas.ts`（ResearchPoi/TripMeta）、`PlannerPage`/`TripEditorPage`（概览 UI）、`settings.ts`（源状态）、`quotaService.ts`（额度泛化）

## Research References

- [`research/data-sources.md`](research/data-sources.md) — 高德字段/配额/协议红线、博查¥0.036/LangSearch免费、预约无公开API结论（2026-07-09 官方页面取证）
