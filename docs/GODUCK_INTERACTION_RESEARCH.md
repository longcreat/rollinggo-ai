# 出发鸭（GoDuck）Agent 交互调研报告

> 调研日期：2026-11-05 ｜ 调研对象：本机 `/Applications/出发鸭.app`（iOS ARM64 客户端）
> 方法：基于既有逆向资产（架构文档、57 工具逆向、功能清单）+ 二进制字符串 dump + `plan_map.html` 地图引擎源码提取，对照 trip-weaver 现状做落地评估。
> 原始资料：`~/Desktop/work/Test/出发鸭/`（GoDuck_Agent_Architecture.md / GoDuck_Tool_Code_Reverse_Analysis.md / GoDuck_Full_Feature_Inventory.md / cstring_dump.txt / plan_map.html）

---

## 一、出发鸭 Agent 交互的骨架：三阶段生命周期

出发鸭把一次旅行拆成三个状态，每个状态有完全不同的交互形态。这是它最值得学的顶层设计——**Agent 不是"一个聊天框"，而是随行程状态切换的三个工作面**：

| 阶段 | 交互核心 | 用户心理 | Agent 角色 |
|---|---|---|---|
| **Planning 规划中** | 地图 + 思维链 + 追问卡 | "它在认真帮我办事" | 编排者：派子代理、查资料、问用户 |
| **Preparing 行前** | 冲突决策卡 + 准备报告 | "它帮我兜住了风险" | 审计员：跑规则体检、给三选一 |
| **Active 出行中** | 焦点 HUD + 伴游预警卡 | "它在陪着我" | 伴游：监听位置、主动提醒、动态改排 |

trip-weaver 目前只做了 **Planning 阶段**（详情页对话改行程）。出发鸭证明 agent 产品的价值曲线在后两个阶段：行前体检是"信任建立器"，出行伴游是"留存钩子"。

---

## 二、规划中：主子代理的交互编排（我们最该对照的部分）

### 2.1 出发鸭的做法

**子代理可视化** —— 每个分日/领域子代理（`explore_sub_day1`、`explore_sub_hotel`）在 MapLibre 地图上有独立的"基地雷达点"（`GDPlanAiBasePush`），带扩散脉冲动画；子代理搜到的候选 POI 按子代理分组绘制（`GDPlanAiMark` + SuperCluster 聚类），支持聚焦某个子代理看它的成果（`GDPlanAiSetFilter`）、AI 自动运镜到当前规划区域（`GDPlanAiFocus`）、弹推荐理由气泡（`GDPlanAiPopup`）。

**深度思维链视窗** —— `ThinkingStream`/`ThinkingChainCard` 实时打字输出思考过程 + 实时计时器；每步工具调用显示为胶囊（`TurnProcessPill`："查询火车班次"、"高德路线核算"）。

**人在回路选择题** —— 子代理遇到模糊偏好（住古城还是双廊）时挂起（`blockedOnQuestion`，reflstr 直查确认），下发 `QuestionSpec`（single_choice / multi_select，带 allowSkip），前端渲染富文本卡（地点图、评分、人均、标签）。`askQueue` 防抖去重、**最大排队深度 8、溢出丢最旧**。

**地图协同 JS Bridge 全表**（`plan_map.html`，29 个接口，AI 专属 13 个）：
```
GDPlanAiBasePush(sid, lat, lng, label, color)   子代理基地雷达点 + 脉冲
GDPlanAiBaseStatus(sid, status)                 running | succeeded | failed
GDPlanAiBaseRemove(sid)                         子代理结束移除
GDPlanAiMark(group, points, replace, autoZoom)  按子代理分组绘制候选 POI
GDPlanAiSetFilter(sid)                          聚焦某子代理成果，淡化其余
GDPlanAiFocus(lat, lng, zoom, label)            AI 运镜到规划中的区域
GDPlanAiPopup(lat, lng, title, body, imageUrl)  AI 推荐理由气泡
GDPlanAiHighlight(lat, lng, name, durationMs)   路线/地标闪烁高亮
GDPlanAiClear(group)                            清除某组探索标记
GDPlanAiGroupFocus/Hide/Show                    候选分组显隐与聚焦
```

### 2.2 对照 trip-weaver

| 出发鸭 | 我们现状 | 评估 |
|---|---|---|
| 子代理地图雷达点 | 无 | 差距大，但依赖地图端深度改造 |
| 思维链视窗（打字机 + 计时） | progress 文本一行 | **低成本可抄**：progress 已有事件，前端加时间戳和步骤胶囊即可 |
| 工具胶囊（TurnProcessPill） | ChatProgress 已有类似 | 已对齐 |
| askQuestion 结构化卡 + askQueue(8) | 旧链路有 clarification；新 Agent 无 | **P3 的 ask_user 应直接抄 QuestionSpec 形状** |
| 子代理按组绘制候选点 | candidates 卡片有，地图无 | 中期项 |

---

## 三、交互文案系统：人格化 + 分类话术（可直接抄）

出发鸭的 agent 有固定人格名"**小路**"，所有交互文案围绕它。逆向提取的完整文案系统：

### 3.1 工具执行的伴游话术（按工具名关键词分派，`0x10040bc30`）

| 工具特征 | 话术 |
|---|---|
| `ask_question` / `request_user_location` | "有个选择需要你确认。" |
| `save` / `finalize` / `full_plan` | "快好了，正在保存到你的行程里。" |
| `route` / `transport` / `transit` | "正在确认交通和每段时间。" |
| `weather` / `search` / `place` | "正在确认地点、天气和开放信息。" |
| `validate` / `check` | "有几处细节需要补齐，我来整理。" |
| 兜底 | "小路正在规划中..."（出自逆向分析文档） |

**给我们的启示**：trip-weaver 现在的 progress 是"正在读行程…"这类机械描述。可以在工具事件 → progress 翻译层（`TOOL_LABEL`）直接套这个分派模式，把"正在X"升级为带人格的分类话术。成本：纯前端/文案改动。

### 3.2 出行模式的授权话术（值得整段抄）

> "唯一要定的事：开不开定位。开了我能看到你在哪、主动帮你守时间和路线；不开我只能按计划时间猜。随时能在行程里改。"

一句话讲清 value / 代价 / 可逆性。trip-weaver 将来若做位置类功能（"查附近"），这段话术结构直接套用。

### 3.3 人格名的产品价值

"小路"出现在所有关键界面：约束管理（"小路排行程时会照着来"）、待办（"都会同步给小路"）、默认建议（"开启行程时小路会自动帮你生成建议"）。**人格名把"系统在处理"变成"小路在帮你办"**，是确定性感的核心来源。trip-weaver 的 agent 目前无名，可考虑起一个（配合产品调性，如"织程"本身可以拟人化为"阿织"？）。

---

## 四、行前体检（Preparing）：规则审计 → 决策卡 → 自动重排

出发鸭最强的差异化不是规划，是**行前**。四阶段流水线：

```
Pass 1 规则审计（10 条物理硬规则）→ 冲突决策卡（每个冲突三选一）→ Pass 2 消费决策自动重排 → 准备报告
```

10 条规则：`booking_window_passed`（放票截止）、`booking_required`（强预约）、`transport_mode_mismatch`（陡坡标步行）、`day_distance_overload`（特种兵超载）、`commute_too_long/short`（转场过久/换乘过紧）、`meal_too_early_or_late`、`restaurant_at_holiday_peak`、`hotel_far_from_evening_slot`、`hotel_missing_amenity`。

每个冲突的标准动作：**按建议改（accept）/ 我自己搞定（selfHandle）/ 不去了（skip）/ 自由留言（comment）**。

### 对 trip-weaver 的直接借鉴

我们已有这些规则的**代码基础但没做成产品交互**：
- `routeCoherence.ts`（345 行）— 动线连贯性检查
- `geoSanity.ts`（107 行）— 地理合理性
- `feasibility` hard/soft 违规 — 闭馆日、物理不可行
- `longHaulFixer` — 远郊混排修复

**建议**：把"可行性检查"从生成时的一次性内部逻辑提升为**行前体检的独立入口**（"完善细节"按钮），产出决策卡列表（复用现有 ask_user 的卡片 UI），用户逐项处置后触发一次 `repairChangedRoutes` 级别的重排。这就是出发鸭 Preparing 的翻版，而我们的规则引擎已经写完了 80%。

---

## 五、出行中伴游（Active）：对我们的中长期启示

- 客户端本地 Haversine 判距（1000m approaching / 80-200m arrived / 300m past），只上报脱敏语义（`arrived/left`），服务器不碰原始 GPS
- 焦点卡片 HUD：当前站/下一站距离 + ETA + 一键调起外部导航
- 乱序到达三级决策：advance / skipAhead / waitInPlace
- 伴游预警卡（companion_card）：末班车、闭馆前、雷阵雨、进度落后
- Web 场景下 trip-weaver 对应物：浏览器 Geolocation + 前端算距（同样可以只传语义），PWA 通知

这块 trip-weaver 短期不做，但架构上值得预留：`slot`/`companion_card` 的概念模型与我们的 day/activity 结构同构，将来可平滑生长。

---

## 六、事件协议对照（我们的 SSE vs 出发鸭 WS 双向）

出发鸭（服务端下发）：
```
agent:turn_start / thinking_delta / text_delta / progress_update
agent:tool_start / tool_end
agent:request_location
chat:transport_cards / place_cards
assignment:reordered / updated / deleted
trip:preparing_pass_done / preparing_complete
companion_card:new / slot:status_changed
```

trip-weaver 现有：`accepted / progress / answer_delta / recommendations / edit_result / done / error`。

**差距与建议**：
1. `thinking_delta`：我们 10 处 `onThought: () => {}` 全丢掉了思维链。模型 thinking 是现成事件，前端加个折叠区即可渲染——**零后端成本的确定性感提升**。
2. `tool_start/tool_end` 带结构化 args/结果预览：我们 progress 是纯文本。建议 progress 事件加 `tool` 与 `detail` 字段（服务端已有事件流，改翻译层即可）。
3. 卡片化结构输出（transport_cards/place_cards）：我们已有 candidates 卡片，方向一致。

---

## 七、优先级建议（面向 trip-weaver 的落地清单）

| # | 采纳项 | 成本 | 价值 | 说明 |
|---|---|---|---|---|
| 1 | 工具话术人格化（3.1 模式套 TOOL_LABEL） | S | 高 | 纯文案层改动，直接提升详情页体验 |
| 2 | 思维链渲染（thinking_delta → 前端折叠区） | S | 高 | 后端事件已存在，只差转发 |
| 3 | progress 事件带工具名/参数摘要 | S | 中 | 服务端翻译层加字段 |
| 4 | ask_user 卡片抄 QuestionSpec 形状（single_choice/multi_select/allowSkip） | M | 高 | P3 实现时的直接蓝图；askQueue(8) 防抖也抄 |
| 5 | 行前体检决策卡（复用 feasibility/routeCoherence） | M-L | 高 | 规则引擎已有，做交互入口 + 三选一卡片 |
| 6 | Agent 拟人名 | S | 中 | "小路"模式；配合行程主题（织程→织女？） |
| 7 | 子代理地图可视化（雷达点/分组候选/运镜） | L | 中 | 依赖 Leaflet 端改造，放最后 |
| 8 | 乱序到达/伴游卡 | XL | 中 | Web 端 Geolocation 方案预留，远期 |

**总评**：出发鸭最值得抄的不是它的地图动效（那是 iOS 原生的优势），而是它**把 agent 的内部状态完整翻译成用户可感知的确定性**——思维链、工具胶囊、子代理雷达、决策卡。我们已经有同样的内部状态（pi-durable 的 LiveDoc），差的只是"翻译层"。1-4 项加起来约 2-3 天工作量，能把详情页 agent 的体验拉到接近出发鸭规划阶段的水平。

---

## 附录 A：出发鸭 57 工具的交互分类（按 UI 展示需求分组）

| 类别 | 代表工具 | UI 呈现 |
|---|---|---|
| 检索 | amap_text_search / baidu_map_text_search / read_xhs_from_link / read_xhs_comments | 地图标记 / 笔记卡片 |
| 交通 | calc_route / search_flight / query_train | 大交通卡片（时刻表+经停+提前到站提醒） |
| 写入 | day_plan / update_day_plan / save / finalize / full_plan | 行程槽位即时更新 |
| 互动 | ask_question / request_user_location | 挂起 + 选择题卡片 |
| 校验 | validate_* / check_* | 体检决策卡 |
| 伴游 | check_user_arrived / add_user_reminder | HUD + 系统通知 |

## 附录 B：出发鸭记忆系统 vs trip-weaver 计划（PERSON_AGENT_PLAN.md §6）

| 出发鸭 | trip-weaver 计划 | 状态 |
|---|---|---|
| UserTraits（睡眠习惯/节奏/忌口/车辆） | L3 user_memory | 我们 P4 |
| TripWorkingContext（决策草稿/预算追踪/同行人） | L2 trip_notes | 我们 P4 |
| 12 题旅行画像 | 首页偏好表单 | 部分对齐 |
