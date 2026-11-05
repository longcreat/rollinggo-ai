# GitHub AI 旅行规划项目「编排行程」实现调研

日期：2026-09-22 ｜ 调研人：aimer + pi ｜ 关联任务：09-22-plan-no-timeline-chain-split

筛选标准：近半年活跃（pushed > 2026-03）、完成度较高（有测试/评测/文档，非教程玩具）。
来源：`gh search repos` + Tavily + searchcode 逐仓库读码。

## 编排实现光谱（从纯 LLM 到纯代码）

| 项目 | Stars | 编排由谁做 | 关键机制 |
|---|---|---|---|
| **FloatTrip** | 低但质量最高 | **CP-SAT 求解器（纯代码）** | OR-Tools 约束满足 + YAML 评分档案 + 质量门独立复算 |
| **Yuntu**（本地已有） | 52 | 代码锁定结构，LLM 填文案 | 381KB route_planning.py + 证据授权分级 |
| **tripweaver**（本项目） | — | 已转向确定性排程（014147d） | scheduling/ + 餐宿偏好驱动 |
| **TripStar-Java** | 58 | LLM（StateGraph 多智能体） | Spring AI Alibaba，图形化工作流但编排仍在 LLM |
| **travel-guidebook / trip-planner-skill** | 88 / 40 | LLM（Agent Skill 纯提示词） | SKILL.md 指令驱动，工具只做事实核验 |
| **TripStar (Python)** | 教程级 | LLM 一次吐全量 JSON | 文本协议 + 后端多层修复 |
| **voyant** | 64 | 无真正日编排 | 对话式 meta-agent + 自动验证 |

## 重点：FloatTrip 的编排实现（最值得到细读）

仓库：`shouzhuoshouzhuo/FloatTrip`，核心在 `app/planning/`。

### 流水线（LangGraph StateGraph）

```
weather_lookup → attraction_search（高德 POI 池）
→ candidate_builder（LLM 只标注候选语义）
→ optimizer（CP-SAT：选点 + 分天 + 天内排序 + 时刻表，全确定性）
→ quality_gate（独立复算校验，不合格回 candidate_builder）
→ finalize
```

planner/reviewer/time_check 节点只用于**修改流程**（revision graph），首次生成的结构完全不走 LLM。

### LLM 与求解器的分工

LLM 在 `candidate_builder` 只为每个候选 POI 标注结构化语义：

- `duration_min`（游玩时长）
- `preferred_period`（morning/afternoon/evening/any）
- `meal_scene`（lunch/dinner/either/none）
- `semantic_tags`（含 `high_fatigue` 高体力标签）
- `must_visit` / `fixed_day` / `fixed_start_min` / `before_poi_names`（先后约束）
- `cluster_id` 由 `cluster_pois_by_location` 按地理聚类赋（聚类数 = 天数）

### CP-SAT 模型（optimizer.py，813 行）

- 每天一条 `AddCircuit`（TSP 式天内路径）
- 开始时间变量受**营业时间**约束（从高德文本解析，含「周一闭馆」等按星期闭馆检测）
- 餐窗：午餐 11:30-13:30 / 晚餐 17:30-20:00，餐食候选须与窗口重叠 ≥45min
- 用户自然语言约束用正则提取每日景点数上下限（「每天最多3个景点」支持中文数字）
- 求解器固定种子 + 单 worker + 关随机搜索 = 可复现
- 失败回退：贪心按分数分天（就近亲和）+ 每天 `itertools` 全排列找可行时刻表

### 评分档案（scoring_profiles/balanced-v1.yaml，可调参外挂）

```yaml
rewards:   amap_rating 1.00 / preference_match 1.50 / category_diversity 0.50 / meal_scene_match 0.75 …
penalties: distance_per_km 0.12 / cross_cluster_arc 0.35 / weather_mismatch 1.00
           / consecutive_high_fatigue 0.50 / waiting_per_hour 0.25 / daily_load_imbalance_per_hour 0.30 …
```

objective_scale=6000 取整保证所有系数是精确整数（CP-SAT 要求）。

### 配套评测

tests/eval/：代码打分器 G1-G7（确定性）+ LLM 评委 + Reviewer 可靠性 + pass@k/pass^k。

## 其他项目编排要点

- **trip-planner-skill**（skywain，40★）：SKILL.md 驱动，编排靠 agent 自觉；亮点是「营业时间/价格/假期一律用工具核验，不许猜」+ 每个预订给链接。
- **TripStar-Java**（58★）：Spring AI Alibaba StateGraph 多智能体（小红书 Agent→POI/天气/酒店→规划），图框架编排流程，但日编排本身仍由 LLM 生成。
- **voyant**：对话式 meta-agent（Analyze→Plan→Act→Blend），有自动验证回路，无日级调度引擎。

## 对 09-22 任务的借鉴

1. **可借鉴**：FloatTrip 证明「LLM 标注语义 → 求解器编排」分工可行。我们已是确定性排程，但缺 FloatTrip 的几样：
   - **营业时间/闭馆日进编排约束**（他们从高德文本解析开放时间 + 星期闭馆检测，直接作为时间窗硬约束）
   - **评分档案外置 YAML**：奖惩系数从代码常量变成可调档案，支持多 profile 对比
   - **high_fatigue 语义标签**：连续高体力活动惩罚（我们无体力维度）
   - **quality_gate 独立复算**：求解器输出再过一遍校验节点，不合格回退重生成
2. **不宜引入**：CP-SAT 求解器本身——我们的场景（≤15 候选、≤7 天）贪心+成链切段已够，引入 OR-Tools 是过度工程（且 JS 侧无等价物，只能跑 Python 侧车）。
3. **已对齐**：餐窗约束、每日负载均衡、跨聚类弧惩罚 ≈ 我们的 maxStopsPerDay + 跨日重组 ±30min 门槛。
