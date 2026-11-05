# rikkahub 聊天 Agent 前端架构：可复用模式

调研对象：https://github.com/rikkahub/rikkahub @ `324b337`
调研方式：searchcode 读取 `web-ui/` 与 `ai/` 源码。
注意：主体是 Android Kotlin/Compose（700 个 .kt 文件）；`web-ui/` 是 React Router 7 + Tailwind + zustand + TanStack Query + i18next + shadcn/ui 的独立 Web 客户端。**只有 `web-ui/` 对本项目有直接参考价值。**

本项目栈对比：

| | rikkahub web-ui | TripWeaver web |
|---|---|---|
| 框架 | React + React Router 7 (framework mode) | React 19 + react-router-dom 7 |
| 样式 | Tailwind + shadcn/ui + `cn()` | 手写 `global.css`（380 行） |
| 状态 | zustand + TanStack Query | zustand + TanStack Query ✅ 一致 |
| i18n | i18next | 无（纯中文） |

---

## 一、消息数据模型：Message 是 part 数组

`ai/src/main/java/me/rerere/ai/ui/Message.kt`：

```kotlin
data class UIMessage(
    val id: Uuid,
    val role: MessageRole,
    val parts: List<UIMessagePart>,        // ← 核心：内容是数组不是字符串
    val annotations: List<UIMessageAnnotation> = emptyList(),
    val createdAt: LocalDateTime,
    val finishedAt: LocalDateTime? = null, // ← 用于算耗时
    val modelId: Uuid? = null,
    val usage: TokenUsage? = null,
    val translation: String? = null,
)
```

`UIMessagePart` 的类型（从 `chat-message.tsx` 的 switch 反推完整清单）：

| type | 字段 | 渲染 |
|---|---|---|
| `text` | `text` | Markdown |
| `reasoning` | `reasoning` | 链式思考折叠块 |
| `tool` | `toolName` / `input` / `output` / `state` | 工具卡片 |
| `image` | `url` | 图片 |
| `video` | `url` | 视频 |
| `audio` | `url` | 音频 |
| `document` | `url` / `fileName` | 文件卡片 |

### 两个可复用的判定函数

```ts
// 是否有任何"用户可输入"内容（用来禁用发送按钮）
isEmptyInputMessage(parts): boolean

// 是否有任何"UI 可见"内容（决定要不要渲染这条消息）
isEmptyUIMessage(parts): boolean
```

注意区别：`reasoning` 在 `isEmptyInputMessage` 里算空（用户不能只发思考），在 `isEmptyUIMessage` 里不算空（要显示）。**`tool` part 在两个函数里都强制非空** —— 工具卡片即使输入输出为空也要渲染。

```ts
function hasRenderablePart(part: UIMessagePart): boolean {
  switch (part.type) {
    case "text":      return part.text.trim().length > 0;
    case "reasoning": return part.reasoning.trim().length > 0;
    case "tool":      return true;          // 永远渲染
    ...
  }
}
```

> 对我们的价值：如果我们把「生成进度」做成消息流，`tool` part 这一层抽象就是落点。

### 消息耗时

```ts
function getDurationMs(createdAt: string, finishedAt?: string | null): number | null {
  // finishedAt 为空 → 用 Date.now()，即流式期间实时计时
}
```
配合 `usage.completionTokens` 算出 tokens/s。`ChatMessageActionsRow` 里展示成 "nerd stats" 一行小字。

---

## 二、工具调用可视化（`tool-part.tsx`，676 行）

这是本项目最值得看的一个组件。设计规律：

### 1. 工具名 → 图标 + 人话标题的映射表

```ts
const TOOL_NAMES = {
  MEMORY: "memory_tool", SEARCH_WEB: "search_web", SCRAPE_WEB: "scrape_web",
  GET_TIME_INFO: "get_time_info", CLIPBOARD: "clipboard_tool", ASK_USER: "ask_user",
} as const;

function getToolIcon(toolName, action?) {
  if (toolName === MEMORY) {
    if (action === "create" || action === "edit") return BookHeart;
    if (action === "delete") return BookX;
    return Wrench;
  }
  if (toolName === SEARCH_WEB) return Search;
  if (toolName === ASK_USER) return MessageCircleQuestion;
  return Wrench;   // 兜底
}

function getToolTitle(toolName, args, t): string {
  // search_web + query → "搜索网页：<query>"
  // memory_tool + create → "记住这条信息"
  // 兜底 → "调用工具：<toolName>"
}
```

三层降级：**具体动作 → 工具名 → 通用 Wrench 图标**。新增工具不会让 UI 崩。

### 2. 每种工具一个定制预览，兜底 JSON

```tsx
function SearchWebPreview({ args, content }) { ... }   // 搜索结果列表卡片
function ScrapeWebPreview({ content }) { ... }          // 网页正文摘录
function JsonBlock({ value }) {                          // <pre> 兜底
  return <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
    {toJsonString(value)}
  </pre>;
}
```

`SearchWebPreview` 里 `items.length > 0 ? 卡片列表 : <JsonBlock />` —— **有结构化数据就渲染卡片，没有就退化成 JSON**。这是渐进增强的正确写法。

### 3. `ask_user` 工具 = 内联问卷

```ts
interface AskUserQuestion {
  id: string;
  question: string;
  options: string[];
  selectionType: "text" | "single" | "multi";
}
function parseAskUserQuestions(args: unknown): AskUserQuestion[]
```

**工具调用可以变成交互控件**（单选 / 多选 / 文本输入），用户直接在消息流里回答，而不是回到输入框打字。

> 这和 FloatTrip 的 `input_schema` 是同一个思路的两种实现：FloatTrip 用后端 schema 驱动，rikkahub 用工具参数驱动。

### 4. 工具审批

```tsx
onToolApproval?: (toolCallId: string, approved: boolean, reason: string, answer?: string) => void
```
危险工具在执行前需要用户批准，批准结果作为工具参数回传。我们暂无此需求。

---

## 三、消息操作栏（`chat-message.tsx`）

每条 assistant 消息 hover 出现的操作：

```ts
interface ChatMessageProps {
  onEdit?, onRegenerate?, onSelectBranch?, onDelete?, onFork?, onToolApproval?
}
```

值得注意的两个：
- **`onSelectBranch(nodeId, selectIndex)`** —— 重生成不会覆盖旧回复，而是形成分支，`ChevronLeft / ChevronRight` 切换。`MessageNodeDto` 是树结构。
- **`onFork(messageId)`** —— 从某条消息分叉出新会话。

对我们：分支/分叉是重资产，**MVP 不做**。「重新生成行程」用现有 `/api/generations` 重跑即可。

### 复制文本时的 part 转换

```ts
function formatPartForCopy(part, t): string | null {
  case "text":      return part.text;
  case "image":     return `[图片] ${part.url}`;
  case "tool":      return `[工具] ${part.toolName}`;
  case "reasoning": return part.reasoning;
}
function buildCopyText(parts, t) { ... .join("\n\n").trim() }
```
复制时把非文本 part 降级成占位文案 —— 否则 `[object Object]`。

---

## 四、侧边栏信息架构（`conversation-sidebar.tsx`，1181 行）

未逐行读取，从 `conversations.tsx`（1090 行）与组件名推断的信息架构：

- 会话列表（按更新时间）
- 分支树（`MessageNodeDto` 的 parent/children）
- 搜索、重命名、删除、归档
- 模型 / 助手 profile 切换（`useSettingsStore`）

**对我们：不需要。** 我们没有多助手、多模型切换。我们只需要「行程列表」（已有 `TripListPage`）。

---

## 五、状态管理的边界

`useSettingsStore`（zustand）管的是：设置、当前助手、当前模型 —— **跨页面、非请求态的 UI 偏好**。

TanStack Query 管的是：会话列表、消息、provider 列表 —— **服务端数据**。

这条边界和 TripWeaver 现有做法一致（`editorStore` = zustand，`api/hooks.ts` = Query）。**不需要改变。**

---

## 六、视觉风格要点

- Tailwind 语义色：`bg-card` / `text-muted-foreground` / `border-muted` / `bg-primary/5` —— 靠 CSS 变量 + `dark:` 前缀做主题。
- 消息气泡：`alignRight` 布尔区分 user/assistant 对齐。
- 圆角统一 `rounded-lg`，卡片 `border + bg-card`，hover 用 `hover:bg-muted/40`。
- `cn()` = clsx + tailwind-merge，条件类名合并。
- 图标统一 `lucide-react`，尺寸用 `size-3` / `size-4`。

**对本项目的直接建议**：我们用手写 CSS，无法照搬 Tailwind 类名，但可以照搬**语义变量命名**。现在 `global.css` 是 380 行具体值堆叠，先抽一层 `--color-surface` / `--color-muted-fg` / `--radius-card`，后面所有页面改造都会受益。

---

## 七、可复用 vs 不可复用

### 可复用（MVP 候选）

1. **Message = parts[] 模型** —— 至少支持 `text` / `reasoning`（思考中）/ `tool`（进度）/ `error`。
2. **`hasRenderablePart` / `isEmptyInputMessage` 双判定**。
3. **工具名三层降级映射 + 定制预览 + JSON 兜底**。
4. **`ask_user` 内联控件**（单选/多选/文本）—— 对应我们的追问按钮。
5. **`formatPartForCopy` 复制降级**。
6. **语义色变量命名**（用于我们的 CSS 地基）。

### 不适用

- 消息分支 / fork（重资产）
- 多 provider / 多模型切换
- 会话树 / 侧边栏会话管理
- i18n（我们纯中文）
- 工具审批流
- Token 统计 / nerd stats（对旅行用户无意义）
- Kotlin / Compose / Room / Koin 相关的全部架构

## 八、关键文件索引

```
web-ui/app/components/message/chat-message.tsx          # 消息容器 + 操作栏
web-ui/app/components/message/parts/tool-part.tsx       # 工具卡片（676 行，重点）
web-ui/app/components/message/message-part.tsx          # part 分发渲染
web-ui/app/components/input/chat-input.tsx              # 输入区（746 行）
web-ui/app/components/input/extension-picker.tsx        # "/" 扩展选择器
web-ui/app/components/conversation-sidebar.tsx          # 侧边栏（1181 行）
web-ui/app/components/chain-of-thought.tsx              # 思考过程折叠
web-ui/app/routes/conversations.tsx                     # 会话页主逻辑（1090 行）
ai/src/main/java/me/rerere/ai/ui/Message.kt             # UIMessage 数据模型
```
