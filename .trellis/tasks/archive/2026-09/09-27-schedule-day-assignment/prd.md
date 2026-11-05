# 修复排程「段→天」分配在闭馆日无解时的退化行为（含节假日豁免）

## Goal

行程「北京三日：长城与皇城」里，**八达岭被排在 2026-09-28（周一）—— 而它自己写着周一闭馆**，
`meta.reviewNotes` 里已经记着「可行性遗留」。故宫则落到 Day2。

根因不是分数（故宫 115.0 排第一），而是 `buildSchedule` 的段→天分配在「避不开闭馆日」时
退回「最早未分配的天」，让拿剩下的那个段被硬塞进它自己闭馆的那天。

同一轮还查出两件事：八达岭的「周一闭馆」是上游图片事实串号导致的**数据错误**；
节假日从未被考虑（国庆假期里的周一会被误判闭馆）。

## What I already know

- 复现脚本用真实库数据跑出了与实际行程逐字一致的结果，确认走的就是那条退化分支。
- 闭馆日分配轨迹：段按 `max(score)` 降序 → 故宫段(115) 取 Day2 → 天坛段(81.8) 取 Day3
  → 八达岭段(69.6) 只剩 Day1，而它自己闭馆。
- 八达岭数据错误的完整链条：note 468 图片分析 `"...军事博物馆亚洲最大且周一闭馆"`
  → `_match_image_facts` 按地名匹配整张图文本（八达岭是同一张 5 天路线表里的地名）
  → `mine_open_hours` 只跑正则不判主语 → `closedWeekdays:[1]`。
  波及 5 个地点：雍和宫、八达岭长城、天安门、天安门升旗、清华北大。
- `isClosedOnDate` 当前只做「星期标签 + 闭馆关键词」，无节假日概念。
- 2026 年放假安排（国办发明电〔2025〕7 号，2025-11-04 发布）：元旦 1/1–1/3、春节 2/15–2/23、
  清明 4/4–4/6、劳动节 5/1–5/5、端午 6/19–6/21、中秋 9/25–9/27、国庆 10/1–10/7。
  落在周一的节假日：2/16、2/23、4/6、5/4、**10/5**。

## Requirements

1. **A**：段→天分配三级退化 —— 零冲突天 → 冲突最少天（**整段闭馆的天一律跳过**）→ 不分配该段。
2. 「整段闭馆」与「部分闭馆」分开：4 个点里 1 个闭馆照常分配，不丢整段。
3. **B**：法定节假日豁免 —— 落在放假区间内的日期不判闭馆。
4. 节假日数据必须可追溯、可维护，未收录年份退回既有行为（不豁免）。
5. **C**：被放弃的段必须显式告知用户（`meta.reviewNotes`），不能静默少一天。
6. 无 `startDate` 时行为与接入前完全一致。
7. 确定性排程算法写成文档放 `docs/`。

## Acceptance Criteria

- [x] `2026-09-28`（周一，非节假日）：Day1 留空占位 + 冲突提示；八达岭不被塞进闭馆日
- [x] `2026-10-05`（周一，国庆假期）：故宫段落 **Day1**（豁免生效）
- [x] `2026-10-12`（普通周一）仍判闭馆
- [x] 整段闭馆 → 占位 + `closureConflicts` + `droppedCount` 增加
- [x] 部分闭馆 → 照常分配，不丢整段
- [x] 无 `startDate` → 与 09-22 行为一致
- [x] `npm run typecheck` 全绿；全套测试通过
- [x] `docs/DETERMINISTIC_SCHEDULING.md` 存在且与代码一致

## Definition of Done

- 单测覆盖：七个节日区间首尾、区间外、非 2026 年份、非法输入、调休上班日不影响、
  整段闭馆、部分闭馆、八达岭回归场景
- `npm run typecheck` 全绿
- spec 记录三级退化契约与节假日表维护约定
- 文档与代码不漂移（公式、阈值、文件路径以代码为准）

## Technical Approach

### A：`pickDay` 三级退化（`schedule.ts`）

```ts
// 第一轮：零闭馆冲突的最早可用天
// 第二轮：冲突最少的天；count >= segment.length（整段闭馆）一律跳过
// 无天可给 → 返回 -1
```

调用侧区分两种 `-1`：**天数用完**（容量问题，静默丢弃）vs **还有空天但整段闭馆**
（产生 `closureConflicts` 条目）。

### B：节假日表（`packages/shared/src/holidays.ts`）

```ts
CN_HOLIDAYS: readonly { name: string; from: string; to: string }[]
findHoliday(dateStr): HolidayRange | null
isPublicHoliday(dateStr): boolean
```

`isClosedOnDate` 在星期匹配**之前**短路返回 false。

### C：冲突可见（`orchestrator.ts`）

`ScheduleResult.closureConflicts` → reviewNotes 文本：

```
八达岭长城 在 2026-09-28 周一 闭馆，剩余天数里没有其他可用日，未排入行程（该天留空，可自由安排）。
```

## Decision (ADR-lite)

**Context**：闭馆日无解时该怎么办 —— 硬塞（现状）还是留空？

**Decision**：留空 + 告知。理由是「硬塞的后果是整天作废」，而留空至少是诚实的，
且「空天占位」本就是既有设计（有对应测试）。

**Consequences**：
- 行程可能少一天内容（3 天变 2 天有用）—— 由 reviewNotes 显式说明，用户可自行改出发日
- 节假日豁免是**无条件**的（不要求原文写出「法定节假日除外」），代价是少数「节假日也闭馆」的
  场馆会被放过。取舍理由：全国博物馆的周一闭馆规则普遍带这个例外，而库内证据极少显式写出它

## Out of Scope

- **上游数据错误的修复**：八达岭的 `closedWeekdays` 来自图片事实串号，
  修在 `xhs-travel-pipeline` 侧（`_match_image_facts` / `mine_open_hours` 需要主语校验）
- 消费端对 `openHours` 做二次校验（如「证据里必须出现本地点名」）——本轮不做，
  因为已知大部分证据只是被截断，自动判定误伤率高
- 调休上班日的特殊处理（场馆按星期判定，不需要）
- 2027 年及以后的节假日数据（官方发布后再补）
- `note_image` 图片消费

## Technical Notes

- 关键文件：
  - `apps/server/src/generation/scheduling/schedule.ts`（`pickDay` / `closedCountOn` / `closureConflicts`）
  - `packages/shared/src/openHours.ts`（`isClosedOnDate` 豁免短路）
  - `packages/shared/src/holidays.ts`（新增）
  - `apps/server/src/generation/orchestrator.ts`（冲突 → reviewNotes）
- 文档：`docs/DETERMINISTIC_SCHEDULING.md`
- spec：`.trellis/spec/server/backend/generation-guidelines.md`（新增 Scenario）
- 节假日数据来源：国务院办公厅关于 2026 年部分节假日安排的通知（国办发明电〔2025〕7 号），
  `https://www.gov.cn/zhengce/content/202511/content_7047090.htm`
- 现有测试用的 `2026-09-21` 不在任何节假日区间，不受豁免影响（已核对）
