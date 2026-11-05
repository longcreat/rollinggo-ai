# info.md — 层 1 技术记录（通勤估算修正 + AMAP route 排查）

> 2026-07-18 层 1 实现波次产出。层 2/3（编排预防、确定性修复器）与 live 收口步骤请先读本文件。

## 1. 分段速度模型（已落地）

唯一事实源：`packages/shared/src/constants.ts` 的 `LEG_SPEED_MODEL`（readonly as const），
消费方 `packages/shared/src/legs.ts` 的 `estimateTransit`（签名未变，feasibility.ts:147 兜底与
server legEstimator 自动同步生效）。

| mode | 市内速度 | 固定开销 | 分段点（绕行距离） | 长途等效速度 |
|---|---|---|---|---|
| transit | 20 km/h | 10 min | 20 km | 45 km/h（市郊铁路/快速公交） |
| drive | 30 km/h | 5 min | 20 km | 70 km/h（快速路/高速） |
| walk | 4.5 km/h | 0 | 无分段 | — |

分段线性：`t = 市内段(min(d, 20km)/20) + 长途段(max(d-20km,0)/45) + 开销`，对距离连续、单调递增。

### 校准验算（金集快照真实坐标）

| 段位 | 绕行距离 | 旧估算 | 新估算 | 备注 |
|---|---|---|---|---|
| beijing 住宿→八达岭 (transit) | 84.7km | 264min | **156min** | PRD 区间 120-200 ✓；真实 S2/驾车 90-120min，保守略高 |
| beijing 八达岭→南来顺 (transit) | 85.6km | 267min | **157min** | 违规1 (267>180) 解除：157<180 |
| beijing 南来顺→鸟巢 (transit) | 19.5km | 68min | **68min** | 市内段不变（≤20km 全部不变） |
| beijing 鸟巢→住宿 (transit) | 14.9km | 55min | 55min | 不变 |
| qingdao 崂山类 (transit) | 35.0km | 115min | 90min | 与真实公交量级相符 |
| suzhou (transit) | 17.0km | 61min | 61min | 不变 |
| 84.7km (drive) | 84.7km | 174min | 100min | |

**独占日形态验算**：2×156 + 360min 游览 = 672min < 840min，余量 168min → 层 2 独占日规则
数学上可行且能带回程顺路点。层 2 的 D2 远郊阈值（≥60/90min）判定请直接复用
`estimateTransit`（勿另写速度模型）。

## 2. AMAP route 城际段未生效排查

### 关键静态事实：失败不是「城际段」特有

beijing 快照的 heuristic 不止 Day3 城际段：**Day2 的 2.8km、Day4 的 3.2km/4.6km、Day5 全部
6-9km 市内短段也全是 heuristic**（amap leg 占比 33%，前 ~8 段 amap 成功，之后全败）。
suzhou 67%、qingdao 44% 同样存在部分降级。模式 = **运行中途级联失效**（前面成功、某点之后
全败），而非八达岭点对的几何/参数特异问题。

### 已修（静态可确认，本波次落地）

1. **`geoPipeline.ts` city2 兜底错抄对端**（原 `adcodes.get(to.id) || city1`）：终点活动缺
   adcode 时抄起点的**区县级** adcode（如八达岭 110119 被抄给市区餐馆）。已改为起终点各自
   独立兜底目的地城市级 adcode（`resolveCityAdcode()`，有 memo，无额外配额消耗）。
2. **`route.ts` 24h 负缓存钉死降级**（原对 null 也 `cache.set`）：一次瞬时失败（网络/限流/
   超时）把该点对 24h 内全部后续任务钉死在启发式。已改为只缓存成功结果（重试成本由
   ROUTE_MAX_PER_TASK 与日额度闸门约束）。
3. **`geoPipeline.ts` legMemo 记忆启发式结果**：任一段一旦降级，修订轮 computeLegs 永不重试
   AMAP（与 2 叠加 = 「一次失败，整个任务出局」，正是 Day3-5 连续 2 个审校轮全 heuristic 的
   放大器）。已改为只记忆 amap leg；降级段在剩余额度内重试（额度闸门 tryRoute 不变，上限仍
   成立）。

### 待 live 验证（静态无法确认，收口步骤处理）

按嫌疑度排序：

1. **中途级联失效的根因**：候选 = 高德服务端限流/日配额（公交路径规划配额独立于 POI 搜索，
   个人 key 明显更小；返回 `CUQPS_HAS_EXCEEDED_THE_LIMIT` / `DAILY_QUERY_OVER_LIMIT`）、
   系统代理拦截（本机环境已知代理接管）、10s 超时（integrated 公交长途规划偏慢）。
   **失败根因目前被 `route.ts` catch `{ return null; }` 与 geocoder 同款静默吞掉，无任何日志**
   （spec 约定集成层静默降级、logger 由调用方传入，但当前调用链未传）。live 验证时建议临时在
   `route.ts:~110` catch 处打印 `err` 与 `body.info`，或走通 Fastify logger 线程化后再收口。
2. **延庆↔市区 transit 是否真能出方案**：city1=110119（延庆区）/city2=市区区县 adcode 的
   v5 transit/integrated 请求，AMAP 是否按跨城处理、是否返回空 `transits[]`（status=1 但无
   方案 → parseRoute 回 null）。上海/成都快照证明**同城区县级 adcode 是可用的**，但远郊区
   （原独立县）是否被高德公交网络当作独立城市未知。若确认区县级 adcode 是问题，备选方案：
   按 GB/T 2260 归一化为城市级（直辖市 AA0000、普通市 AABB00、省直辖县 BB=90 不动）——
   城市无关、无特判，但因现有成功 case 也在传区县级 adcode，未经 live 确认不敢先改。
3. **修复效果确认**：本波次 3 个修复落地后 live 重生成 beijing，观察 amap leg 占比是否显著
   回升（尤其 Day3 市内段与修订轮重试）。

## 3. 对层 2/3 的接口承诺

* `estimateTransit(origin, dest, mode)` 签名未变；新增公开常量 `LEG_SPEED_MODEL`
  （经 `@tripweaver/shared` barrel 导出）。
* 离线 eval 语义不变：快照存量 leg 用存量 durationMin，仅无 leg 段走新兜底。层 1 后离线重放
  与基线逐字一致（8 PASS + beijing 3 hard），无新增违规。
* 层 3 修复器重排后若删 leg 再重算，新估算即分段模型产物；overpacked 账目会随之变化，
  写断言时用上表校准值。
