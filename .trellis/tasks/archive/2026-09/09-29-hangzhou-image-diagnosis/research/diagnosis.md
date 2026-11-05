# 杭州三日游配图链路排查

调查日期：2026-09-29。状态：证据已整理，待用户审阅；未修改业务代码、业务数据、图片，未提交、未归档。

## 结论

指定行程 `0552c0b3-6446-48b9-bf4b-9a11699ce669`（杭州湖山三日慢游）图片少是多层原因叠加：

1. **已复现的缓存缺陷**：本地封面查询缓存只包含第一个候选，后续候选查不到图。相同缺陷还存在于维基配图需要的库内坐标查询、已缓存高德图片查询。
2. **已复现的开发环境媒体路由缺陷**：5173 的 `/media` 返回 HTML，8787 同路径返回 WebP。即使成功选中本地图，开发页面也无法显示。
3. **上游覆盖瓶颈**：杭州 424 张风景图仅 91 张绑定地点；333 张未绑定，其中 304 张来自多地点笔记。默认每地点导出 1 张，最终本地导出 34 张、库内有效关联 33 个地点。
4. **当前行程的本地覆盖只有 2/12**：现有导出图只能对应灵隐寺、虎跑公园。大量图片对应其他景点，不能拿任意杭州图片替代具体景点。
5. **旧行程保存的是生成时的封面快照**：刷新页面或重导地点库不会自动重算 `Trip.overview[].coverUrl`。

## 1. 指定行程的实际数据

- 生成时间：2026-09-29 20:05:12（香港时间）。
- 3 天、12 个活动、12 个调研候选，均为 attraction。
- `overview` 只有 3 个 `coverUrl`：断桥残雪来自 Wikimedia，灵隐寺和西溪湿地来自 Pexels。
- 小红书本地封面 0 个，高德封面 0 个，其余 9 个候选没有封面 URL。
- 活动与 overview 的 12 个名字一一对应，此例不是前端名称关联失败。
- “有 URL”不等于浏览器一定加载成功；本次未验证这 3 条外链的浏览器加载结果。

| 天数 | 活动 | 当前保存的图源 | 库内本地封面 |
| --- | --- | --- | --- |
| 1 | 灵隐寺 | Pexels | 有，但未被使用 |
| 1 | 飞来峰景区 | 无 | 无 |
| 1 | 苏堤春晓 | 无 | 无 |
| 1 | 三潭印月 | 无 | 无 |
| 2 | 虎跑公园 | 无 | 有，但未被使用 |
| 2 | 六和塔 | 无 | 无 |
| 2 | 九溪 | 无 | 无 |
| 2 | 花港观鱼 | 无 | 无 |
| 3 | 断桥残雪 | Wikimedia | 无 |
| 3 | 白堤 | 无 | 无 |
| 3 | 中国京杭大运河博物馆 | 无 | 无 |
| 3 | 西溪湿地 | Pexels | 无 |

数据库中已有且文件存在的两张封面：

```text
灵隐寺   xhs/杭州/56e268b7cdcca76052bd6359c8ffb278/00.webp
虎跑公园 xhs/杭州/89a1b6c43752013aac4b68bcafe8a7cf/00.webp
```

生成调研日志 job：`f679e135-49c6-4b08-92a6-376c8abb0ade`。

日志里的 add_candidate 顺序是：断桥残雪 → 白堤 → 苏堤春晓 → 花港观鱼 → 三潭印月 → 灵隐寺 → 飞来峰景区 → 西溪湿地 → 九溪 → 虎跑公园 → 六和塔 → 中国京杭大运河博物馆。它与最终每天的活动顺序不同，缓存受调研添加顺序影响。

该轮 `search_pois` 的结果是“没有找到相关地点（天地图数据源不可用、未开通搜索权限、已达调用上限或无结果）”。这个统一提示不能进一步判定天地图具体失败原因，但可以确认本次没有可供配图复用的搜索坐标。

## 2. 下游当前配图逻辑

入口：`apps/server/src/generation/tools/researchTools.ts:100` 的 `resolveCover`，由 `add_candidate` 调用。

```text
仅 attraction 自动配图（忽略模型传入的 coverUrl）
  → canonical_places.payload.coverImage + MEDIA_BASE_URL
  → Pexels 名称检索
  → canonical_places.payload.amapPhoto
  → 高德 POI 图片实时查询（命中后回写 amapPhoto）
  → 中文维基检索 + 坐标距离校验
  → 留空
  → ResearchPoi.coverUrl
  → Trip.overview（生成结束持久化）
  → 前端按活动名称匹配 overview
  → ActivityCard / PoiCover
```

- 本地库查询按 `city = $1` 精确限定城市，然后通过名称规范化和 `payload.aliases` 查找。名称规范化只剥特定机构后缀，不做任意模糊匹配、父景点继承或图片语义搜索。
- “西湖”有本地图，不会自动分给断桥、白堤、苏堤、花港观鱼、三潭印月。这些子景点也不是应当互相合并的别名。
- food / hotel 当前不走自动封面解析，即使上游给餐厅或酒店导出了风景照片也不会在此自动使用。本行程均为 attraction，所以不是此次的直接原因。
- Pexels 用地点名查询，要求照片 alt / URL slug 包含规范化地名或核心词；高德有名称和 POI 类型闸门；维基需要坐标且图片词条距离不超过 2 km。
- Pexels 每任务最多 8 次新查询、进程每小时 180 次；高德图片每任务最多 3 次尝试，另受服务预算约束；维基每任务最多 8 次查询流程，每个流程可能含两次 HTTP。三个来源均有 24 小时进程缓存，成功查询的“无图”结果也缓存。
- 这些限制使后续候选不能保证逐个尝试所有来源；本次没有逐来源完整诊断日志，不能把每个空图都归因为配额耗尽。
- 后端返回第一个有效格式的 URL 就停止，不检测浏览器端解码；前端失败后隐藏图片，不继续请求下一图源。

关键代码：

- `apps/server/src/generation/tools/researchTools.ts:114`：实际来源顺序。
- `apps/server/src/generation/tools/researchTools.ts:316`：仅 attraction 配图。
- `apps/server/src/generation/scheduling/placeFacts.ts:171`：城市、名称、别名和事实合并。
- `apps/server/src/lib/placeKey.ts:20`：名称规范化。
- `apps/server/src/integrations/pexels/cover.ts:21`、`apps/server/src/integrations/amap/poiPhotos.ts:20`、`apps/server/src/integrations/wikimedia/cover.ts:18`：请求上限。
- `apps/server/src/generation/orchestrator.ts:509`：保存 overview。
- `apps/web/src/lib/tripDerive.ts:29`：活动关联候选。
- `apps/web/src/components/editor/ActivityCard.tsx:28`、`apps/web/src/components/PoiCard.tsx:20`：显示条件和失败处理。

部分注释仍写“Pexels 第一优先”“仅三城市”“库内无封面列”，已经落后于实际实现。上述顺序以执行代码为准。

## 3. 已复现缺陷：只缓存第一个候选

`apps/server/src/generation/storedCover.ts:24`：

```ts
let pending: ReturnType<typeof loadPlaceFacts> | null = null;
return async (name) => {
  pending ??= loadPlaceFacts([name], city);
  const hit = (await pending).get(name);
  return hit?.coverImage ? mediaUrl(hit.coverImage) : null;
};
```

`loadPlaceFacts` 虽然 SQL 拉取全城，但返回前只遍历参数 `names`，见 `placeFacts.ts:211`。因此首轮返回的 Map 仅有“断桥残雪”。后面用灵隐寺、虎跑公园去取同一个 Map 永远取不到。

复现方法：读取当前 TS 源码，用 TypeScript 转译执行，注入已开启 `BEGIN READ ONLY` 的 PG 客户端及普通媒体前缀。没有导入会执行迁移的 `db/client`，没有调用任何外部图源。

| 调用方式 | 断桥残雪 | 灵隐寺 | 虎跑公园 |
| --- | --- | --- | --- |
| 同一 lookup 按本次 12 个候选顺序调用 | null | null | null |
| 为每个地点单独创建 lookup | null | 本地 URL | 本地 URL |
| 一次 loadPlaceFacts 传全部 12 个名字 | 无封面，有坐标 | 有封面、有坐标 | 有封面、有坐标 |

同类代码还存在于：

- `apps/server/src/generation/orchestrator.ts:53` 的 `cityPointLookup`：12 个地点实际都有库内坐标，复现中仅第一个返回坐标，其后 11 个返回 null。本次 search_pois 没有坐标，因而那些需要继续走维基的后续候选会在“无坐标”处提前返回。
- `apps/server/src/generation/storedCover.ts:38` 的 `createStoredAmapPhotoLookup`：注入两个都有 amapPhoto 的最小样本，首个返回 URL、第二个返回 null。杭州当前 amapPhoto 为 0，这一项属于同类潜在缺陷，不是本次漏用现有高德缓存的证据。

建议统一抽出“全城事实索引”缓存，由三个 lookup 共享，并按名称规范化/别名查询；或者先改成按名称缓存 Promise，再按性能需求优化。回归验证需覆盖同城多个名称连续调用，以及第一个名称无图/无匹配的情况。

## 4. 已复现缺陷：5173 没有媒体代理

环境未配置 `MEDIA_BASE_URL`，使用默认 `/media`。后端已经注册静态媒体目录，`apps/server/src/index.ts:77`。

`apps/web/vite.config.ts:10` 只代理 `/api`，没有代理 `/media`。

同一个已存在的湘湖 WebP 请求实测：

| 地址 | HTTP 状态 | Content-Type | 响应字节 |
| --- | --- | --- | --- |
| `http://localhost:5173/media/xhs/杭州/5ea439f490e5f4ab5c6bfb70bcbb33ed/00.webp` | 200 | text/html | 700 |
| `http://localhost:8787/media/xhs/杭州/5ea439f490e5f4ab5c6bfb70bcbb33ed/00.webp` | 200 | image/webp | 146868 |

5173 返回的是 SPA 页面。不能仅看 HTTP 200 判断图片可用，需检查 Content-Type 或浏览器图片解码。

本行程目前没有任何本地 URL，所以该问题并非造成现有 9 个空 coverUrl 的原因；它是修复缓存后仍会阻止本地图显示的独立缺陷，需同时解决。

建议在 Vite 给 `/media` 加与 `/api` 一致的代理；生产部署另验证媒体路由，不应以更改每张图的绝对地址来掩盖开发路由问题。

## 5. 上游实际链路与数据损耗

当前网页图片任务走 `scripts/extract_note_images.py` → `app/vision/pipeline.py`，不是只走旧的 `fetch_scenery_images.py`。

### 当前统一图片步骤

1. 采集笔记、提取 `place_mention`，sync 建立 `canonical_place`。
2. 需要时刷新小红书图片签名 URL，下载每篇前 `vision_max_images_per_note` 张，当前未覆盖配置，默认 6。
3. 本地 CLIP（ViT-B-32）分类：scenery 存盘和 note_image；text_card / collage / map 交视觉模型抽文字；food / person / interior 丢弃。
4. 单篇按 CLIP 分取风景图，默认累计最多 5 张，已有图会占用该预算。旧脚本默认每篇 3 张，按图片顺序选择风景图。
5. **只有笔记恰好提到一个规范化地点时，才填 canonical_place_id**。多地点笔记即使保存了清晰实拍，关联仍为空。

CLIP 在这里判断“是否像风景”，并不识别“这张照片具体拍的是哪个景点”。现有 VLM 主要从攻略图抽文字，也没有把多地点笔记里的每张风景图归属到具体景点。

### 杭州数据漏斗

| 层级 | 实际数量 | 说明 |
| --- | ---: | --- |
| raw_note | 235 篇 | 状态均 EXTRACTED |
| note_image | 456 张 | 源文件全部存在 |
| 仍分类为 scenery | 424 张 | 其余为 collage 23、interior 6、text_card 3，旧图复核改标后文件保留 |
| scenery 且已关联地点 | 91 张 | 覆盖 34 个上游地点 |
| scenery 但未关联地点 | 333 张 | 占风景图 78.5% |
| 未关联：多地点笔记 | 304 张 | 113 篇笔记 |
| 未关联：无地点提及 | 29 张 | 12 篇笔记 |
| 导出 manifest / 下游杭州媒体目录 | 34 张 | 34 个地点，各 1 张；导出文件全部存在 |
| 下游 payload.coverImage | 33 个地点 | source=xhs 31、goldset 2 |
| 下游杭州地点总数 | 670 个 | source=xhs 661、goldset 9，本地图覆盖约 4.9% |
| 此次 12 景点与本地封面的交集 | 2 个 | 灵隐寺、虎跑公园 |

统一步骤的 `img_analysis_at` 在杭州只有 12 篇非空、`img_analysis` 为 6 篇非空；旧脚本产生的风景图不靠这个标记，因此不能据此认定其余 223 篇没有下载过图片。

多地点笔记中确实存在未绑定风景图，例如提及花港观鱼的笔记合计有 41 张未绑定图、三潭印月 20 张、九溪 17 张。这些数字是“相关笔记中的图”，不是经识别确认属于相应景点的图，同一图片可被多个地点统计，不能直接拿来绑定。

### 导出、入库规则

- `scripts/export_place_images.py:52`：只选 scenery 且有地点关联的记录，按笔记收藏数 → 点赞数 → CLIP 分 → 记录 ID 排序。
- 默认每地点 1 张；以 `sha256(city + placeName)[:32]` 对齐下游 ID。
- 缩至最长边 1024，WebP quality=80，写到 `tripweaver/data/media/xhs/城市/地点ID/00.webp`，同时输出 manifest。
- `seed-xhs-place-images.ts` 仅把 key 写入已存在地点的 `payload.coverImage`，不写图片二进制，不扫描图片内容，不更新旧行程。
- 杭州图片导出日期 2026-09-27，导入时间 2026-09-27 22:20:32，早于本行程生成。因此不是“这次生成时图片还没导入”的正常时间差。
- 34 张只有 33 个有效下游地点：缺的是“梦溪苑”。上游它 `is_active=false`、`geo_status=unresolvable`，没有进入地点导出，但图片导出没有相同过滤，仍生成了图片和 manifest 条目。图片导入日志的 row_count 记录 manifest 条目数 34，不等于 UPDATE 成功 34 行。
- 命令行 `export_and_embed.ps1` 需显式传 `-WithImages`；当前网页 `job_export_embed` 默认 `with_images=true`。两种入口不能混为“默认都不导图片”。普通仅导出地点 JSON 的入口不导图片。

## 6. 其他可见风险（不是本次主因）

1. **重导地点可能清掉图片字段**：`seed-xhs-places.ts:154` 在相同 source 分支以 `EXCLUDED.payload` 重建 payload，只单独保留部分分数字段。xhs 地点重新导入但不跟着导图片时，coverImage / amapPhoto 可能丢失。当前杭州仍有 33 个 coverImage，不是此次零本地图的主因。
2. **多图导出与单图导入不一致**：上游支持 `--max-per-place 2`，但下游在 `seed-xhs-place-images.ts:87` 用 `Map.set(placeId, entry)`，同地点最后一张覆盖前一张。增加导出数量不会增加卡片图库，还可能用次选覆盖首选。本批每地点 1 张，不触发此问题。
3. **导出过滤不一致**：图片导出缺少地点导出的 active、坐标、summary 等条件，已产生梦溪苑孤立媒体。应对齐可消费地点集合，并分别统计计划、实际导出、实际入库数。
4. **现有测试缺口**：`storedCover.test.ts` 覆盖 URL 拼接和空城市，但没有同城两个不同候选连续调用，所以未发现缓存只记首个名称的问题。

## 7. 建议顺序与预期效果

### 第一批：恢复已有图片的使用链路

- 同时修复三个 lookup 的缓存边界。
- 补 `/media` 的 Vite 代理，并检查实际图片类型和解码。
- 验证灵隐寺、虎跑公园在同一次生成内都能命中本地图；验证后续景点能取到库内坐标。
- 为指定旧行程提供只更新封面字段的补图方式，保留日期、活动、顺序等行程内容。不要要求用户仅刷新页面期待快照自动变化。

仅恢复现有本地覆盖，能把灵隐寺改用本地图，并给虎跑公园补图；剩余 10 个活动没有对应本地封面，无法保证一次全部补齐。修复坐标兜底可能提高维基命中，但需要实际验证。

### 第二批：扩大可准确使用的上游覆盖

- 优先针对本次无图的热门景点做单景点素材补齐；这比盲目增加全城笔记数量更直接。
- 对现有 304 张多地点笔记风景图增加图片级地点归属：限定候选地点、结合图片 OCR/描述/视觉线索、保留置信度和证据，低置信结果人工确认或保持未绑定。
- 只重跑旧 `--relink` 不能解决这批主要缺口：它仍要求单地点笔记。本次统计没有“恰好一个提及但尚未绑定”的风景图。
- 修复重导字段保留、导出集合对齐；明确单封面与多图模型。
- 增加按城市/行程的覆盖统计，以及每个候选按图源的 miss / budget / failure / selected 诊断，避免都表现为静默 null。

## 8. 调查方法与边界

- 读取两个项目实现、上游 manifest、媒体文件存在性。
- 对两个 PostgreSQL 数据库的业务数据均使用 `BEGIN READ ONLY`，查询后 ROLLBACK；不读取或输出账户凭据。
- 从指定 trip 及生成日志核对候选、来源和添加顺序。
- 用源码转译 + 注入只读依赖重现多名称查询，未运行数据库启动迁移或生成任务。
- 本地 HTTP 比较 5173 / 8787 的同一个媒体地址。
- 内置浏览器本会话不可用，所以未进行界面截图，也未宣称 3 条外链均可加载。
- 未重新采集、重导、修改行程或尝试修复；本报告用于选择后续修复范围。
