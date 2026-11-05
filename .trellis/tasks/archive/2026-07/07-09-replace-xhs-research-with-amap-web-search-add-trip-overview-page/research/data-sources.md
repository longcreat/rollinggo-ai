# 调研数据源替换 — 外部数据源核查（2026-07-09）

> 取证方式：smart-search CLI（Tavily fetch）直接抓取官方页面，证据快照存于
> `C:/tmp/smart-search-evidence/20260709-tripweaver-poi/`（会话级，正式依据以下列 URL 为准）。

## 1. 高德 Web 服务 · 搜索POI 2.0（结构化底座，推荐主源）

- 文档：https://lbs.amap.com/api/webservice/guide/api-advanced/newpoisearch
- 能力（`show_fields` 按需返回，关键字/周边/多边形/ID 四种搜索共享同一字段表）：
  - `business`：`opentime_today` / `opentime_week`（营业时间）、`rating`（评分）、`cost`（人均消费）、`tel`、`business_area`
  - **`rating` 与 `cost` 仅在餐饮、酒店、景点、影院类 POI 返回** —— 恰好覆盖本项目三类候选
  - `photos`：`{title, url}[]` 官方图片下载链接
  - 基础字段：名称/类型/typecode/地址/经纬度（**GCJ-02 坐标系**）
- 配额（定价页 https://lbs.amap.com/upgrade ，新价 2025-05-20 起执行）：
  - 基础搜索服务（关键字/周边/多边形/ID/输入提示共享）：**个人认证 5,000 次/月**、企业认证 5 万次/月、企业+技术服务许可 50 万次/月；超量 ¥30/万次，不参与折扣
  - 基础 LBS 服务（地理编码/路径规划等）：个人认证 15 万次/月
- **协议红线**（服务协议 2025-12-03 版，https://lbs.amap.com/home/terms/ ）：
  - 3.5：只可用官方开放功能**展示**结果，**不得直接存储、缓存、抓取服务数据与图片**；脱离服务使用数据需工单咨询
  - 3.4：不得将服务内容用于**模型/算法训练及数据集构建**（检索-展示与 LLM 推理引用不属训练，但需注意措辞与用途）
  - 4.12.4：不得脱离本服务单独使用或展示相关内容
  - 3.2.5：非商业目的可提工单评估合作
- 设计含义：
  - 概览页图片**热链实时展示、不转存文件**；候选池落库仅保留名称 + 短摘要 + 来源标注（与现有小红书「短摘要+署名链接」纪律同构）
  - **行程活动坐标继续走 OSM Nominatim**（现有 `geoTools`），高德仅作调研候选源 → 同时绕开 GCJ-02 转换与 3.5 存储条款
  - 配额闸门复用 `quotaService` 的 XHS 日额度模式；README 提示站长做企业认证

## 2. Web 搜索 API（攻略语义层：玩法/避雷/预约政策）

| 供应商 | 端点 | 价格 | 备注 |
|---|---|---|---|
| 博查 Bocha | `POST https://api.bochaai.com/v1/web-search` | **¥0.036/次**；免费试用 1000 次/3 个月；AI Search ¥0.06/次（含百科/天气模态卡） | 价目：feishu wiki `JYSbwzdPIiFnz4kDYPXcHSDrnZb`；返回标题/链接/snippet/**summary**/站名/图标/时间 + 图片 |
| LangSearch | `POST https://api.langsearch.com/v1/web-search` | 官网声明 **Absolutely Free**（限流未明示，单源信息） | https://langsearch.com/ ；响应结构与博查同族（`freshness`/`summary`/`count`） |
| 智谱 Web Search API | 统一 API，引擎可选自研/搜狗/夸克 | 见 https://bigmodel.cn/pricing （本次未取到具体数字） | 文档：https://docs.bigmodel.cn/cn/guide/tools/web-search ；与 LLM 同供应商可少管一个 Key |

- 博查与 LangSearch 响应 schema 同族 → 一个适配器可覆盖两家（provider 可插拔的实现成本低）
- 每次生成约 4–8 次搜索调用 → 博查 ≈ ¥0.15–0.3/次生成；LangSearch/高德免费额度内 ≈ ¥0

## 3. 「是否需要预约」数据可得性（置信度：高）

- 高德 POI 字段表**无预约字段**（已核字段表全量）
- 携程开放平台（https://open.ctrip.com/ ，已核）为**分销返佣联盟**（拉客下单赚佣金），无数据 API；美团开放平台抓取失败未核，但同为交易分销定位（单源限制，注明）
- 结论：预约信息只存在于景区公众号公告 / OTA 详情页 → 唯一现实路径是 **搜索 API 抽取 + 来源链接 + 「以官方为准」免责 + 审校 Agent 复核**
- 增强手段：人工维护**热门预约景点种子表**（故宫/国博/莫高窟/陕历博等 ~50 条，变化慢、命中率高），静态 JSON 随仓库走

## 4. 现有代码映射（改造锚点）

- `apps/server/src/integrations/xhs/contentSource.ts`：`ContentSource` 接口 + 串行限速 + 24h TTL 缓存 + 任务级上限 + Null 降级 + `selfCheck` —— 新 Amap/Search 源直接沿用此骨架
- `apps/server/src/generation/tools/xhsTools.ts`：调研工具三件套（搜索/精读/提交），替换目标
- `apps/server/src/generation/orchestrator.ts`：`runGeneration` 三阶段流水线；research 产物目前为 ≤2000 字纯文本 `summary`
- `packages/shared/src/schemas.ts`：TypeBox schema 唯一事实源；`SourceNote = {title≤100, url≤300}` 现成可用；`TripMeta = {usedXhs, reviewNotes}` 需扩展（加可选字段保持旧数据兼容）
- `apps/server/src/db/schema.ts`：`trips.data` 全量 JSON 为唯一事实源 → 概览池挂进 Trip JSON 无需迁移；`generations.xhsCalls` 等用量列需泛化
- 前端：`PlannerPage`（生成进度，SSE）、`TripEditorPage` + `components/editor/*`（编辑器）、`GenerationTimeline`（时间线）——概览页新增于此两处
