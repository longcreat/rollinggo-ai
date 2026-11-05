# FloatTrip 对话式规划：交互流程与数据契约

调研对象：https://github.com/shouzhuoshouzhuo/FloatTrip @ `54a7656`
调研方式：searchcode 读取仓库源码（未 clone）。
参考价值：**最高**。它是「对话 → 结构化确认 → 正式规划」这条链路最完整的开源实现，且同样是多 Agent 生成行程。

---

## 一、核心结论：对话与规划是两件事

FloatTrip 最值得抄的就是这条边界：

```
用户消息 ──► [Chat Run] LLM 理解 ──► DialogueDecision
                                        │
                    ┌───────────────────┼────────────────────┐
                    ▼                   ▼                    ▼
              reply（聊天回复）   brief_patch（更新 Brief）  intent=confirm_plan
                                                              │
                                                              ▼
                                                    [Planning Run]（独立 Run）
```

**对话永远不直接生成行程。** 对话只做三件事：抽取参数、回答旅行问答、更新 Planning Brief。
只有 `intent === "confirm_plan"` 且 Brief 通过 `required_brief_fields` 校验时，才创建正式 Planning Run。

为什么这样分（从代码反推）：
- 规划耗时 1–3 分钟，不能挂在聊天请求生命周期上 → 拆成持久化 Run
- 用户可能聊 10 轮才决定出发日期 → 对话必须廉价、可无限进行
- Brief 是「已确认的事实快照」，规划只在快照上跑，避免边聊边生成导致的反复推翻

> 对我们（TripWeaver）的映射：现有 `POST /api/generations` + SSE 就是 Planning Run 的雏形，只是入口从表单换成对话。

---

## 二、DialogueDecision：唯一能触发业务动作的模型输出

`app/chat/models.py`：

```python
class DialogueDecision(_StrictModel):
    intent: Literal[
        "travel_qa", "general_chat", "create_plan", "update_brief",
        "confirm_plan", "modify_itinerary", "run_control", "unclear",
    ]
    reply: str                                  # 给用户看的话
    brief_patch: PlanningBriefPatch             # 对 Brief 的增量修改
    target: DialogueTarget                      # run_id / itinerary_id
    run_action: Literal["none", "cancel", "retry"]
    modification_notes: str | None
    clarification: DialogueClarification | None  # 单字段追问
    requires_confirmation: bool
```

设计要点：
1. **`reply` 和 `brief_patch` 同一次调用产出** —— 模型一边回复用户，一边顺手把结构化字段写进 Brief。不需要第二次「抽取」调用。
2. **全部是增量 patch，不是全量覆盖** —— `PlanningBriefPatch` 每个字段可空；`remove_trip_constraint_ids` / `excluded_memory_fact_ids` / `restored_memory_fact_ids` 支持删除与恢复。
3. **`intent` 是白名单枚举** —— 模型只有 8 个动作可做，不是自由发挥。
4. **`clarification` 携带 options** —— `DialogueClarification(field, question, options: list[str])`，最多 8 个选项。追问也能给按钮。

`_StrictModel` 全部 `extra="forbid"`，杜绝模型塞入未定义字段。

---

## 三、PlanningBrief：确认卡的数据结构

`app/chat/models.py` → `PlanningBriefPatch`：

| 字段 | 说明 |
|---|---|
| `destination` | 目的地 |
| `start_date` / `end_date` / `days` | 日期（三种表达都要支持：起止日期、天数） |
| `trip_focus` | `sights_first` / `food_first` / `balanced` —— 三选一枚举 |
| `budget` / `trip_budget` | 预算 |
| `attraction_preference` / `food_preference` / `habit_preference` | 三个自由文本偏好 |
| `trip_constraints[]` | **本次行程的约束**（不是长期记忆） |
| `remove_trip_constraint_ids[]` | 删除本次约束 |
| `excluded_memory_fact_ids[]` / `restored_memory_fact_ids[]` | 单次行程对长期记忆的排除/恢复 |

`TripConstraintPatch` 是本项目最值得抄的部分：

```python
class TripConstraintPatch(_StrictModel):
    id: str | None
    category: Literal[
        "attraction_preference", "food_preference", "dietary_requirement",
        "travel_pace", "budget_style", "transport_preference",
        "accommodation_preference", "schedule_preference", "companion_context",
        "accessibility_need", "other_travel_preference",
    ]
    value_text: str = Field(min_length=1, max_length=500)
    polarity: Literal["prefer", "avoid", "require", "fact"] = "fact"
    evidence_sequences: list[int] | None   # 追溯：这条约束来自第几条消息
```

三个关键设计：
- **`polarity`**：偏好 / 避开 / 必须 / 仅背景。UI 上四种颜色和文案完全不同（见下）。
- **`category` 有 11 个枚举**，不是一坨自由文本 → 可分类展示、可去重合并。
- **`evidence_sequences`**：约束能追溯到具体的聊天消息 → 用户问「你为什么这么安排」时有据可查。

### Brief 就绪校验（`app/core/planning_brief.py`）

```python
def required_brief_fields(data) -> list[str]:
    # destination 非空
    # start_date / end_date 可解析为 ISO 日期
    # end_date >= start_date
    # trip_focus ∈ {sights_first, food_first, balanced}
```

**必需字段只有 4 个：目的地、开始日期、结束日期（或天数）、旅行侧重点。**
其余全部可选。

失败时构造稳定 contract：

```python
def required_input_interrupt(missing_fields) -> dict:
    if missing == ["trip_focus"]:
        return {
            "question": "这趟更想景点为主、吃吃喝喝为主，还是两者均衡？",
            "missing_fields": ["trip_focus"],
            "input_schema": {"type": "string", "enum": ["景点为主", "吃吃喝喝为主", "均衡安排"]},
        }
    return {"question": f"为了继续规划，还需要补充：{labels}。",
            "missing_fields": missing, "input_schema": {"type": "string", "minLength": 1}}
```

`input_schema` 直接驱动前端控件类型（枚举 → 单选按钮，无枚举 → 文本框）。

### Brief 状态机

`collecting` → `ready` → `submitted` / `discarded`

**只有 `ready` 状态才在消息流里渲染确认卡**（`frontend/chat-state.js` 注释原文：*"Collecting requirements are handled conversationally. Only a ready brief gets a compact, actionable confirmation surface in the feed."*）——收集阶段靠聊天，不要一路弹卡片。

---

## 四、前端状态机（`frontend/chat-state.js`，481 行纯 reducer）

无框架依赖的实体化 reducer，`applyEvent(state, runId, event) → state`。状态分片：

```js
{
  messages: {},          // 按 id
  messageOrder: [],      // 排序
  briefs: {},            // planning brief
  runs: {},              // Run 状态与进度
  agentActivities: {},   // Agent 活动（工具调用可视化）
  cursors: {},           // 每个 run 的 last sequence，幂等去重
}
```

关键机制：

1. **`cursors` 做事件幂等**：`if (seq <= state.cursors[runId]) return state` —— SSE 断线重连后重放不会重复追加。
2. **消息流式合并**：先建临时消息 `assistant:{runId}`，累加 delta；收到 `chat.message.completed` 时**删临时 id、插入真实 id**（带 sequence）。

```js
if (payload.kind === "chat.message.completed") {
  delete next.messages[`assistant:${runId}`];      // 删临时
  upsertMessage(next, { id: payload.message_id, content: payload.content, sequence: payload.sequence, streaming: false });
}
```

3. **消息流里的实体类型**（`activityItems()`）：`message` / `chat_thinking` / `brief` / `run` / `chat_failure`。按 `sequence` → `createdAt` → `typePriority` 三级排序。**工具调用不是消息，是独立实体**。

4. **产品阶段把内部节点折叠成 4 段**：

```js
PRODUCT_STAGES = [
  { key: "understand", label: "理解旅行需求" },
  { key: "discover",  label: "搜集目的地信息" },
  { key: "compose",   label: "编排行程与优化路线" },
  { key: "polish",    label: "完善旅行细节" },
];
INTERNAL_STAGE_MAP = { intent: "understand", planner: "compose", reviewer: "compose", meal_search: "polish", ... };
```

即：用户看到 4 步，内部实际跑 14 个节点。**这是「有进度感」的关键** —— 不透出 `quality_gate`、`time_check` 这类实现细节。

5. **`advanceRunStage` 只前进不后退**：`Math.max(incomingIndex, currentIndex)` —— LLM 重试导致的阶段回跳不会让 UI 抖动。

6. **会话关注度徽章**（`conversationAttention`）：

```
archived → 已归档
has_waiting_user     → 待你回复
has_ready_brief      → 待确认
has_active_planning  → 规划中
has_unread_completed → 新行程
```

侧边栏会话列表靠这个函数渲染状态点 —— 用户离开页面后回来能一眼看到「哪个对话在等我」。

7. **四种约束极性的 UI 文案**（`constraintPresentation`）：

| polarity | 徽章 | 摘要标签 | 效果说明 | 排除按钮 |
|---|---|---|---|---|
| `prefer` | 优先考虑 | 偏好 | 规划时会优先考虑 | 本次不优先 |
| `avoid` | 本次避开 | 避开 | 规划时将排除，不纳入候选行程 | 本次允许安排 |
| `require` | 必须满足 | 必须 | 将作为本次行程的硬性要求 | 本次取消要求 |
| `fact` | 仅作背景 | 背景 | 只用于理解行程，不代表要安排 | 本次不参考 |

**`fact` 这个极性很重要** —— 「我带着 3 岁小孩」是背景信息，不是「必须安排亲子景点」。大多数产品在这里搞混，导致 AI 用力过猛。

---

## 五、Run 生命周期（`app/runtime/models.py`）

```python
class RunKind(StrEnum):     CHAT / TRAVEL_PLAN / REVISION / SPOT_TIPS
class RunStatus(StrEnum):   QUEUED / RUNNING / WAITING_USER / SUCCEEDED / FAILED / CANCELLED

ALLOWED_TRANSITIONS = {
    QUEUED:       {RUNNING, CANCELLED, FAILED},
    RUNNING:      {WAITING_USER, SUCCEEDED, FAILED, CANCELLED},
    WAITING_USER: {RUNNING, CANCELLED, FAILED},   # 但回不去 QUEUED
    SUCCEEDED: set(), FAILED: set(), CANCELLED: set(),   # 终态不可变
}
```

- **`WAITING_USER` 是一等状态**，不是「暂停」。规划中途缺信息 → 进 `WAITING_USER` → `interaction` 携带 `input_schema` → 用户回答 → 回 `RUNNING`。
- **`validate_transition` 显式校验**，非法转换抛异常。终态不可复活。
- **并发键**：`chat:{conversation_id}` / `revision:{itinerary_id}` / `plan:{run_id}` —— 同一会话的 Chat 串行，不同会话并行。

### 事件契约

```python
class PublicEvent(BaseModel):
    run_id: str
    sequence: int | None          # 有 sequence = 可持久化、可重放
    kind: Literal["messages", "custom", "error", "heartbeat", "end"]
    payload: dict
    durable: bool
```

`CUSTOM_EVENT_TYPES`（都是 `extra="forbid"` 的强类型）：

| 事件 | 用途 |
|---|---|
| `PlanningBriefEvent` | `planning_brief.{updated,ready,submitted,discarded}` + `summary` + `missing_fields` |
| `PlanningProgressEvent` | `planning_run.progress` + `stage` + `label` + `round` |
| `WaitingUserEvent` | `run.waiting_user` + `interaction_id` + `question` + `missing_fields` + `input_schema` |
| `ItineraryCreatedEvent` | `planning.itinerary_created` + `itinerary_id` |
| `ItineraryTipStatusEvent` | 后台补充 tips 的状态 |
| `AgentActivityEvent` | `agent.activity.{started,progress,completed,failed}` + `activity_type` + `label` + `stats` |

`agent.activity.*` 的 `activity_type` 枚举：`memory_lookup` / `planning_context` / `itinerary_search` / `itinerary_read` / `brief_update` / `planning_submit` / `revision_start` / `run_control` —— **给用户看「AI 在干什么」的独立通道**。

### SSE 重放（`app/runtime/stream.py`）

```python
class StreamBridge:
    def __init__(self, retention=256, heartbeat_seconds=15.0)
    # 每 run 一个 deque(maxlen=256) 历史 + 一组 asyncio.Queue 订阅者
    # subscribe(run_id, after_sequence=N) 先回放历史中 seq > N 的项，再进入实时
    # 空闲 15s 发 heartbeat；遇到 kind == "end" 结束迭代
```

- 队列满时丢最旧（`maxsize=retention`），保证不阻塞生产者。
- **`after_sequence` 是客户端游标** —— 对应前端 `cursors`。断线重连只需带上最后收到的 sequence。
- 单机内存实现，README 明确标注「多节点部署边界见 docs/agent-runtime.md」。

---

## 六、值得借鉴（按优先级）

1. **对话与规划分离**（Chat Run vs Planning Run），Brief 作为边界契约 —— 直接决定了整个架构能否成立。
2. **`required_brief_fields` 只卡 4 个必填**，其余可空、可后补 —— 降低对话长度。
3. **`input_schema` 由后端下发**，前端据此选控件（enum → 单选，无 enum → 文本）—— 前端不需要硬编码字段列表。
4. **`trip_constraints` 带 `polarity` + `category` + `evidence_sequences`** —— 尤其 `polarity: "fact"` 这个极性。
5. **4 段产品阶段折叠 14 个内部节点**，且阶段只前进不后退。
6. **`cursors` 幂等 + `sequence` 全量重放** —— 我们已有 SSE，但需确认是否带 sequence。
7. **`conversationAttention` 关注度徽章** —— 对话列表的状态感知。
8. **`WAITING_USER` 一等状态** —— 我们目前只有 running/done/error/cancelled。

## 七、不适合照搬

| 项 | 原因 |
|---|---|
| Python / LangGraph / Pydantic | 我们是 TypeScript + Zod / 手写校验 |
| `frontend/*.jsx`（无构建，浏览器内 Babel） | 我们是 Vite + React 19 + TS |
| StreamBridge 内存实现 | 单节点；若要水平扩展需换 Redis / Postgres LISTEN |
| 长期记忆（`travel_memory.py` 555 行 + `memory_service.py` 587 行） | **本次不纳入 MVP**，但数据模型（类型 / 作用域 / 来源 / 审计）值得单独开任务 |
| 移动端 React Native | 不在范围内 |
| `spot_tips` 后台任务 | 边缘功能，我们已有行程编辑器 |
| 评测体系（G1–G7 打分器） | 我们已有 `eval/` 目录，暂不扩展 |

## 八、关键文件索引

```
app/chat/models.py                 # DialogueDecision / PlanningBriefPatch / TripConstraintPatch
app/core/planning_brief.py         # required_brief_fields + required_input_interrupt
app/core/planning_constraints.py   # 约束归一
app/runtime/models.py              # RunKind / RunStatus / PublicEvent / CUSTOM_EVENT_TYPES
app/runtime/stream.py              # StreamBridge（回放游标 + heartbeat）
frontend/chat-state.js             # 481 行 reducer：applyEvent / activityItems / briefViewModel
docs/conversation-entry-migration.md   # 22 行，对话入口与登录边界
docs/agent-runtime.md              # Run 生命周期契约
```
