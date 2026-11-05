# 景点顺序种子表 + 闭馆信息从 evidence 回填

## 背景

北京 3 日实测暴露「景山→故宫」顺序错误（故宫南进北出，景山在神武门对面，正确顺序是故宫→景山）。成链切段是纯直线距离最近邻，不懂出入口方向。探针证实知识库已有散装素材（「别把顺序搞反了」「神武门出即景山」类证据），缺的是结构化关系。

## 决策（已与用户确认）

- **不引入 Neo4j**：关系就是表行，Postgres/JSON 存储，离线挖掘、在线查表（见 09-22 调研文档）。
- 两件小事打包：
  1. **顺序种子表**：对齐 `reservationSeeds` 模式（JSON 数据 + TS 匹配器，随仓库维护），成链时作为硬约束
  2. **闭馆回填**：候选无 openTime 时，从 research_evidence 文本挖「周X闭馆/不开放」合成闭馆信息，补 09-22-opentime 的覆盖缺口（opentime 只覆盖 search_pois 来源）

## 改动范围

1. `apps/server/src/data/routeOrderSeeds.json` + `routeOrderSeeds.ts`：
   - 结构：`{ city, before, beforeAliases, after, afterAliases, note }`
   - 匹配器复用 reservationSeeds 的归一化/别名规则（≥3 字包含、≤2 字全等，防「故宫」误伤「沈阳故宫」）
   - 首批种子只收证据支持的：北京 故宫→景山（神武门出即景山）、天安门广场→故宫（南进北出）
2. `schedule.ts` `buildChain`：`ScheduleOptions` 加 `orderConstraints?: { before: string; after: string }[]`；最近邻选下一个时，若某候选的已入选前置点还没进链，跳过它（拓扑意识的最近邻）。约束两端都在入选集合才生效。
3. `buildDraft.ts`：从 pool 名单匹配种子表，产出 orderConstraints 传入 buildSchedule。
4. `placeFacts.ts`：新增 `closureText` 字段——按 place_id 查 research_evidence 中匹配 `周[一二三四五六日天].{0,6}(闭馆|不开放|休息)` 的证据内容，取第一条截 60 字。
5. `buildDraft.ts`：`schedulable.openTime = poi.openTime ?? facts?.closureText`（高德原文优先，evidence 挖掘兜底）。
6. 测试：匹配器（含误伤防护）、链上拓扑约束（景山不再排故宫前）、闭馆回填优先级。

## 不做（Out of Scope）

- 离线挖掘管道（上游 xhs-travel-pipeline 的独立需求）
- combo/viewpoint_of 等其他关系类型（先跑通 must_before）
- 前端展示

## 验收

- 种子表匹配单测：别名命中、短名不误伤、跨城市不串
- 排程单测：故宫+景山同程时景山恒在故宫后；约束一端缺席时不生效
- 闭馆回填单测：poi.openTime 优先于 closureText；无 evidence 不编造
- 全套测试 + typecheck 绿
