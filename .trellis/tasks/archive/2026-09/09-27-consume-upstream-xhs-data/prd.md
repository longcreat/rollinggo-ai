# 接入上游 xhs-pipeline 新数据（openHours / aliases / POI 关联对）

## Goal

上游 `D:\Project\xhs-travel-pipeline` 最近三个提交（f031241 / 0c5b044 / 47292c6）产出了三类新数据，
但 tripweaver 侧**一项都没消费**（已核实代码与 DB 实况）。本任务把这三类数据接入行程生成链路，
让社区挖掘结果真正影响排程，而不是躺在 payload 里。

三类数据的当前状态（已实测）：

| 上游产物 | DB/文件实况 | 消费端现状 | 写入点 |
|---|---|---|---|
| `payload.openHours`（结构化开闭馆） | 已在 DB：北京 67 / 广州 11 / 杭州 20 / 厦门 4 / 成都 4 | `placeFacts.ts` 不读，闭馆靠 `closureText` 正则从 evidence 挖 | `placeFacts.ts:toFacts()` → `buildDraft.ts:97-101` |
| `payload.aliases`（权威别名表） | 已在 DB：北京 17 / 成都 12，其余城市 0 | 不读，实体归并靠 `normalizePlaceKey` 剥后缀猜 | `placeFacts.ts:normalizePlaceKey()` |
| `place_relation` 无向关联对 | **未入库**，只有 `import/xhs-place-relations-{city}.json`（5 城 869 条，其中 direct 270 条） | 零消费，顺序靠手工 `routeOrderSeeds.json`（仅 1035 B） | `buildDraft.ts` 的排程入参 |

## What I already know

- 上游把 POI 关系从「有向 must_before/combo/viewpoint_of」改成**单一无向关联对**（47292c6），
  `strength` 只分 direct（≥2 篇笔记支持）/ weak（单篇）。上游注释明确：**顺序由消费端决定**。
  → 因此关联对**不能**直接当 `routeOrderSeeds` 用（那是先后硬约束），否则会造出假方向。
- 排程链路（`apps/server/src/generation/scheduling/schedule.ts`）：
  入选（按停留分量贪心装填）→ `buildChain` 全局最近邻成链 → `cutChain` 按每日分量上限切段
  → 段按分数降序分配 Day1..k → 餐次插槽 → 空天占位。
  「同天」语义对应的是**切段边界**，不是天分配顺序。
- 消费端已有同款先例：`routeOrderSeeds.json` + `.ts`（静态 JSON → 归一化匹配 → 产出排程约束），
  `reservationSeeds` 同款。归一化规则：别名 ≥3 字包含匹配，≤2 字只全等（防「故宫」误伤「沈阳故宫」）。
- `openHours` 结构实测：`{text, openTime, closeTime, closedWeekdays[], note, evidence[]}`
  （如景山公园 `{text:'06:30-20:00', openTime:'06:30', closeTime:'20:00'}`；
  香山双清别墅 `{text:'周一闭馆', closedWeekdays:[1]}`）。
- `isClosedOnDate()`（`packages/shared/src/openHours.ts`）目前只吃自由文本，按星期标签正则匹配。
- 覆盖面冷水：openHours 5%、aliases 1%。这两项接进去后**现有输出几乎不会变**；
  有关联对数据量的是 relations（direct 270 条）。

## Assumptions (validated)

- ✅ 关联对落地：**建 DB 表 `place_relation` + seed 脚本**（用户决策）
- ✅ 「同天」语义用 **`buildChain` 最近邻距离折扣**实现，不改 `cutChain` 切段逻辑（用户决策）
- ✅ 关联对只收 **direct**（≥2 篇笔记支持，全 5 城 270 条）（用户决策）
- ✅ openHours 与现有 `closureText` 是**优先级关系**（结构化优先，正则兜底）

## Decisions (resolved)

| 决策 | 结论 |
|---|---|
| 关联对落地 | DB 表 `place_relation` + `scripts/seed-xhs-relations.ts` + migrate |
| 关联对过滤 | 只收 `strength === 'direct'` |
| 「同天」实现 | `buildChain` 最近邻距离折扣（关联对 ×0.5） |
| openHours 消费 | 渲染成 `openTime` 文本（`"09:00-17:00；周一闭馆"`），复用 `isClosedOnDate` 无需改签名 |

## Open Questions

（无）

## Requirements (evolving)

1. `placeFacts.ts` 读取 `payload.aliases`，参与实体归一键计算，减少「故宫 / 故宫博物院」式分裂。
2. `placeFacts.ts` 读取 `payload.openHours`，渲染为 `openTime` 文本（`09:00-17:00；周一闭馆`），
   结构化数据缺失时回落到现有 `closureText` 正则结果。
3. 新增 DB 表 `place_relation`（id / city / from_name / to_name / strength / note_count），
   migrate 建表 + `scripts/seed-xhs-relations.ts` 从 `import/xhs-place-relations-{city}.json`
   导入（只收 direct，幂等 UPSERT）。
4. 排程读取所在城市的关联对，`buildChain` 最近邻对命中关联对的两点距离 ×0.5，
   使它们自然落在同一段（＝同一天）。
5. 三项均须**静默降级**：数据缺失时行为与今天完全一致，不得让生成失败。
6. 现有测试与 typecheck 全绿。

## Acceptance Criteria (evolving)

- [ ] `payload.openHours` 非空时，`SchedulablePoi.openTime` 优先取结构化渲染结果（有对应单测）
- [ ] `payload.openHours` 为空时，`closureText` 正则兜底行为不变（有对应单测）
- [ ] `payload.aliases` 能让别名与正式名归到同一事实条目（有对应单测）
- [ ] 关联对命中的两个直连 POI 在 `buildChain` 结果中相邻（有对应单测）
- [ ] 无关联对 / 无 aliases / 无 openHours 时，排程输出与接入前逐字节一致（回归单测）
- [ ] seed 脚本对同一份 JSON 重复执行结果一致（幂等）
- [ ] `npm run typecheck` 全绿

## Definition of Done (team quality bar)

- 单测覆盖三条新数据的接入点 + 缺失降级路径
- `npm run typecheck`（shared / server / web）全绿
- 上游数据格式与消费契约写入 `.trellis/spec/server/backend/`（generation-guidelines 或 rag-guidelines）
- 不改动排程既有可观测行为（除非新数据确实生效）

## 追加范围（09-27 第二轮，用户确认）

起因：行程「北京三日：园林中轴与长城」里故宫落选。追查出两条独立缺陷，都在导入链路上。

### 缺陷 1：goldset 行的社区分数被旧值锁死

`seed-xhs-places.ts` 的 upsert 用 `EXCLUDED.payload || canonical.payload` 合并，jsonb `||` 是右侧胜出，
而末尾 `CASE` 的 `ELSE '{}'` 指望「新值自动胜出」—— 实际不会，`recommendScore` / `mentionCount`
永远停在首次导入的那一版。只影响 `source='goldset'` 的行，而热门景点几乎都是 goldset。

实测：故宫博物院卡在 17.33 / 6 提及（上游已是 137.64 / 55），排第 11 位，被 3 日行程的容量挤出。

修复：`ELSE` 分支显式写回新值。

### 缺陷 2：导入脚本默认读写死的过期文件

`DEFAULT_INPUT = import/xhs-places.json` 指向 09-22 那版，而 `import/` 里北京已有三份（09-22 / 09-23 / 09-25）。

修复（方案 A）：新增 `scripts/lib/exportFiles.ts` 扫目录，按 `(source, city)` 取 `generatedAt` 最新。

### 新增：让延时可见（方案 B）

- `data_import` 表（PK `(source, city)`，版本标识 = `sha256(文件字节)[:32]`），两个 seed 脚本同事务写入
- `scripts/check-data-freshness.ts`：对比磁盘最新导出 vs 库内记录，有待导入项 exit 1

### 顺带修掉

- **重庆 604 条导出从未导入**（库里只有 19 条金集）—— 已导入
- `resolveRelatedPairs` 同一归一键只留第一个候选名 → 改为列表两两配对（修「天安门」与「天安门广场」同键时后者静默丢关联对）

### 验收

- [x] 6 城导入完成，`check-data-freshness.ts` 全部「一致」且 exit 0
- [x] 故宫博物院 137.64 / 55，景山公园 95.5 / 37
- [x] `npm run typecheck` 全绿；318/318 测试通过
- [x] 两条踩坑写入 `.trellis/spec/server/backend/rag-guidelines.md`（含 Wrong vs Correct SQL 对照）

## Out of Scope (explicit)

- 上游未提交的工作区改动（amap → 天地图、NoteImage + CLIP 图片分类）——尚未 commit，不在本任务
- `note_image` 图片消费
- 重跑上游挖掘脚本提升 openHours / aliases 覆盖率（上游侧工作）——已改成导入现有最新产物，不重跑挖掘
- 前端展示改动
- 上游 `export_and_embed.ps1` 的补全（关联对导出/导入 + `-All` 扫描）——本任务只做消费端自洽（方案 A+B）

## Implementation Plan（实施顺序）

1. **placeFacts 接 openHours + aliases**（两个字段，改动最小，先落地）
   - `toFacts()` 读 `payload.openHours` → 渲染 `openTime` 文本；`buildDraft.ts` 回填优先级改成「结构化 > closureText」
   - `normalizePlaceKey` 接 `payload.aliases`（参与归一键）
   - 验证：`placeFacts.test.ts` 新增用例；无数据时行为不变
2. **place_relation 表基建**
   - `db/schema.ts` 加 `placeRelations` 定义 + `db/migrate.ts` 加 CREATE TABLE / INDEX
   - 新增 `scripts/seed-xhs-relations.ts`（读 5 个 city JSON，过滤 direct，幂等 UPSERT）
   - 验证：重复执行 seed 结果一致
3. **关联对排程接入**
   - 新增 `scheduling/placeRelations.ts`：`loadPlaceRelations(city)` → pair key 集合（查询失败返回空集）
   - `buildDraft.ts` 传入 → `schedule.ts:buildChain` 距离折扣（×0.5）
   - 验证：`scheduling.test.ts` 新增「关联对两点在链上相邻」；既有用例回归不变

## Technical Notes

- 关键文件：
  - `apps/server/src/generation/scheduling/placeFacts.ts`（事实补全，含 `normalizePlaceKey` / `mergeFacts`）
  - `apps/server/src/generation/scheduling/buildDraft.ts`（排程入参组装、openTime 回填）
  - `apps/server/src/generation/scheduling/schedule.ts`（`buildChain` / `cutChain` / `buildSchedule`）
  - `packages/shared/src/openHours.ts`（`isClosedOnDate` / `dateForDayIndex`）
  - `apps/server/src/data/routeOrderSeeds.ts` + `.json`（同款归一化匹配先例）
  - `apps/server/src/db/schema.ts` + `apps/server/src/db/migrate.ts`（表定义 + 启动迁移）
  - `apps/server/scripts/seed-xhs-places.ts`（上游 JSON 导入管线的写法先例）
  - `apps/server/src/db/client.ts`（`pool`）
- 上游产物路径：`import/xhs-places-{city}.json`、`import/xhs-place-relations-{city}.json`
- 上游导出脚本：`xhs-travel-pipeline/scripts/export_to_tripweaver.py`、`scripts/mine_place_relations.py`
