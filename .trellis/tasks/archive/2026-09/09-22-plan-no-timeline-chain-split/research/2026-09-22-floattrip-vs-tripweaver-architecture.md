# FloatTrip 整体架构 vs tripweaver 全方位对比

日期：2026-09-22 ｜ 关联任务：09-22-plan-no-timeline-chain-split
对象：`shouzhuoshouzhuo/FloatTrip`（commit 54a7656）vs 本仓库（master 014147d）

## 一、技术栈与分层

| 维度 | FloatTrip | tripweaver |
|---|---|---|
| 后端 | Python 3.10 / FastAPI / LangGraph 1.2 | TS / Fastify / pi-agent-core（手写 orchestrator） |
| 存储 | SQLite + Redis 缓存层 | Postgres + pgvector（drizzle ORM） |
| LLM 接入 | `app/llm/factory.py` 按 provider 分发（DeepSeek/豆包） | `generation/model.ts` + BYOK + 站点级 key |
| 结构化输出 | Pydantic（字段顺序即 CoT 引导，见下） | TypeBox schema + 原生工具调用（工具即结构） |
| 前端 | JSX SPA + React Native 双端 | React web（单端） |
| 求解器 | OR-Tools CP-SAT | 无（成链切段 + 确定性排程） |
| 评测 | tests/eval：G1-G7 代码打分 + LLM 评委 + pass@k | eval/：金集快照 v2 + 研究质量观测指标 |

## 二、生成流水线结构对比

**FloatTrip**（LangGraph StateGraph，`app/planning/graph.py`）：

```
chat（多轮澄清 → Planning Brief 确认卡，interrupt 等用户确认）
→ weather_lookup → attraction_search（高德 POI 池）
→ candidate_builder（LLM 标注候选语义，唯一改结构的 LLM 节点）
→ optimizer（CP-SAT：选点/分天/排序/时刻表，纯代码）
→ quality_gate（独立复算，不合格回 candidate_builder）
→ planner ⇄ reviewer ⇄ time_check（修改流程专用子图）
→ meal_search → meal_recommend → tip_enrichment → finalize
```

**tripweaver**（手写 orchestrator 循环）：

```
research（LLM + search_verified_places/search_pois/search_web 工具）
→ retrieveContext（RAG 注入）
→ plan ⇄ review（LLM 多轮，修订轮局部修改）
→ 确定性 post-pass 链：geoPipeline（地理编码+legs）→ 确定性排程（scheduling/）
  → 可行性引擎 → 长途点修复 → 餐次覆盖 → 跨日重组 → writer（LLM 写文案）
→ persist
```

**根本分歧**：FloatTrip 是「图编排框架 + 求解器内核」，结构由图拓扑保证；tripweaver 是「手写编排器 + 确定性后处理链」，结构由编排器代码保证。两者都在收敛到同一个共识：**LLM 不做排程**。

## 三、各有亮点的设计

### FloatTrip 独有

1. **CoT 字段顺序引导**：Pydantic schema 里 `reasoning` 字段定义在结论字段之前，利用结构化输出按字段顺序生成的特性，强制先推理后结论——零成本提升输出质量，tripweaver 没有等价物（我们的工具调用参数没有这个维度）。
2. **双读者评审输出**：`RouteReview` 拆 `route_modify_opinion`（给 planner，诊断语气）和 `issues`（给用户，温和可执行，**禁用「违规/冲突」等技术词**）。tripweaver 的 reviewNotes 单读者混写。
3. **TimeCheck Agent 反矛盾设计**：要求 reasoning 覆盖所有景点，violations 只从结论中筛——防止「边推理边打标签」的遗漏。
4. **持久化 Run**：队列/取消/重试/断线恢复/SSE 回放/`interrupt` 挂起等用户确认（`app/runtime/` 9 个模块）。tripweaver 是进程内 jobManager，重启即丢。
5. **长期旅行记忆**：偏好/避雷带来源、作用域、审计，用户可审批/编辑/忘记，单次旅行可临时覆盖。tripweaver 无记忆概念。
6. **评测指标更硬**：pass@k（能力下界）与 pass^k（可靠性）分开，reviewer 误放行率/误打回率/planner 反驳率/忽略率——把 Agent 间博弈也量化了。
7. **营业时间进编排**：高德文本解析开放时间 + 星期闭馆检测（「周一闭馆」），直接做 CP-SAT 时间窗硬约束；评测 G2 专门卡这条。
8. **fixture 冻结真实 POI 池**：`capture_pool.py` 抓一次高德池骨架存成 JSON，评测可复现。等价于我们金集，但冻结的是**输入**（POI 池+天气）而非输出。

### tripweaver 独有 / 更强

1. **自有知识库**：canonical_places + research_evidence（小红书管线）+ 证据强度分级 + 向量召回。FloatTrip 只有高德 POI + 天气，无内容情报层。
2. **生成可观测性**：llm_request_logs 全量落库（每轮 messages/tools/response），FloatTrip 只有 runtime 级事件。
3. **配额与成本治理**：BYOK、站点日预算、每任务调用上限、Amap 熔断器。FloatTrip 无此层。
4. **Web 编辑器**：行程拖拽编辑 + 派生重算。FloatTrip 也有编辑（拖拽/撤销重做/服务端距离重算），打平。
5. **部署形态**：单仓 monorepo 全 TS，FloatTrip 前后端+移动端三仓分离。

### 打平但实现不同

| 主题 | FloatTrip | tripweaver |
|---|---|---|
| 防幻觉 | G1 封闭池检查（事后） | 候选池 poiId 引用 + submit 校验（事前） |
| 餐次 | meal_scene 标签 + 餐窗重叠 ≥45min 进求解器 | 餐次覆盖确定性修复 post-pass |
| 天气 | 进 CP-SAT 罚分（雨雪罚露天点） | 进 prompt 提示 |
| 降级 | 求解器失败 → 贪心回退 | 全链路 generation-never-fails |

## 四、对 tripweaver 的可操作借鉴（按 ROI）

1. **reviewer 输出双读者拆分**（低成本高价值）：revisionRequests 已有，再补一个「给用户的温和提醒」字段，前端直接展示。改动在 reviewer prompt + schema + 前端渲染。
2. **营业时间/闭馆日约束**（中成本高价值）：高德 POI 详情带 open_time，解析后喂给确定性排程做时间窗校验。FloatTrip 的 `parse_open_interval` + `_closed_on_date` 正则可直接翻译。这是真实翻车点（金集已见周一闭馆问题）。
3. **fixture 冻结输入池**（低成本）：把金集输入从「依赖实时搜索」改成冻结 POI 池快照，评测可复现性上一个台阶。
4. **Run 持久化**（高成本高价值，属平台演进）：进程内 jobManager → SQLite/PG 持久化 Run + SSE 回放。FloatTrip runtime/ 9 个模块可作参考设计。
5. **pass^k 可靠性指标**（低成本）：eval 已有 pass 率，补一个「k 次全过」指标衡量稳定性。

## 五、明确不借鉴

- **LangGraph**：迁移成本远大于收益，手写 orchestrator 已覆盖条件循环/修订轮，且 TS 侧 LangGraph.js 生态弱。
- **CP-SAT**：同前一份调研结论，候选规模用不上求解器；其评分档案 YAML 的思路已在上一份调研记录。
- **长期记忆**：产品定位不同（tripweaver 偏单次生成工具），非当前优先级。
