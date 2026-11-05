# 地图服务商降级方案：可切换至天地图

## Goal

高德是目前唯一的地理数据提供方（POI 搜索 / 路径规划 / 地理编码）。高德 Key 不可用、额度耗尽或
服务不可达时，整条地理链路只能掉到 Nominatim + 启发式估算，行程质量塌陷。
本次新增天地图作为**站点级可切换的替代 provider**：通过环境变量手动选一家，切过去之后三块能力都走天地图。

## What I already know（代码核实，09-25）

高德在服务端的落点（`grep` 全覆盖）：

| 能力 | 文件 | 对外形状 |
|---|---|---|
| POI 搜索 | `apps/server/src/integrations/amap/poiSource.ts`（`AmapPoiSource` / `createPoiSource` / `resolvePoiSourceForUser`） | `PoiSource{ kind, searchPois(), selfCheck() }` |
| 路径规划 | `apps/server/src/integrations/amap/route.ts`（`routeEstimate` / `createRouteBreaker`） | `RouteEstimate{ durationMin, distanceM, polyline? }` |
| 地理编码 | `apps/server/src/integrations/amap/geocoder.ts`（`geocodeActivity` / `amapPoiLocate` / `amapGeocode`） | `GeocodedPlace{ lat, lng, adcode, origin }` |

其他已核实事实：

- 唯一消费方是 `apps/server/src/generation/geoPipeline.ts`（`createGeoSession` 持 `apiKey`）与
  `apps/server/src/generation/orchestrator.ts`（POI 源选择）；`apps/server/src/routes/settings.ts` 只做自检
- 地理链路**已有三层降级**：高德 → Nominatim（`apps/server/src/integrations/geocode.ts`，WGS-84→GCJ-02 转换）
  → 启发式（`apps/server/src/generation/legEstimator.ts`）；本次把天地图插在最前面，后两层原样保留
- 坐标契约：库内统一 **GCJ-02**（`activity.coordSystem = 'gcj02'`，`buildDraft.ts` L69 注释确认
  高德坐标与库内坐标同系，点状地标偏差 64~93m）
- `packages/shared/src/geo.ts` **只有正向** `wgs84ToGcj02`，**没有逆算法**
- 前端地图是 Leaflet + 高德瓦片（`apps/web/src/components/editor/MapView.tsx:159`），底图与库内 GCJ-02 自洽
- 天地图 API 事实见 `research/tianditu-api.md`（六类端点、返回格式、字段缺口、坐标系）

## Requirements（用户已拍板 09-25）

- **R1 站点级 provider 切换**：新增 `MAP_PROVIDER=amap|tianditu` 环境变量，手动选一家；不做自动回退
- **R2 三块能力全切**：POI 搜索、路径规划、地理编码在天地图下都有对应实现
- **R3 独立凭据与独立额度**：新增 `TIANDITU_KEY` / `TIANDITU_DAILY_BUDGET`，与高德额度互不影响
- **R4 公交（transit）接入**：额外接天地图 `/bus` 接口，不用 drive 近似、不直接掉启发式
- **R5 POI 接受部分字段**：天地图地名搜索缺评分/人均/营业时间/图片，留空即可，上层已有空值容忍
- **R6 自检可见服务商**：设置页自检卡片显示当前实际生效的服务商（高德 / 天地图 / 未配置）

## Decisions

- **provider 缺省判定（09-25）**：`MAP_PROVIDER` 未设置时按「`AMAP_KEY` 有值 → amap；否则 `TIANDITU_KEY`
  有值 → tianditu；都没有 → 现状 Null 降级」。存量部署不设这个变量，行为与今天完全一致。
- **显式冲突（09-25）**：`MAP_PROVIDER=tianditu` 但 `TIANDITU_KEY` 为空 → 走 Null 降级 +
  启动时一条 warn，**不回退到高德**（手动切换要可预测，静默双开会让额度与排查失控）。
- **坐标系（09-25）**：库内保持 GCJ-02 不变。出站调天地图前 `gcj02ToWgs84`，入站落库前
  `wgs84ToGcj02` 转回。**这是本任务最容易出错的地方**，转换必须收敛在天地图适配层内部，
  上层完全感知不到（`GeocodedPlace` / `RouteEstimate` 仍声明 GCJ-02）。
- **前端底图不动（09-25）**：provider 切到天地图后，前端仍是 Leaflet + 高德瓦片，配 GCJ-02 数据自洽。
  若把底图也换成天地图（WGS-84 瓦片），所有 marker 会偏移约 500m —— 故本次**明确不改前端底图**，
  并在 spec 里记下「底图与坐标契约必须同系」这条约束。
- **如实标注来源（09-25）**：`LEG_SOURCES` 增加 `'tianditu'`，`DATA_SOURCE_KINDS` 增加 `'tianditu'`。
  理由：spec《Tiered Estimators with Truthful Source Labeling》要求每个落库值标注来源、不允许把
  provider 数据与启发式混为一谈；复用 `'amap'` 会让「leg 来自高德」这个断言变成假的。
  连带要改的消费方只有 4 处（`geoPipeline` leg memo 判定、`eval/checks.ts` 的 `amapLegRatio`、
  `orchestrator` 的 banner 文案、`GenerationTimeline` 的文案），见 Technical Approach。
- **天地图公交时长（09-25）**：`/bus` 返回的是多段子路线，官方无总时长字段，需累加
  `segments[].segmentLine[].segmentTime`。**累加结果 ≤ 0 或非有限数时按失败处理，回落启发式**，
  绝不把异常值写进时间轴。
- **`adcode` 缺口（09-25）**：天地图地理编码不返回 adcode。`GeocodedPlace.adcode` 在天地图下回空串；
  transit 改走城市名（`/bus` 需要城市名，`form.destination` 已有），不再依赖 adcode 兜底。

## Out of Scope

- 自动降级（高德失败自动切天地图）—— 用户明确选手动切换
- 前端 Leaflet 底图切天地图瓦片（坐标系契约会破，见 Decisions）
- 个人天地图 Key 双轨（设置页自填 + 加密存储）—— 本次只做站点环境变量单轨
- 高德侧任何行为改动（额度、熔断、adcode 兜底在 `MAP_PROVIDER=amap` 下必须逐字不变）
- 骑行（天地图无对应接口，仍走启发式）

## Acceptance Criteria

- [ ] `MAP_PROVIDER=tianditu` + 有效 `TIANDITU_KEY`：地理编码、路径规划、POI 搜索、公交全部走天地图，
  `activity.coordSystem` 仍为 `'gcj02'`，落库坐标与高德模式同一量级（同地点偏差 < 100m）
- [ ] `MAP_PROVIDER=amap`（或不设 + 有 `AMAP_KEY`）：行为与改动前逐字一致，现有单测/验证脚本全绿
- [ ] `MAP_PROVIDER=tianditu` 但 `TIANDITU_KEY` 空：走 Null 降级、不静默回退高德、启动有 warn
- [ ] 天地图任一接口失败/超时/字段异常：静默降级到 Nominatim / 启发式，生成流程不因此失败
- [ ] 天地图 `/bus` 返回异常时长：该段 `source: 'heuristic'`，时间轴无负数/NaN
- [ ] `packages/shared` 的 `gcj02ToWgs84` 往返误差 < 1e-6 度（有单测）
- [ ] 设置页自检卡片显示当前生效服务商；`MAP_PROVIDER=tianditu` 时显示天地图自检结果
- [ ] 天地图额度耗尽时该任务不用天地图，且**不消耗**高德额度（两列独立计数）

## Technical Approach

### 新增

- `packages/shared/src/geo.ts`：新增 `gcj02ToWgs84(lat, lng)`（迭代逼近；境外矩形外原样返回，与
  `wgs84ToGcj02` 对称）；`packages/shared/src/index.ts` 导出
- `apps/server/src/integrations/tianditu/geo.ts`：`geocoder` 正/逆地理编码，出站 `gcj02ToWgs84`、
  入站 `wgs84ToGcj02`，返回与高德同形的 `{ lat, lng, adcode: '' , origin: 'tianditu' }`
- `apps/server/src/integrations/tianditu/route.ts`：`/drive` `/walk` `/bus`，XML 取值
  （`<distance>` km→m、`<duration>` 秒、`<routelatlon>` 折线复用现有 `downsamplePolyline`），
  自带 `createRouteBreaker` 同构的任务级熔断
- `apps/server/src/integrations/tianditu/poiSource.ts`：`/v2/search`，实现现有 `PoiSource` 接口
  （`kind: 'tianditu'`），缺的字段填空串/空数组
- `apps/server/src/integrations/geoProvider.ts`：provider 选择门面，按 `env.mapProvider` 决定
  `geocodeActivity` / `routeEstimate` / `createRouteBreaker` / `createPoiSource` 走哪套实现；
  上层只认这个门面

### 改动

- `apps/server/src/env.ts`：`mapProvider`、`tiandituKey`、`tiandituDailyBudget`（+ 缺 Key 时的启动 warn）
- `apps/server/src/generation/geoPipeline.ts`：改用门面；`leg.source === 'amap'` → `!== 'heuristic'`
- `apps/server/src/generation/orchestrator.ts`：POI 源与 banner 文案按 `poi.source.kind` 生成
- `packages/shared/src/constants.ts`：`LEG_SOURCES` / `DATA_SOURCE_KINDS` 各加 `'tianditu'`
- `apps/web/src/components/GenerationTimeline.tsx`：`sources[0] === 'amap'` 的文案分支覆盖天地图
- `apps/server/src/services/quotaService.ts`：`tiandituBudgetRemaining()`，聚合新列
- `apps/server/src/db/schema.ts` + `apps/server/src/db/migrate.ts`：`generations.tianditu_calls`
- `apps/server/src/routes/settings.ts`：`sources-status` 返回值改为 provider 感知
  （`SourceStatus` 形状不变，`message` 带服务商名；前端 `apps/web/src/api/hooks.ts` 的 `amap` 字段
  改名为 `geo`）
- `.env.example` / `README.md`：补 `MAP_PROVIDER` / `TIANDITU_KEY` / `TIANDITU_DAILY_BUDGET`
- `.trellis/spec/server/backend/integration-guidelines.md`：补「provider 切换 + 坐标系契约 + 底图必须同系」

### 复用不改

`apps/server/src/lib/serialQueue.ts`、`apps/server/src/lib/ttlCache.ts`、`geoSanity.ts`、
`legEstimator.ts`、`integrations/geocode.ts`（Nominatim 仍是最末位兜底）—— 天地图适配层照抄
高德的四道闸（串行限速 / 24h 缓存 / 任务级上限 / Null 降级）。

## Implementation Plan

- PR1：`gcj02ToWgs84` + 单测；`env.ts` 三个配置项 → 验证：`npm run typecheck` + 坐标往返单测
- PR2：天地图地理编码适配层 + 实测清单 1/5 项 → 验证：真实 tk 打通，坐标与高德同量级
- PR3：天地图路径规划（drive/walk）+ XML 解析 + 熔断 + 折线抽稀 → 验证：单测覆盖解析与异常降级
- PR4：天地图公交（`/bus`）→ 验证：实测时长合理，异常回落启发式
- PR5：天地图 POI 搜索（`/v2/search`）→ 验证：权限开通后取回地点；未开通时 Null 降级
- PR6：`geoProvider.ts` 门面 + `geoPipeline` / `orchestrator` / `quotaService` / schema 接线
  → 验证：`MAP_PROVIDER` 两值各跑一遍现有验证脚本（`verify-c2` / `verify-c3`）
- PR7：前端自检卡片 + 来源标注文案 + `.env.example` / `README` → 验证：`verify-amap-settings` 全过
- PR8：spec 同步 + 收尾

## Open Questions

- 无（全部拍板）。实现阶段唯一不确定项是天地图侧实测结果（见 research 第 6 节待实测清单），
  每一项都已有明确退路。

## 实测修正（09-25，实现阶段回填）

真实 tk 联调推翻了 3 处基于二手资料的设计假设，均已修正（详见 `research/tianditu-api.md`）：

1. **`/walk` 与 `/bus` 端点不存在**（实测 404）。公交 = `/transit`。而**步行没有可用替代**：
   文档称 `style=3` 是步行，实测证明它是「驾车最短路线」（0.9km/97s、17.3km/27min，都是驾车速度）。
   曾接到 `/drive?style=3`，会让步行段拿到驾车时长（15km 段少算 10 倍）且能通过速度闸门 —— 已移除，
   步行与骑行一并回 null 走启发式。端点列举的问题推翻了下面 Technical Approach 的原文，
   但正交于 PRD 的能力决策：R4「接公交接口」依然成立，只是端点名不同。
2. **公交入参整套写错**：官方文档（`/server/bus.html`）的可用示例是
   `/transit?type=busline&postStr={"startposition":..,"endposition":..,"linetype":..}`，
   而原实现发了 `type=search` + `{orig,dest,city}` —— 端点名、`type` 值、postStr 键名三处都错。
   库里由此还多了一层无用的「目的地城市名绑定」管道（公交并不需要城市参数），一并删掉。
3. **`/v2/search` 的 `queryType=1` 强制要求 `mapBound`**（实测 `infocode 2003`）。原计划「类目/关键词
   搜索」不可直接调用，现由适配器自行解析城市中心、取 ±0.5° 作为城市级视野（按 region 24h 缓存）。
   官方文档里更贴近语义的 `specifyAdminCode`（9 位国标码）用不了 —— 天地图 geocoder 不返回任何
   行政区划码，仓内也没有城市→国标码表。
4. **HTTP 状态码不能只回状态码**：`400+308011`（参数或 tk 长度不合规）/ `400+2003`（缺必填参数）/
   `403+301001`（非法 key）/ `418`（CloudWAF 拦截）四类语义完全不同，而设置页卡片直接面向用户 —— 
   新增 `tianditu/http.ts` 的 `describeHttpFailure` 把响应体带进报错。
5. **公开文档页本身也是服务端渲染的**（`Invoke-WebRequest` 直接 GET 就能拿到正文，不需要浏览器），
   且文档页名与 API 端点名不一致：`/server/bus.html` 里的端点是 `/transit`，`/server/search.html`
   里的 `/search` 已下线（实际是 `/v2/search`）。**以实测端点为准。**

骑行（`cycle`）确认无任何端点（`/bicycle`、`/bike`、`/cycling`、`/ride` 均 404），维持「回启发式」决策不变。

6. **公交响应是 JSON（已用真实 tk 实测），但层级与单位全是坑**：
   `results[].lines[]` 是**最多 5 条互斥的完整候选方案**（不是串联段），全累加会得到 53km/4 分钟；
   `segments[].segmentLine[]` 是同一段的**平行备选**（实测「特12外」与「44外」并列），全取会让时长翻倍；
   `segmentTime` 单位是**分钟**（文档未写，按秒解读会得到 804 km/h）、`segmentDistance` 是**米**；
   负值表示该段不可用（实测首选的地铁方案全为负值）。
   原实现三处全错 → 速度闸门拦下 → **公交段 100% 静默降级成估算**，正是用户观察到的现象。
7. **`/drive` 与 `/transit` 的响应格式不同**（前者 XML、后者 JSON），单位也不同；实测样本：
   驾车 18.84km/20min、公交 14.88km/44min、东直门→西直门公交 45min/9029m，均落在合理速度区间。
   另：无延迟连发会触发 **429** 限流，350ms 串行队列实测安全。

## 方案变更（09-25 二次拍板）：从「站点级单选」改为「两家互补」

初版把地图能力做成 `MAP_PROVIDER` 单轨切换（选了天地图就整条链走天地图）。实测后推翻：

**实测依据**

1. 高德 `v5/place/text` 配额**已达上限**：`{"status":"0","info":"USER_DAILY_QUERY_OVER_LIMIT","infocode":"10044"}`，
   而同一时刻 `v3/geocode/geo` 返回 `OK` —— **配额按接口独立计算**。
2. 而 `v5/place/text` 被**两个用途共享**：地理编码主路径（`amapPoiLocate`）+ POI 搜索（`search_pois`）
   → 两者互相挤占。这正是「POI 搜索经常拿不到结果」的根因。
3. 天地图 `/geocoder` 用真实 tk 实测 **8/8 命中**，与高德 v3 geocode 相比中位差 422 米
   （点状地标 67~139 米；大景区因取点不同达 1~2km）—— 对行程规划足够。

**新分工（用户拍板）**

| 能力 | 主用 | 降级 |
|---|---|---|
| POI 搜索 `search_pois` | **天地图**（固定，与 Key 无关） | 空结果 → 模型知识，**不回落高德** |
| 路线规划 | **高德**（有 `AMAP_KEY` 就用） | 天地图（缺高德 Key；步行/骑行再降启发式） |
| 地理编码 | **高德**（有 `AMAP_KEY` 就用） | 天地图 → Nominatim |
| 前端底图 | 高德瓦片（不变） | — |
| 封面图 | **不做**，前端留空 | — |

**连带决策**

1. `MAP_PROVIDER` **废弃** —— 两家互补，按「配了哪个 Key」自动决策；README/env 说明改为「两个 Key 都要配」。
2. 封面图暂不做：POI 搜索被省掉后 `photos` 这条链一起消失；天地图 `pois[]` 本来就没有图片字段。
   `add_candidate` 的 `coverUrl` 参数与 prompt 引导一并移除（字段保留以兼容存量数据）。
3. **POI 搜索的调用条件收紧**：库里有坐标就直接用、不再实时检索 —— 这已是现状（`buildDraft` 用
   `canonical_places` 兜底并标 `coordSource='geocoded'`，`geoPipeline` 的 pending 过滤会跳过），
   本变更只是把它写进契约。覆盖充分的城市里地理编码实际只有 1~3 次/生成（城市中心 + 少数落库缺失）。
4. **副产物**：`openTime` 自动回填从此失效（天地图无营业时间字段），闭馆日检测只剩
   `research_evidence` 文本挖掘这一条路径。
5. **副产物**：库坐标路径的活动拿不到 adcode（`buildDraft` 取出后被丢弃）→ 高德 transit 只能走
   目的地城市级兜底。本变更顺带修复。
