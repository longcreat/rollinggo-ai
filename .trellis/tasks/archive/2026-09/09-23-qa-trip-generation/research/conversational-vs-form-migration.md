# 表单式 → 对话式迁移：行业实践与策略

调研方式：tavily 搜索 + 原文摘录。来源标注在每条结论后。
标注规则：**【有据】** = 有原文/研究支撑；**【推断】** = 我的判断，无直接来源。

---

## 零、先说风险：对话式不是免费的升级

**对话式 UI 的默认可用性低于表单。** NN/g 的经典结论：

> "Conversational UIs provide inferior usability to forms because of their inherent limitations, not because the designers of such interfaces didn't do a great job at designing them."
> — ["AI Chat or Not: If It's a Form, It Should Stay a Form"](https://uxplanet.org/ai-chat-or-not-if-its-a-form-it-should-stay-a-form-0294c59332d6)

五个具体缺陷（同一来源）：

| 缺陷 | 说明 |
|---|---|
| 交互成本更高 | 打字 > 点选 |
| 看不到工作量 | 表单一眼看到「还有 6 个空」，对话看不到 |
| 看不到进度 | 违反 Nielsen 启发式 #1「系统状态可见性」 |
| 过去的内容滚出视口 | 前几轮说了什么，用户记不住 |
| 难以复查 | 表单扫一眼就能检查，对话要往上翻 |

**【推断】对这个项目的意义**：不能做成「纯聊天框 + 等结果」。必须保留表单的「进度可见、可复查」优点，只把「逐个填字段」换成「说话 + AI 帮你填」。

NN/g 的另一条（[The User Experience of Chatbots](https://www.nngroup.com/articles/chatbots)）：

> "today's chatbots guide users through simple linear flows, and our user research shows that they have a hard time whenever users deviate from such flows."

即：**线性脚本 + 用户跑偏 = 崩溃**。设计必须显式处理「用户不按套路回答」。

---

## 一、四种收集模式与各自失败模式

| 模式 | 做法 | 代表 | 失败模式 |
|---|---|---|---|
| **A 自由聊天抽取** | 用户随便说，LLM 抽取参数 | ChatGPT | 用户不知道说什么；抽漏了也不会问；无法确认抽对了没 |
| **B 逐步提问 + 选项按钮** | 一问一答，每题给按钮 | Typeform 风、Simplified 类 | 变成必须走完的问卷；用户想跳步就卡住；问完才生成，等待焦虑 |
| **C 对话 + 可编辑摘要卡** | 边聊边填，随时弹确认卡；卡上可直接改 | FloatTrip、Layla | 卡片刷太频繁会烦；需要「什么时候算填够」的判定 |
| **D 混合（保留表单兜底）** | 默认对话，提供「直接填表」入口 | 【推断】少数产品 | 入口太多，用户选择困难 |

**【有据】** 空提示框导致的流失是实测量级问题：

> "people stare at the blank prompt for 15, 20, sometimes 30 seconds before typing something vague… A chat screen like that can hit a 40% drop-off rate. Replace it with a three-step form… and drop-off can fall to single digits."
> — [buildmvpfast](https://www.buildmvpfast.com/blog/ai-chat-interface-ux-dark-pattern-structured-ui-2026)

（该来源是厂商博客，数据无法独立验证，但方向与 NN/g 结论一致。）

**【推断】结论**：选 **C 对话 + 可编辑摘要卡**。理由是它同时吃到了两边的优点：
- 对话解决「不知道能填什么」（AI 主动问）
- 摘要卡解决「进度可见 / 可复查 / 可编辑」（表单的优点）

并且本项目的参照对象 FloatTrip 已验证这条路可行。

---

## 二、确认卡（summary card）的交互细节

**【有据】** FloatTrip 的实现给出了一份可抄的清单（见 `research/floattrip-conversational-flow.md`）：

1. **只在 `status === "ready"` 时渲染卡片**，`collecting` 阶段纯靠聊天。原文注释：
   > *"Collecting requirements are handled conversationally. Only a ready brief gets a compact, actionable confirmation surface in the feed."*
2. **必填字段只有 4 个**（目的地 / 开始日期 / 结束日期或天数 / 旅行侧重点），其余可后补。
3. **后端下发 `input_schema`**，前端据此选控件（`enum` → 单选按钮，无 `enum` → 文本框）。
4. **约束带 polarity**：偏好 / 避开 / 必须 / 仅背景，四种颜色，且每个都能**单条排除**（"本次不优先" / "本次允许安排"）。
5. **可追溯**：每条约束带 `evidence_sequences`，指向聊天消息。用户能问「你为什么这么认为」。
6. **缺字段时给确定性文案**：
   > "为了继续规划，还需要补充：目的地、开始日期。"

**【推断】补充设计建议**（FloatTrip 没有明确体现的）：
- 卡片应在**第一次「够生成」时**就出现，且常驻在消息流底部（sticky），而不是每次更新都插一条新卡 —— 否则刷屏。
- 卡片上每个字段都应可点击直接改，改完立刻回写到 Brief 并给一句 AI 确认。

---

## 三、字段该用对话问还是给控件

**【推断】**，但依据来自上面「交互成本」那条：

| 字段 | 形态 | 理由 |
|---|---|---|
| 目的地 | 对话（文本）+ 常见城市快捷按钮 | 自然语言是强项；但「东京、成都、大理」这种高频值给按钮 |
| 日期 | **控件**（日期选择器） | 对话解析日期错误率高、成本高。FloatTrip 也是给 `input_schema.format = "date-range"` |
| 天数 | 控件（数字 / 快捷 2/3/5 天） | 同上 |
| 人数 | 控件 | 同上 |
| 出行方式 | 按钮（三选一） | 枚举，现有 `TRANSPORT_MODES` 直接用 |
| 偏好 | 对话 + 按钮并存 | 自由文本是强项，但需给预设选项兜底 |
| 补充要求 | 对话（自由文本） | 唯一真正需要自然语言的字段 |

**关键规则（【推断】）**：**枚举和日期永远给控件，自由文本才用对话。** 对话的价值在于「降低用户想不起来的成本」，不在于「把点选变成打字」。

---

## 四、迁移策略：一次性 vs 渐进式

**【有据】** NN/g 的教训是「用户跑偏时系统要能恢复」：

> "Anticipate common detours and provide fallback responses that acknowledge confusion"
> — [parallelhq 引 NN/g](https://www.parallelhq.com/blog/chatbot-ux-design)

**【推断】推荐渐进式（三段）**：

1. **对话页与表单页并存**，路由 `/trips/new`（对话，默认）与 `/trips/new?mode=form`（表单，兜底）。
   - 成本极低：`PlannerPage.tsx` 原样保留。
   - 价值：对话页出问题时用户有退路；也方便 A/B 比较。
2. **同一套后端契约**：对话页最终产出的还是 `GenerateForm`，调的还是 `POST /api/generations`。
   - 这意味着**服务端几乎不用改**，只加一个「对话理解」接口产出 Brief。
3. 跑稳一个版本后再决定是否拆掉表单页。

**反例警示（【有据】）**：
> "The ones who default to chat almost always say the same thing: 'We'll add more structure later.' But later never comes because chat becomes the product's identity."
> — [buildmvpfast](https://www.buildmvpfast.com/blog/ai-chat-interface-ux-dark-pattern-structured-ui-2026)

即：**不要以「以后再加结构」为理由先上一个裸聊天框。** 第一版就必须带摘要卡 + 按钮 + 进度。

---

## 五、交互改造 与 视觉改版 的时序

**【推断】**，无直接行业来源。给出可执行的拆分依据：

同时做两件事的风险是**返工**。返工量取决于「哪部分会被重写」：

| 层 | 是否被对话式改造重写 | 何时做 |
|---|---|---|
| CSS 变量（色板/间距/圆角/字体） | ❌ 共用 | **立刻做**，收益即时且不回退 |
| 基础组件（按钮/卡片/输入框/空态） | ❌ 共用 | **立刻做** |
| `PlannerPage.tsx`（表单页） | ✅ 整个被替换 | 不做 |
| `LoginPage` / `TripListPage` / `TripEditorPage` | ❌ 不动 | **本任务结束后** |
| 新的对话页布局 | 全新 | 本任务内，直接按新变量写 |

**结论：先抽设计 token（1–2 小时），再开对话式改造，最后统一改其余页面。**

理由：
- 抽 token 不会白做 —— 对话页和现有页都用得上。
- 避免「对话页是新样式、老页面是旧样式」的割裂期过长（用户可见的不一致会显得产品没做完）。
- 避免为即将删除的 `PlannerPage` 做视觉工作。

---

## 六、可访问性与可用性风险清单

**【有据】**（NN/g + 上述来源）+
**【推断】**（具体缓解手段）：

| 风险 | 来源 | 缓解 |
|---|---|---|
| 用户不知道能说什么 | NN/g：「burden of discovering an app's capabilities is placed upon the user」 | 开场给 2–3 个示例 chip；输入框 placeholder 写具体例子 |
| 对话跑偏，AI 答非所问 | NN/g：chatbots 处理不了偏离脚本 | 每次回复都带「下一步」按钮；提供「重来」；`intent: unclear` 时明确说没听懂 |
| 无进度感 | NN/g #1 违反 | 4 段产品阶段条常驻；**不要**透出内部节点名 |
| 过去的内容滚出视口 | uxplanet | 摘要卡 sticky 常驻，随时可见当前已知信息 |
| 无法复查已答内容 | uxplanet「Hard to review」 | 摘要卡可展开看全部约束来源（`evidence_sequences`） |
| 中断后无法恢复 | 【推断】 | 沿用现有 `sessionStorage` jobId + 快照恢复；对话记录也要能恢复 |
| 纯键盘用户 | 【推断】 | 选项按钮可 Tab 聚焦 + Enter 触发；发送用 Ctrl/Cmd+Enter 或 Enter（需明确） |
| 成本焦虑 | 【推断】 | 明确「对话阶段不消耗生成次数，只有确认后才计入配额」（现有 `usage` 机制支持） |

---

## 七、一句话总结

**不要做聊天框，要做「会说话的确认卡」。**
对话负责问，卡负责确认，按钮负责选 —— 三者缺一，就会退化成 NN/g 批评的那个东西。
