# 行程精细化（行前体检）设计方案

> 状态：规划稿，未实施 ｜ 参考：出发鸭 Preparing Pipeline（见 docs/GODUCK_INTERACTION_RESEARCH.md §四）
> 核心判断：生成是免费的，可信才是收费的。第一次生成的行程常有"看着合理、物理不可行"的硬伤；
> 精细化 = 把已有的可行性引擎从"生成时的内部防线"提升为"用户可见、可交互、可重排"的产品入口。

---

## 1. 用户故事

```
生成完成 → 行程详情页出现「精细化检查」入口（徽章显示已发现的硬冲突数）
  ↓ 点击
Pass 1 自动体检（30s 内）：
  · 确定性规则：单日超载 / 步行过量 / 缓冲比 / 折返角 / 闭馆日 / 远郊混排 / 换乘过紧
  · 子代理实时核验：预约政策（web_search）/ 最新营业时间（search_places）/ 天气窗口（get_weather）
    ↓
决策卡列表（每个冲突一张）：
  ┌────────────────────────────────────────────┐
  │ 第 3 天超载：活动 5 个 + 通勤 2.6h，共 12.5h │
  │ 建议：把「东郊记忆」挪到第 4 天下午          │
  │ [按建议改] [我自己处理] [跳过] [留言]        │
  └────────────────────────────────────────────┘
  ↓ 用户逐项处置（或一键全按建议）
Pass 2 自动重排：消费决策 → 挪动/删除/保留 → repairChangedRoutes 重算动线 → 落新版本
  ↓
准备报告：「已修复 3 处、保留 1 处、跳过 1 处；新增提醒：杜甫草堂需提前 7 天预约」
```

---

## 2. 与出发鸭的对照与取舍

| 出发鸭 | 我们的方案 | 取舍理由 |
|---|---|---|
| 10 条物理规则（含酒店设施/节假日排队） | 先做 7 条我们引擎已有的 | 规则引擎已存在，不新写 |
| 体检在独立 Preparing 状态 | 体检挂在行程详情页，复用 Agent 通道 | 我们是 Web 产品，不需要状态机大迁移 |
| 决策卡四动作（accept/selfHandle/skip/comment） | 完全照抄四动作 | 这是被验证过的交互 |
| Pass 2 云端 Agent 消费决策重排 | 确定性代码重排（longHaulFixer 扩展） | 已有"识别→挪动→验证→回滚"闭环，不靠 LLM |
| 子代理核验（分日探索） | 子代理按"冲突类型"派发而非按天 | 我们的冲突已有结构化定位（dayIndex/activityId） |
| 准备报告（注意事项/穿衣/天气预警） | 复用 tripAdvice + 体检结果汇总 | 文案层拼接，不新增模型调用 |

**刻意不做的**：出发鸭的酒店设施规则（`hotel_missing_amenity`，我们无酒店数据）、节假日排队预测（无数据源）。规则表先收敛到有真实数据支撑的。

---

## 3. 架构：三段流水线，两段确定性、一段 Agentic

```
┌─ Pass 1a 确定性审计（零 LLM，<100ms）────────────────────┐
│ 复用：feasibility.ts（6 规则）+ longHaul 情报 + geoSanity │
│ 产出：结构化 Finding[]（code/severity/dayIndex/活动锚点）│
└──────────────────┬───────────────────────────────────────┘
                   ↓ 按 Finding 类型决定要不要实时核验
┌─ Pass 1b 子代理核验（Agentic，最多 3 个子代理）─────────┐
│ kinds=notes 子代理：                                    │
│   · booking_required → web_search 查预约政策           │
│   · open_time_changed → search_places 查最新营业时间    │
│   · weather_risk → get_weather 查行程日期天气窗口       │
│ 结构化返回（复用现有 SubagentNote 契约）                 │
└──────────────────┬───────────────────────────────────────┘
                   ↓
┌─ 决策卡（落库 pending_decisions 表，跨刷新不丢）────────┐
│ 每个 Finding → 一张卡：建议动作 + 三选一 + 留言          │
└──────────────────┬───────────────────────────────────────┘
                   ↓ 用户处置完成
┌─ Pass 2 确定性重排（零 LLM）────────────────────────────┐
│ 扩展 longHaulFixer 模式：accept → 执行建议（挪/删）      │
│   → 重验 feasibility → 不达标回滚（单步）               │
│ → repairChangedRoutes → createTrip 新版本                │
└─────────────────────────────────────────────────────────┘
```

**为什么 Pass 2 不用 LLM**：挪动/删除是确定性操作，建议本身在 Pass 1 已生成（有 dayIndex + activityId 定位）；
LLM 重排会引入新的不可行风险，还贵。longHaulFixer 的"每步验证不过即回滚"纪律直接复用。

---

## 4. 规则清单（第一版 7 条，全部有现成代码基础）

| # | code | severity | 现有基础 | 建议动作 |
|---|---|---|---|---|
| 1 | `day_overpacked` | hard | feasibility hardDayTotalMin（>14h） | 挪最末活动到最闲天 |
| 2 | `walk_overload` | soft | feasibility softWalkMeters（>15km） | 提示 + 建议删一站 |
| 3 | `buffer_too_tight` | soft | feasibility softBufferRatio（<10%） | 提示压缩说明 |
| 4 | `backtrack` | soft | feasibility backtrack 规则（回头角+回跳） | 建议重排当天顺序（reorder） |
| 5 | `closed_day` | hard | 闭馆日检测（placeFacts openHours） | 替换为同片区备选（子代理查） |
| 6 | `longhaul_mixed` | hard | longHaulFixer 模式识别 | 挪市区活动到别的天（已有） |
| 7 | `transfer_too_tight` | hard | 大交通相邻段预留 < 阈值 | 提示提前/顺延 |

子代理核验触发表（按 Finding 动态决定）：

| Finding 特征 | 派发 | kind | 查什么 |
|---|---|---|---|
| 含强预约景区（reservationSeeds/库内 required） | 1 个 | notes | 最新预约渠道与放票窗口 |
| hard 超载天 | 1 个 | places | 当天附近的"半小时级"轻量备选点 |
| 行程日期在未来 15 天内 | 1 个 | notes | 天气窗口与穿衣提醒 |

---

## 5. 数据模型与协议

```sql
-- 一次体检会话（跨刷新持久）
CREATE TABLE IF NOT EXISTS trip_health_checks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,          -- 体检对象版本
  status TEXT NOT NULL,           -- pending | awaiting_decisions | completed | expired
  findings JSONB NOT NULL,        -- Pass 1 产出（含子代理核验补充）
  decisions JSONB,                 -- 用户处置：[{findingId, action, comment}]
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ
);
```

SSE 事件扩展（沿用 ChatStreamEvent 模式）：

```
health_started      → { checkId }
health_finding      → { finding }          // 每发现一条推一条（打字机感）
health_subagent     → { name, status }     // 子代理核验进度
health_awaiting     → { findings }         // Pass 1 完成待决策
health_applied      → { version, outcomes }// Pass 2 完成
```

前端组件：
- `HealthBadge`：详情页入口 + hard 冲突数徽章
- `HealthCheckSheet`：决策卡列表（复用 ask_user 卡片的视觉）
- 决策卡四动作按钮 + 留言输入

---

## 6. 复用清单（这是我们做这个功能便宜的原因）

| 复用 | 来源 |
|---|---|
| 结构化违规 | `packages/shared/src/feasibility.ts` Violation（code/severity/dayIndex/activityId/message 全齐） |
| 挪动-验证-回滚 | `generation/longHaulFixer.ts` 的修复纪律（每步验证、递减判据、回滚） |
| 子代理派发 | `chat/agent/subagent.ts`（createSubagentTool，kind=notes/places 已有） |
| 顺序重排 | `generation/routeCoherence.ts` optimizeRouteOrder |
| 动线重算 | `services/tripHistoryService.ts` repairChangedRoutes |
| 版本落库 | `services/tripService.ts` createTrip + commitOperation 幂等 |
| 实时核验工具 | search_places / web_search / get_weather（Agent 工具，已上线） |
| 决策卡视觉 | ask_user 卡片设计（PERSON_AGENT_PLAN §7 AskUserCard） |
| SSE 桥 | chat/agent/runtime.ts 事件翻译层 |

**需要新写的（估计 ~1200 行）**：

| 模块 | 行数 | 说明 |
|---|---|---|
| `services/healthCheckService.ts` | ~350 | 体检编排：Pass1a 规则汇聚 + 决策消费 + Pass2 |
| `chat/agent/healthSubagents.ts` | ~150 | 按 Finding 派发核验子代理（复用 createSubagentTool） |
| `generation/healthRepair.ts` | ~250 | Pass 2 确定性执行器（accept→挪/删→重验→回滚） |
| `routes/healthCheck.ts` | ~120 | REST + SSE 端点 |
| migration | ~10 | trip_health_checks 表 |
| shared 契约 | ~150 | Finding/Decision/事件 schema |
| 前端 HealthBadge + HealthCheckSheet | ~300 | 决策卡交互 |

---

## 7. 分阶段实施

### H0 骨架（2 天）
- [ ] trip_health_checks 表 + Finding/Decision schema
- [ ] healthCheckService：Pass 1a 纯确定性审计（复用 feasibility，不加子代理）
- [ ] REST：POST /api/trips/:id/health-check → findings；前端先只读展示
- [ ] 验收：对任意行程调一次，返回结构化 findings；hard 数与 feasibility 内部一致

### H1 决策卡闭环（3 天）
- [ ] 决策卡 UI（四动作）+ decisions 落库
- [ ] Pass 2：healthRepair（accept → 挪/删 → repairChangedRoutes → 新版本）
- [ ] 验收：体检 → 处置 3 条 → 新版本 vN+1 落库，动线重算，历史可回滚

### H2 子代理实时核验（2 天）
- [ ] healthSubagents：预约政策/营业时间/天气三类派发
- [ ] 核验结果合并进 Finding（"最新确认：需提前 7 天预约"）
- [ ] 验收：含预约景区的行程，体检卡上出现实时核验的预约说明

### H3 准备报告（1 天）
- [ ] 体检完成 + 处置完 → 汇总报告（注意事项/天气提醒/未处理清单），写入行程 meta

合计约 8 天。H0 完成即可让用户"看到"行程的问题（信任建立），H1 完成即是完整闭环。

---

## 8. 风险与边界

| 风险 | 对策 |
|---|---|
| 规则误报（如远郊日被误判超载） | 每张卡都有 skip；重排每步验证不过即回滚（longHaulFixer 纪律） |
| 子代理核验信息过时（预约政策变化） | 核验结果标注"截至今天"；卡上显示核验时间 |
| 与用户手动编辑冲突 | 体检会话绑定 tripId+version；处置提交时校验版本（409 刷新提示） |
| 规则阈值需调 | FEASIBILITY_THRESHOLDS 已是常量表，运营可调 |
| 过度打扰 | hard 才出徽章；soft 折叠；体检结果缓存（同版本不重复跑 Pass 1a） |

---

## 9. 与既有规划的关系

- PERSON_AGENT_PLAN P4「打磨与评测」中的"逾期/限额/注入攻击用例"不变
- 本方案可视为 P4 的具体化 + 出发鸭调研的第 5 项落地，优先级建议排在 ask_user（P3）之后：
  - P3 ask_user 上线 → 决策卡的卡片 UI 与挂起协议可直接复用
  - 本方案 H0-H1 → P4
