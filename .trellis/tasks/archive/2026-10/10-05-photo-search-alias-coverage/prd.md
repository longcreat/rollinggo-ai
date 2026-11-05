# 图库搜索中英别名覆盖全部生效城市

## Goal

`stockPhotoSupport.ts` 的 `cityAliases` / `aliases` 只覆盖北京和杭州两城的景点英文名。其余城市把纯中文查询词（`${景点} ${城市}`）直接发给 Pexels / Pixabay / Unsplash —— 这些库以英文 `alt`/slug 为主，模糊匹配返回的是**其他城市的同类景观**（实测济南 26 张 Pexels 候选全部被判 `identity=mismatch`：台湾日月潭、南京玄武湖、韩国水原华城、西班牙雪地公路……）。

本任务把别名表补到全部 11 个生效城市，让搜索词变成英文地标名。

## What I already know

- 生效城市 = 冻结知识库 12 城去掉云南，与 `eval/scenarios.ts` 的 `MATRIX_CITIES` 完全一致：
  北京、上海、厦门、广州、成都、杭州、重庆、**济南**、**苏州**、**西安**、**青岛**。
- 现状：`cityAliases` 已有 北京/杭州/上海/广州/成都/厦门/重庆，**缺济南/苏州/西安/青岛**；
  `aliases`（景点英文名）**只有北京 11 条、杭州 11 条**。
- 实测采纳率（`data/photo-store/reviewed`，`identity=match` 占比）：
  | 城市 | Pexels | Commons | 高德 |
  |---|---|---|---|
  | 北京（有别名） | 50/236 = 21% | 112/162 | 30/40 |
  | 杭州（有别名） | 10/36 = 28% | 31/36 | 10/11 |
  | 广州（无别名） | 5/18 = 28% | 7/18 | 4/4 |
  | 厦门（无别名） | 3/30 = 10% | 12/21 | 4/5 |
  | **济南（无别名）** | **0/26 = 0%** | 16/24 | 6/8 |
- 知识库「景点类」候选量（`canonical_places`，排除美食/住宿/购物）：
  北京 1003、广州 446、杭州 431、厦门 405、重庆 375、成都 190、上海 131、济南 49、青岛 15、西安 8、苏州 7。
  总量约 3060 —— 不可能全量手写，必须按「英文图库真的有图」筛选。
- **关键坑**：`aliases` 的 key 是 `normalizePlaceKey()` 剥后缀后的名字（`apps/server/src/lib/placeKey.ts`）。
  「山东博物馆」会变成「山东」，「国家博物馆」会变成「国家」（现有代码因此用 `canonical` 特判映射到 `'中国国家'`）。
  写别名时必须按剥后缀后的 key，否则永远命中不了。
- `stockPhotoSearch` 取 `place[1] ?? place[0]` 与 `city[1] ?? city[0]` 拼查询词，即「首个英文景点名 + 首个英文城市名」；没有别名时退回中文本名。
- 已知的采纳率上限不在搜索词：视觉审核三态（`match`/`unknown`/`mismatch`）只有 `match` 采用，宁缺毋滥是设计而非缺陷。

## Requirements

- `cityAliases` 补齐济南、苏州、西安、青岛（青岛同时收 `Qingdao` 与历史写法 `Tsingtao`）。
- `aliases` 覆盖 11 个城市的头部地标，每城 9-12 个，key 一律用 `normalizePlaceKey()` 后的形式。
- **收录门槛：只有存在通行英文专名的地标才加**；纯直译且无英文条目的（老商埠、沙坡尾、白城沙滩、经三路）不加——把搜索词换成英文泛词只会多花一次外部调用，命中率不会改善。
- 每城至少 8 个地标，向上不设硬上限但不超过 13（青岛 12 个）。北京、杭州保持现有 11 条不改。
- 不改动 `stockPhotoSearch` / `matchesStockPlace` 的逻辑与匹配闸门。
- 不引入新依赖、不联网、不新增缓存。

## Acceptance Criteria

- [ ] 11 个城市在 `cityAliases` 中都有条目。
- [ ] `aliases` 覆盖 11 个城市，每城 ≥8 个地标。
- [ ] 新增测试：用**知识库里真实存在的地点名**逐城抽样，断言 `aliases[city][normalizePlaceKey(原名)]` 有值——这条直接拦住「后缀没剥掉」的坑。
- [ ] 新增测试：抽查各城地标，断言 `stockPhotoSearch()` 产出英文查询词、`matchesStockPlace()` 能命中英文元数据、且他城同名景点（如「沈阳故宫」对「故宫」）仍被拒。
- [ ] 现有 `stockPhotos.test.ts` 全绿；`npm run typecheck` 通过。

## Definition of Done

- 测试覆盖上述验收点
- `node --import tsx --test apps/server/src/__tests__/stockPhotos.test.ts` 与 `npm run typecheck` 通过
- `.trellis/spec/server/backend/` 中与图库搜索相关的条目同步说明别名表的适用范围与 key 规则

## Decision (ADR-lite)

**Context**：济南 26 张 Pexels 候选全部被判 `identity=mismatch`，根因是搜索词为纯中文；但知识库景点类候选共约 3060 个，全量手写别名既不现实、也无法保证英文图库真有图。

**Decision**：每城收录 **9-12 个头部地标**，并要求该地标存在通行英文专名。北京、杭州维持现状不扩充。

**Consequences**：
- 别名表规模约 113 条，可人工复核，不会因为收录了小众店铺名而反向拉低查询质量。
- 未收录的地标仍走中文查询，命中率不会比现在更差。
- `normalizePlaceKey()` 会剥掉 `博物馆/公园/广场/景区` 等后缀，别名 key 因此是剥后的名字（`山东博物馆` → `山东`、`五四广场` → `五四`）。这个坑用「真实地点名抽样断言」测试永久拦住。
- 别名只影响搜索词与 `matchesStockPlace` 闸门，**不影响采纳率上限**——视觉审核三态仍只有 `match` 采用。

## Out of Scope

- 修复视觉审核的误拒/漏拒
- 提高 Pexels / Pixabay / Unsplash 的配额或换图源
- 手工精选图库（`data/photography/*.json`）扩充
- 给美食/住宿/购物类地点加别名（图库搜索只服务 attraction）

## Technical Notes

- 关键文件：`apps/server/src/integrations/stockPhotoSupport.ts:88-100`
- 相关：`apps/server/src/lib/placeKey.ts`（`normalizePlaceKey` 后缀剥离表）
- 消费方：`photoCollection.ts`（新审核管线查询词）、`pixabay/cover.ts`、`unsplash/cover.ts`（旧 adapter 的 `matchesStockPlace` 闸门）
- 现有测试：`apps/server/src/__tests__/stockPhotos.test.ts`
