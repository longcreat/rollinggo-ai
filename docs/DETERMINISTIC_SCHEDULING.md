# 织程 TripWeaver · 确定性排程算法

> 行程的**结构**（入选哪些点、每个点属于哪一天、当天内什么顺序）由纯代码算出，不经过 LLM。
> 文案（标题、活动说明）才走模型。本文描述 `apps/server/src/generation/scheduling/` 的实现契约。
>
> 代码是权威，本文是导读。任何公式/阈值改动的权威位置在文末「相关文件」。

---

## 一、为什么是代码

实测数据（09-20）：让 LLM 直接推行程结构要烧 **4.7 万输出 token / 432 秒**，且第 2 轮修订会撞超时。

更关键的是**可验证性**：结构错了就是错了（一天塞不下、闭馆日排了景点、长城和市区点混排），
这些都能用确定性规则判定。交给模型只会得到"看起来合理"的结构。

排程因此是**结构唯一来源**：排不出来就没有行程可言，不做"降级继续"。
文案属增强路径，模型没写完也照常落库。

---

## 二、输入与输出

### 输入（`ScheduleDraftInput`）

| 字段 | 来源 | 用途 |
|---|---|---|
| `pool: ResearchPoi[]` | 调研阶段产出的候选池 | 选点范围 |
| `locations: Map<string, ResearchLocation>` | 调研旁路捕获的坐标（GCJ-02） | 成链几何 |
| `longHaul: LongHaulPoi[]` | `longHaul.ts` 按通勤时长分级 | 识别远郊独占点 |
| `facts: Map<string, PlaceFacts>` | `placeFacts.ts` 从 `canonical_places` 补全 | 分数 / 分量 / 主题 / 营业时间 |
| `relations: PlaceRelations` | `placeRelations.ts` 从 `place_relation` 读取 | 同天聚类 |
| `form: GenerateForm` | 用户表单 | `days` / `startDate` / `pace` |

### 输出（`ScheduleResult`）

```ts
interface ScheduleResult {
  days: ScheduledDay[];                  // 每天的标题与 stops（含餐次、占位）
  droppedCount: number;                  // 因容量/天数/闭馆未排入的候选数
  closureConflicts: ClosureConflict[];   // 闭馆日无处可避的段 → 上层须如实告知用户
}
```

`closureConflicts` 非空时，`orchestrator.ts` 会生成注记并入 `meta.reviewNotes`，
例如：「八达岭长城 在 2026-09-28 周一 闭馆，剩余天数里没有其他可用日，未排入行程（该天留空，可自由安排）。」

---

## 三、算法流程（十步）

### ① 事实补全 `placeFacts.ts`

拉全城 `canonical_places` 行，按**归一键**分组合并后服务候选。

归一键 = `normalizePlaceKey(name)`（剥机构后缀：博物院/博物馆/公园/风景区/广场…，只剥一次、至少留 2 字）
**加上** `payload.aliases` 的每个别名。任一键命中即取该行事实。

> 为什么需要：知识库存在「故宫 / 故宫博物院」「双清别墅 / 香山双别墅」式分裂条目，
> 按名精确查会把分数与情报拆散。

合并规则：质量取 `max`、热度**求和**、themes 并集、坐标取有值行、source 取最高优先
（`goldset > xhs > amap > manual`）。

查询失败 → 返回空 Map，排程按"无事实"降级（走类型表兜底），**不阻断生成**。

### ② 选点权重 `score.ts`

```
poiScore = ratio(recommendScore, 池内最大) × 60
         + ratio(mentionCount,  池内最大) × 40
         + (source === 'goldset' ? 15 : 0)          // GOLDSET_SCORE_BONUS
```

`ratio` 缺值时返回 `NEUTRAL_RATIO = 0.5`（**不当 0**）。

> 缺值当 0 会让故宫/天坛/北海这些金集行排到链尾、段落最后，并在容量紧张时被优先丢弃 ——
> 排序被彻底反转（实测故宫曾落到 Day3）。归一化基准 `scoreMaxima` 也只统计**有值**样本。

### ③ 停留分量 `visitWeight.ts`

不给分钟数，只给相对量级 1~3：

```
xhsPlaceType → WEIGHT_BY_PLACE_TYPE  (scenic_area=3, attraction/museum/park=2, street/cafe/…=1)
     ↓ 缺失
canonical_places.category → WEIGHT_BY_CATEGORY  (文化/自然/娱乐=2, 美食/购物/交通/其他=1)
     ↓ 缺失
DEFAULT_VISIT_WEIGHT = 2
```

> `attraction` 是 catch-all（占全部 POI 的 59%），给它 3 等于把所有点都当大景区
> —— 实测一天只剩 2 个、三天行程丢 8 个候选。只有 `scenic_area` 才算 3。

### ④ 强独占级切分

`longHaul` 判出的远郊点（八达岭、慕田峪…）各自独占一天，且最多占 `floor(天数 × 0.5)` 天
（`maxExclusiveDayRatio`）。超出上限的按分数丢弃。

> 3 天行程实测踩到：八达岭 + 慕田峪各占一天 → 3 天里 2 天在长城。

### ⑤ 容量贪心入选

```
容量 = (天数 − 已占用的独占日数) × 每日分量上限(pace)
按分数降序装填：装不下的跳过（由后面的轻点补位），仍装不下则丢弃 → droppedCount
```

> 按**分量**而不是个数装填：个数区分不了"大点"与"小点"。
> 实测 Day1 六个点（雍和宫/恭王府/故宫/北海/景山/什刹海）合计分量 14，两天都装不下。

### ⑥ 成链 `buildChain`（全局最近邻）

从**分数最高**的点出发，每次接"距离最近"的下一个，形成一条巡游链。

三处修饰：

1. **顺序种子表** `orderConstraints`（`data/routeOrderSeeds.json`）：`after` 的前置点还在链外时跳过它
   （拓扑意识最近邻）——修「景山排在故宫前」这类出入口方向错误。
2. **关联对** `relatedPairs`（`place_relation` 表）：命中关联对的两点距离 **× 0.5**
   （`RELATED_DISCOUNT`）——让强关联的点在链上相邻，从而更可能同段（同天）。
3. **无坐标点**不参与几何成链，按分数接在链尾（它们的坐标由 `geoPipeline` 事后解析）。

> 关联对是无向的（上游 47292c6 明确「顺序由消费端决定」），**只做同天聚类，绝不产出先后约束**。

### ⑦ 切段 `cutChain`

沿链顺序按「每日分量上限 + 单日个数上限」切段，然后**每段再做一次段内最近邻重排**。

> 为什么要重排：全局最近邻是在**整池**上跑的，链被切开后段内顺序不一定还是局部最短路径。
> 实测出现「国博→先农坛→圆明园→前门大街」这种 101/85 分钟的折返。

### ⑧ 段 → 天分配

段按 `max(成员分数)` 降序，依次挑选"该段无成员闭馆"的最早可用天。详见第四节。

### ⑨ 餐次插槽

仅当用户偏好含「美食」时（`foodFocused`）：午餐落在段中段之后、晚餐落段尾，
锚点是候选池里的真实美食点（离上一个点最近、尚未使用）；没有就退到目的地名，**不编造门店**。

> 位置只表达**阅读顺序**——行程不产出时间轴（见下）。

### ⑩ 空天占位

没有内容的天用 `自由安排｜{目的地}` 占位，保住「每天至少一个活动」的门槛。

---

## 四、闭馆日处理

### 判定 `isClosedOnDate`（`packages/shared/src/openHours.ts`）

```
openTime 或日期缺失/非法 → false（无数据不校验，绝不错误拦截）
日期落在法定节假日   → false（豁免）
否则：按日期算星期，文本里含该星期标签 **且** 含闭馆关键词（闭馆|不开放|休息|停业）→ true
```

`openTime` 是自由文本（高德原文，或社区挖掘的结构化开闭馆渲染而成，如 `09:00-17:00；周一闭馆`）。

### 节假日豁免（09-27）

数据源：`packages/shared/src/holidays.ts`，内容为国务院办公厅发布的放假安排
（当前收录 2026 年，见 `CN_HOLIDAYS`）。

- **每年 11 月官方发布次年安排后更新该文件**；未收录的年份不豁免，退回"只看星期"的既有行为。
- **只收放假区间，不收调休上班日**：场馆按**星期**判定开放，调休上班的周末照常按周末运营。
  真正需要豁免的只有"本该闭馆的那天被列为法定节假日"（如 2026-10-05 周一属国庆，故宫按惯例开放）。
- **已知取舍**：按"落在节假日就不判闭馆"处理，而不是要求原文写出「法定节假日除外」。
  全国博物馆/景区的周一闭馆规则普遍带这个例外，而库内证据极少显式写出它。
  代价是"节假日也闭馆"的少数场馆会被放过 —— 宁可漏判一次闭馆，不可把开放的节假日误判成闭馆。

### 天分配的三级退化

```
第一轮：零闭馆冲突的最早可用天
第二轮：冲突最少的天（整段闭馆的天一律跳过）
       ↓ 无天可给
不分配该段 → 空天占位 + closureConflicts 记录 + 上层告知用户
```

> **为什么整段闭馆要跳过**（09-27 修）：原实现在无处可避时退回"最早未分配的天"，
> 后果是拿剩下的那个段被硬塞进它自己闭馆的那天。实测北京 3 日（2026-09-28 周一）
> 把单点的八达岭独占段塞进周一，而八达岭当天闭馆 → 整天作废。
>
> 注意「整段闭馆」与「段内部分闭馆」的差别：故宫段 4 个点里只有故宫周一闭馆，
> 放周一仍有 3 个点可游，这种情况**照常分配**，不丢整段。

---

## 五、算法轨迹实例

真实北京候选池（12 个，库内实测分数），`startDate = 2026-09-28`（周一）、3 天：

```
① 事实补全 → 分数：故宫 115.0 · 景山 83.8 · 天坛 81.8 · 什刹海 74.3 · 颐和园 72.1
                    八达岭 69.6 · 北海 59.5 · 国博 42.3 · 圆明园 41.0 · 恭王府 38.1
                    钟鼓楼 9.2 · 孔庙国子监 4.0
② 分量：全部 fallen back 到 attraction = 2
③ 独占：八达岭独占 1 天
④ 容量：(3 − 1) × 8 = 16 → 8 个点 × 2 正好装满 → 恭王府/钟鼓楼/孔庙出局
⑤ 成链 + 切段 → 2 段
⑥ 段排序：[故宫段 max 115] [天坛段 max 81.8]
   （八达岭独占段 max 69.6，但独占段先入数组，sort 后排在最后）
⑦ 分配：
     故宫段 → Day1(周一) 有冲突 → Day2(周二) ✓
     天坛段 → Day1 冲突、Day2 已占 → Day3(周三) ✓
     八达岭段 → Day1 整段闭馆（跳过）、无其他天 → 丢弃 + 记录冲突
⑧ 结果：Day1 空天占位 · Day2 故宫/景山/北海/什刹海 · Day3 天坛/国博/圆明园/颐和园
```

同样候选池改成 `startDate = 2026-10-05`（周一，**国庆假期**）：

```
故宫段的周一闭馆被节假日豁免 → Day1(10-05) 零冲突 → 故宫段落 Day1
八达岭段 → Day2 冲突、Day3 零冲突 → 落 Day3
结果：Day1 故宫段 · Day2 天坛段 · Day3 八达岭
```

---

## 六、参数速查

| 参数 | 位置 | 值 | 改它会影响 |
|---|---|---|---|
| `GOLDSET_SCORE_BONUS` | `score.ts` | 15 | 金集点位的相对优先度 |
| `NEUTRAL_RATIO` | `score.ts` | 0.5 | 缺分数时的中性取值 |
| `DEFAULT_VISIT_WEIGHT` | `visitWeight.ts` | 2 | 无类型信息点的分量 |
| `maxStopsPerDay` | `schedule.ts` | 6 | 单日最多活动数（moderate） |
| `dayWeightLimit` | `schedule.ts` | 8 | 单日分量上限（moderate） |
| `maxExclusiveDayRatio` | `schedule.ts` | 0.5 | 远郊独占日占比上限 |
| `emptyDayPrefix` | `schedule.ts` | `自由安排` | 空天占位名 |
| `RELATED_DISCOUNT` | `schedule.ts` | 0.5 | 关联对的成链吸引强度 |
| `PACE_SCHEDULE_LIMITS` | `schedule.ts` | relaxed `{4,5}` / moderate `{6,8}` / tight `{8,12}` | 节奏档位 |
| `CN_HOLIDAYS` | `packages/shared/holidays.ts` | 2026 年七节 | 闭馆日豁免范围 |
| `CITY_BOUND_DEGREES` 等 | `integrations/tianditu/poiSource.ts` | — | POI 召回范围（非排程，但影响候选池） |

---

## 七、已知取舍与边界

- **不产出时间轴**：拿不到可信的游玩时长，排"几点到几点"是假数据，且真实 leg 会把假时间轴推爆
  （实测第 2 天被推到 22:45）。`startTime`/`endTime` 恒为空串，前端按"未排时刻"展示。
- **闭馆日只判"哪天"，不判"几点"**：没有时间轴，时间窗约束无从谈起。
- **节假日按年硬编码**：未收录年份不豁免。这是刻意的保守选择。
- **闭馆判定不看主语**：`isClosedOnDate` 只做模式匹配。上游社区挖掘的 `openHours` 存在
  **归属错误**（图片事实按地名匹配整段文本，导致一张信息图里多个景点互相串），
  如八达岭长城被误挂"周一闭馆"（源头是同一张图里"军事博物馆亚洲最大且周一闭馆"）。
  消费端目前不做二次校验，排程可能因此少排一个实际开放的点。
- **关联对与候选名仍可能对不上**：`resolveRelatedPairs` 只走 `normalizePlaceKey`，
  未使用 `payload.aliases` 做扩展匹配，库内名与候选名差异过大时会漏配。

---

## 八、相关文件

| 职责 | 文件 |
|---|---|
| 排程核心（纯函数、零 IO） | `apps/server/src/generation/scheduling/schedule.ts` |
| 事实补全 | `apps/server/src/generation/scheduling/placeFacts.ts` |
| 关联对加载与候选交叉 | `apps/server/src/generation/scheduling/placeRelations.ts` |
| 选点权重 / 停留分量 | `apps/server/src/generation/scheduling/score.ts`、`visitWeight.ts` |
| 排程入参组装与写草稿 | `apps/server/src/generation/scheduling/buildDraft.ts` |
| 编排调用点 | `apps/server/src/generation/orchestrator.ts`（阶段 2「确定性排程」） |
| 顺序种子表 | `apps/server/src/data/routeOrderSeeds.json` + `.ts` |
| 闭馆判定 / 节假日 | `packages/shared/src/openHours.ts`、`holidays.ts` |
| 可行性引擎（下游校验） | `packages/shared/src/feasibility.ts` |
| 单测 | `apps/server/src/__tests__/scheduling.test.ts`、`holidays.test.ts`、`placeFacts.test.ts`、`placeRelations.test.ts` |
