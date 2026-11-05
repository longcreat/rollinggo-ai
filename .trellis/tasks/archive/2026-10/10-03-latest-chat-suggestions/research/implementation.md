# 实现与自查记录

- `ChatPanel.tsx` 只在消息末尾的助手回答显示后续建议；存在 pending 时隐藏历史建议。
- 欢迎区起始建议只在没有详情消息且没有 pending 时显示。
- 用户补充“该建议要和最新回答相关联”后，后端新增 `followUpSuggestions.ts`：正文完成后基于本轮问题、实际回答、日期和真实候选生成 0～3 条具体追问。
- 共享附件 suggestions 兼容旧枚举和 `{label,text,kind}`；旧固定建议不再作为后续建议显示。新建议和正文一起持久化，点击发送完整问题与原日期范围，`follow_up` 和其他建议类型均保持只读。
- 澄清问题不另生成建议；无有效建议/格式错误/上游失败/8 秒超时留空，原始取消仍然上抛；不影响成功正文。原有幂等结果不重新调用模型。
- 添加餐厅后的建议按实际餐厅、日期、餐次构造相关交通/节奏问题。
- 保留历史消息、餐厅卡片、澄清选项及数据库结构；已同步前端规范与后端详情对话协议。

## 验证

- `npm run typecheck`：通过。
- `npm run build -w apps/web`：通过；保留既有大分块提示。
- 设置占位测试 MASTER_KEY 后运行 `node --import tsx --test apps/server/src/__tests__/followUpSuggestions.test.ts apps/web/tests/detail-chat.test.ts`：6 项通过，覆盖兼容/校验/去重、真实 runner 的最新回答/日期上下文、单次提交、错误/超时/取消以及已有对话行为。
- `git diff --check -- apps/web/src/components/chat/ChatPanel.tsx`：通过。
- 人工代码检查：空对话、最新助手回答、多轮历史、最新用户消息、最新回答无建议、pending running/stopped/error，均由现有消息与 pending 的渲染条件处理。
- 内置浏览器连接此前不可用，本轮使用项目现有 `node --import tsx scripts/verify-detail-chat.mts` 完成隔离 PostgreSQL + 本地模拟模型 + 生产前端浏览器回归：全部通过。
- 浏览器验证新建议点击后的完整问题、多轮仅最新建议、pending 隐藏、刷新持久化、只读不新增行程版本，以及既有停止/添加/恢复/保存失败/并发草稿/窄屏行为。更新了测试中依赖旧固定菜单的断言。
- 预览：`data/detail-chat-verification/question-answers.png`，已目视检查最新答案下的建议与历史正文显示。该预览使用模拟回答，不代表真实模型的语义质量已通过用户验收。

## 交付状态

2026-10-03 用户在最新输入框修正交付后明确要求“归档当前任务”，当前结果验收通过并授权归档。
源代码依赖 `10-02-detail-chat-streaming-suggestions` 和 `10-03-detail-chat-qa-history` 尚未验收的未提交改动，直接提交完整源文件会混入前置任务。因此本次单独保存当前任务增量补丁及验收记录；实际源代码继续保留在工作区，待前置任务验收后一同整合提交。本次不归档其他任务、不推送。

`research/accepted-changes.patch` 覆盖本任务 11 个文件的增量，`accepted-changes.json` 记录基线/验收版 LF 标准化 SHA-256。已在独立目录执行 `git apply --check`、应用补丁并逐文件比对验收版内容；不能把它直接应用到尚无前置功能的 HEAD，也无需对当前已经包含这些修改的工作区再次应用。

持久化预览位于 `research/verification/`：对话建议、输入框修正前后及手机版。归档/日志脚本均使用 `--no-commit`，再手动创建中文提交。

## 输入框选中样式修正

- 用户反馈输入框选中样式异常；已在生产构建的本地预览复现内层蓝色直角框与外层圆角焦点环叠加。
- 原因：`TripEditorPage` 的后代 `:focus-visible` selector 包含 `textarea`，优先级高于内嵌 `Textarea` 的 `focus:outline-none`。
- 修改：从页面统一 outline/outline-offset 两处 selector 中移除 textarea，由共享 Field 和 ChatInput 自己管理其焦点。没有使用 important，也没有取消外层或发送按钮的可见焦点。
- 验证：`npm run typecheck`、`npm run build -w apps/web`、`node --test apps/web/tests/styles.test.mjs`、diff 格式检查通过。
- 浏览器局部核验涵盖失焦、鼠标聚焦、输入文字、Tab 到发送按钮、Shift+Tab 返回输入框、多行、375px 手机共 7 种状态，无页面错误。聚焦 textarea outline 从 solid 2px 变成 none；外层 2px 圆角环及按钮键盘 outline 保留。
- 预览：`data/chat-input-focus/before-focus.png`、`after-focus.png`、`after-mobile.png`；完整 computed styles 在 `before.json` / `after.json`。检查脚本位于本任务 research，仅使用本地样例与拦截 API，无实际聊天提交。
- 已记录规范，用户随后明确要求归档，按上述交付状态收尾。
