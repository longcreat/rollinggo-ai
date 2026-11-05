# 第二期验收记录：确定性排程层（2026-09-21）

## 交付

| 文件 | 作用 |
| --- | --- |
| `apps/server/src/generation/scheduling/visitMinutes.ts` | 停留时长双轨（D2）：真实值 → xhsPlaceType 表 → 8 类目表 → 75 分钟，纯函数 |
| `apps/server/src/generation/scheduling/placeFacts.ts` | 批量补地点事实（停留时长/细粒度类型/themes/推荐分），失败降级为空 Map |
| `apps/server/src/generation/scheduling/schedule.ts` | 排程核心：天分配 + 日内排顺 + 餐窗切段时间轴，纯函数零 IO |
| `apps/server/src/generation/scheduling/buildDraft.ts` | 排程 → DraftTrip 落盘 + 住宿区域确定性推导 |
| `prompts.ts` | `WRITER_SYSTEM_PROMPT` + `writerUserPrompt` |
| `tools/draftTools.ts` | 新增 `update_description`（只改说明，结构改不动） |
| `orchestrator.ts` | plan 阶段替换为确定性排程 + 单次文案调用；审校循环删除 |

流水线：`research → 确定性排程(零 LLM) → geoPipeline → simulateTrip → 文案(1 次 LLM) → 落库`

## 验收结果

| 项目 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ 全 4 个 tsconfig |
| 单测 | ✅ **187/187**（新增 10 个排程单测：双轨时长、独占日、餐窗、预算、丢弃计数、空天占位、主题众数） |
| `node scripts/verify-c2.mjs` | ✅ **PASS —— C2 验收全过**（`verify-c2-run4.log`） |

verify-c2 新增/改写的检查：确定性排程只跑一轮、排程阶段零 LLM 规划工具、文案阶段工具面仅 3 个、文案改写已落库、排程保证每天至少一个活动、活动时间未被文案阶段改动、住宿区域由代码推导。

## 顺手修掉的既有 bug（已在本任务说明中标注）

`candidate 事件 3 条（同名去重）— count=4` / `overview 随行程持久化 — overview=4`：

`add_candidate` 的去重是「查池 → `await findXhsPlace` → push」，而 pi-agent-core 默认**并行**执行同一轮工具调用（`agent-loop.js:236`），两个同名调用都在 await 窗口前看到空池 → 重复入池。`await` 窗口是 09-18 PG 异步化引入的。

修法：给 `add_candidate` 加 `executionMode: 'sequential'`（1 行）。

## 端到端耗时：验证通过

`npx tsx test-gen-timing.mts` 跑通 4 次（模型换回 `cline-pass/deepseek-v4-flash` 后），全部 `done`：

| 指标 | 基线（09-20 run2） | 现在（run D） | 变化 |
| --- | --- | --- | --- |
| 总墙钟 | 793.4s | **114.4s** | **−86%** |
| research | 149.3s | 91.3s | −39% |
| **plan** | **597.8s** | **6.7s** | **−99%** |
| review（现为文案） | 35.6s | 15.5s | −56% |
| plan 阶段 LLM 轮次 | 14 | **0** | — |
| plan 阶段输出 token | 47228 | **0** | — |
| 总输出 token | ~63k | ~13.5k | −79% |
| 终态 | cancelled（撞 15min 超时） | **done** | — |

原始日志：`research/timing-after-deterministic.log`。

## 复跑中发现并修掉的两个排程 bug

这两个都是「跑真实数据才暴露」的，单测覆盖不到（单测数据是人工构造的规整坐标与时长）：

1. **`buildDraft` 提前丢弃无坐标候选**（7/18）—— 我在 `schedule.ts` 写了「无坐标按分数轮流补位」的分支，但调用方在更前面就 `continue` 掉了它，那段是死代码。修后无坐标候选照常排入，坐标留给 `geoPipeline` 解析（这才是既有设计）。
2. **贪心遇到放不下的点就 `break`** —— 最近邻撞上一个 480 分钟的点，整天空掉：3 天只排进 3 个活动、丢弃 8 个。改成「按距离升序逐个试，取第一个放得下的」后恢复到 8 个活动、丢弃 3 个。同时把无坐标补位的天平从「活动个数最少」改成「已占分钟最少」。

## 坐标兜底：不再依赖模型多调 search_pois（09-21 追加）

实测发现模型只调 4 次 `search_pois`（上限 8），导致 19 个候选只有 12 个拿到坐标、7 个靠补位。

**根因不在 prompt，在数据没用上**：`canonical_places.lng/lat` 1494/1494 全覆盖，但排程只读了 `research.locations`（高德旁路捕获值）。

先验证坐标系（`test-coord-system-check.mts`）：

```
故宫博物院  93m ✅   恭王府  64m ✅   天坛公园 161m ⚠️
颐和园    997m ❌   什刹海 1024m ❌（两者偏移方向相反）
```

基准错位（WGS-84→GCJ-02）是**同方向的 ~400m 系统性偏移**；这里点状地标只有 64~93m，两个大景区 ~1km 且方向相反 → 是「同一片区的不同代表点」，不是坐标系问题。**库内坐标与高德同系统，可直接用。**

改动：坐标优先取 `research.locations`（调研时高德实测值），没有则用 `canonical_places` 兜底（含 `payload.adcode`）。同时把 `search_pois` 的 prompt 指引从「补地点事实」改为「补知识库未覆盖的地点与封面图，不必为了坐标反复调」。

效果（同一份 3 天北京表单）：

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 排出的活动数 | 8 | **12** |
| 无坐标候选 | 7 | **1** |
| 排不下丢弃 | 3 | **0** |
| `search_pois` 调用 | 4 | 6 |

## 高德 API 的新定位

坐标不再靠它之后，`search_pois` 只负责知识库给不了的三样：**封面图**（`canonical_places` 的 payload 15 个 key 里没有任何图片字段）、**城市覆盖**（北京 912 / 重庆 618，其余 ≤21）、**知识库外的新点**。

## 下一个瓶颈：research 阶段（占 80%）

plan 阶段从 597.8s 压到 6.7s 后，research 成了唯一大头（91.3s / 114.4s = 80%），其中 LLM 等待约 84s。

值得注意的现象：本轮 research 调了 `search_verified_places` **17 次**、`search_pois` 只有 **4 次**，导致只有 12 个候选拿到坐标（7 个靠补位）。坐标来自 `search_pois` 的旁路捕获，所以 `search_pois` 调得太少会直接限制排程质量。
