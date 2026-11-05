# 对话面板流式渲染性能优化

## Goal

长对话下流式回答不再拖慢整个面板：收到 answer_delta 时只有「正在写的那条」重渲染，历史消息零重渲染。

## 背景（实测代码位置）

- `ChatPanel.tsx:76` 每次 `answer_delta` 都 `setPending`，`pending` 是面板顶层 state → 整个组件函数重跑
- `ChatPanel.tsx` 的 `messages.map(...)` 对全部历史消息重新执行
- `MessageBubble.tsx:12` 未 `memo` → 每条历史消息每次都重新渲染
- 一次回答 ~2000 个 delta × 200 条历史 = 数十万次组件调用

## Scope（本任务只做第一步：纯前端、不改接口）

1. `MessageBubble` 加 `memo`
2. 把流式回答块（用户气泡 + `ChatProgress` + 正文 + 中断操作行）抽成独立组件 `PendingAnswer`
3. 保持现有行为完全不变：重试 / 恢复编辑 / 停止 / 已停止与中断文案 / `ChatProgress` 的 key 语义

**不做**：接口分页、虚拟滚动、展示层折叠、`useCallback` 兜底（`PendingAnswer` 不 memo，无需稳定回调引用）。

## 验收标准

- [x] `answer_delta` 触发时，历史 `MessageBubble` 不再重渲染（结构性验证：`MessageBubble.$$typeof === Symbol.for('react.memo')` 已实际断言；props 只有 `message`，其引用由 React Query 的 structural sharing 保持稳定）
- [x] 流式、停止、中断、重试、恢复编辑的行为与改动前一致
- [x] `npm run typecheck` 通过
- [x] `npm run build -w apps/web` 通过
- [x] `node apps/web/tests/editor-browser.mjs` 通过（对话面板在编辑器内，作为回归）
- [x] `node --import tsx --test apps/web/tests/detail-chat.test.ts` 通过（4/4）

## 验证记录（10-23）

| 验证 | 命令 | 结果 |
|---|---|---|
| 类型 | `npm run typecheck` | exit 0 |
| 构建 | `npm run build -w apps/web` | ✓ 2.70s |
| 对话单测 | `node --import tsx --test apps/web/tests/detail-chat.test.ts` | 4/4 |
| 编辑器回归 | `node apps/web/tests/editor-browser.mjs` | PASS |
| 登录弹窗回归 | `node apps/web/tests/login-dialog-browser.mjs` | PASS（EmailCodeField/RegisterPage 换控件后） |
| memo 实际断言 | 临时脚本 import 组件 | `MessageBubble.$$typeof === react.memo` 为 true，`PendingAnswer` 为普通组件 |

## 顺带修复（上轮回归）

`apps/web/tests/styles.test.mjs` 的「共享控件」规则禁止 `src` 下非 `ui/` 文件出现原生 `<button>`。上一轮 30258f9 在 `EmailCodeField.tsx` 与 `RegisterPage.tsx` 各新增了一处原生 `<button>`，已在本轮换成 `Button variant="plain"`。

## 遗留（非本任务范围）

`styles.test.mjs` 仍为红，剩下 4 处违规格全部由 6a8976b（2026-10-18，注册接入邮箱验证码）引入：`LoginPage.tsx:57`、`LoginPage.tsx:71`、`RegisterPage.tsx:120`、`ResetPasswordPage.tsx:85`。这意味着该测试自 10-18 起就是红的，与本轮改动无关。
