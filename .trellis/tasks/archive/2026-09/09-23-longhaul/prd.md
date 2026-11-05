# 长途点标级坐标兜底：修同类远郊点重复入选

## 背景

实体归一修复后的北京 3 日实测：Day2 = 天坛→雍和宫→颐和园→八达岭（末段 163min），Day3 = 慕田峪独占。两个长城同时入选——八达岭没拿到【强独占级】标级，被当普通点塞进市区天。

根因：`classifyLongHaulPois` 只用调研阶段 `search_pois` 旁路捕获的坐标（`research.locations`）；知识库来源的候选（search_verified_places）没有旁路坐标 → 直接跳过标级。而 canonical_places 坐标覆盖 1494/1494，白白闲置。

## 决策（用户已确认方向）

让第二个同类远郊点**不入选**：修标级覆盖后，八达岭/慕田峪同判【强独占级】，`maxExclusiveDayRatio` 上限自然挤掉低分者（既有逻辑），低分长城直接不进候选。

## 改动范围

1. `longHaul.ts`：`classifyLongHaulPois(pool, locations, mode, fallbackCoords?)` 加可选兜底坐标源；单点坐标 = locations 优先，fallback 补缺。
2. `orchestrator.ts`：`loadPlaceFacts` 调用前移到分类之前；用 `facts.lat/lng` 组装 fallback 传入；删除后面重复的 loadPlaceFacts 调用（复用同一份 facts）。
3. 测试（`longHaul.test.ts` 补）：八达岭式场景——候选无旁路坐标、facts 有坐标 → 判为 exclusive；locations 优先于 fallback。

## 验收

- 双长城场景单测：两个 exclusive 级远郊点 → 低分者不进 segments（droppedCount 含它）
- 全套测试 + typecheck 绿
- （可选）重跑北京 3 日：Day2 不再出现第二个长城

## 不做

- 【长途级】（非独占）同方向约束进排程——先观察修完覆盖后还剩多少这类问题
- 相似度判定的通用「同类点去重」（名称规则等）——先靠独占上限兜住
