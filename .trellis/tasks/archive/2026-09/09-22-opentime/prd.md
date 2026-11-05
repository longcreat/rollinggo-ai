# 营业时间进排程：opentime 捕获 + 闭馆日检测 + 排程约束

## 背景

借鉴 FloatTrip（见 `09-22-plan-no-timeline-chain-split/research/`）：高德 POI 的 `opentime` 应进入编排约束而非只当文案素材。金集已见「周一闭馆」式翻车。

**现状**：`integrations/amap/poiSource.ts` 已抓到 `opentime`（opentime_today || opentime_week，截 60 字），但只出现在 `search_pois` 给调研 Agent 的文本里（`营业 ...`），未结构化流转——候选池、排程、可行性引擎全都拿不到。

## 决策（已确认）

- 严重度：**闭馆日 = hard**（物理不可行，对齐 transit_infeasible 语义）。
- 数据附着：`add_candidate` 时按名称从最近 `search_pois` 结果**自动回填**，不让 LLM 转抄（防转抄失真）。

## ⚠️ 范围修正（09-22 D5 冲突，实施后修订）

09-22 任务已决定**去时间轴**（schedule.ts 不再产出 startTime/endTime，营业时间/闭馆判定在其 PRD 中列为 Out of Scope）。本任务原始范围（含时间窗 clamp + outside_open_hours soft）是在调研后、发现 D5 前写的，实施时修正为：

- **时间窗校验整个取消**：无时间轴就没有「几点到访」可校验，`parseOpenInterval` 不做。
- **只做闭馆日检测**：`isClosedOnDate(text, date)` 只需日期不需要时刻，与去时间轴兼容。依赖 `form.startDate`；startDate 为空（未定）→ 整体跳过（truthful degradation）。

## 改动范围

1. **捕获**：`tools/researchTools.ts` —— search_pois 结果按 name 暂存 opentime；add_candidate 命中同名 POI 时自动挂 `openTime`。`ResearchPoi` schema 加可选 `openTime?: string`（shared/schemas.ts，向后兼容）。
2. **解析**（packages/shared，纯函数，IO-free）：
   - `isClosedOnDate(text, dateStr): boolean` —— 按 visitDate 星期匹配「周一/星期一…闭馆/不开放/休息」子句（FloatTrip `_closed_on_date` 正则思路）
3. **排程约束**（`generation/scheduling/schedule.ts`）：`SchedulablePoi` 透传 `openTime`；段→天分配后跑 `avoidClosedDays` 后处理：闭馆的点移到最近的可容纳且未闭馆的天；无处可移 → 留在原天并记 hard 违规（交可行性引擎收口）。
4. **可行性引擎**（shared/feasibility.ts）：新违规码 `closed_on_date`（hard）；活动无 openTime 或 trip.startDate 为空 → 完全跳过（truthful degradation）。替换掉过时的「closed_on_arrival RESERVED」注释。
5. **落库**：`ActivitySchema` 加可选 `openTime`（真实高德数据，持久化无害，前端展示留待后续）。
6. **prompt**：`ACTIVITY_REQUIREMENTS` 加一条——不得在 description 编造具体营业时段，营业信息以系统校验为准。

## 不做（Out of Scope）

- 前端编辑器展示营业时间
- opentime 为空时的 LLM 推断（拿不准就不校验）
- 餐厅/住宿的营业时间校验（仅 attraction 类候选生效；美食类 opentime 已被 researchTools 过滤）

## 验收

- `isClosedOnDate` 单测：`"9:00-17:00；周一闭馆"` 周一 true / 周二 false；`"周一、周二闭馆"` 两天都 true；空串恒 false
- add_candidate 自动回填单测（命中/未命中/重名）
- 排程：闭馆日候选被换到开放天；startDate 为空时不干预分天
- 可行性：`closed_on_date` hard 出现在 report；无 openTime 活动不产出该违规
- `npx tsx --test apps/server/src/__tests__/` 全绿 + `npm run typecheck`

## 验收实录（2026-09-22）

- 单测/typecheck 全绿（207/207）；闭馆避让单测覆盖：避让生效 / 无 startDate 不干预 / 全闭馆照常分配交引擎收口。
- **e2e 未触发**（如实记录）：实测北京 3 日生成，候选全部来自知识库（search_verified_places），无一携带 openTime（自动回填只覆盖 search_pois 高德实测来源）；且表单 startDate 为空，日期检测整体跳过。
- **覆盖现状**（探针实测）：canonical_places payload 的 hours 字段覆盖 93/2476（3.8%），含闭馆/星期语义的仅 2 行（人民大会堂、织梦乐园）——故宫的 hours 是「20:00放票」而非闭馆信息。闭馆检测当前只对「走了高德 search_pois 的候选 + 表单填了 startDate」的行程生效。
- **后续改进口**：xhs 管道提升 hours 覆盖率与闭馆语义抽取；或接高德详情接口批量补 opentime。
