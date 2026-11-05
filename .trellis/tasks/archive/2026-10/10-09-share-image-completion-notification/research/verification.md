# 生图完成通知验收记录

状态：实现与 AI 自查完成，等待用户验收；未提交、未归档。

## 可验收行为

- 生图成功后即时提醒「图片已生成，已为你发起自动下载」，铃铛保留未读消息。
- 关闭海报弹窗或切换到首页仍收到提醒与单次下载，不强制跳页。
- 重新生成成功再次提醒并下载；打开已有海报与刷新回显不会重复。
- 通知内可下载对应风格当前有效的成品；成功后标记该条已读。关闭提醒、仅打开行程不将海报通知标为已读。
- 弹窗打开时提醒仍可见、可点击。下载失败提示出现在提醒中，可直接重试。
- 微信打开成品预览并引导长按保存；退出登录后迟到结果不下载、不弹提醒。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过（shared/server/web/eval） |
| `npm run build -w apps/web` | 通过；保留现有 >500 kB bundle 提醒，日志为 `build.log` |
| `MASTER_KEY=<fixture> node --import tsx --test apps/server/src/__tests__/tripShareImage.test.ts` | 17/17 通过 |
| `node research/verify-api.mjs`（从根目录传完整脚本路径） | 通过；真实临时 PostgreSQL + 模拟生图上游，无真实额度消耗 |
| `node apps/web/tests/trip-share-image-browser.mjs` | 通过；下载事件、通知、轮询去重、失败重试、微信、退出迟到与响应式布局 |
| `node --import tsx apps/web/tests/navigation-notifications-browser.mjs` | 通过；原行程通知和导航保存行为无回归 |
| 范围内 `git diff --check` | 通过 |

数据库验证覆盖旧表补列、重复迁移、通知持久化、账号 404 隔离、重新生成新增消息、缓存/GET 无新消息、全部已读游标边界、海报通知不能恢复行程生成任务，以及注入通知写入故障后图片仍可下载。隔离数据库在验证后已停止。

使用项目已有 Playwright 回归脚本执行浏览器验证（本会话未提供内置浏览器所需的 JS 工具）。截图已目视检查；海报使用上海样例作为模拟接口返回，用于验证交付交互，不代表真实杭州生图质量。

## 截图

- `verification/desktop-completion-toast.png`：海报弹窗打开时的完成提醒。
- `verification/mobile-background-completion-toast.png`：切到首页后手机底部提醒与未读点。
- `verification/mobile-wechat-save.png`：微信长按保存成品预览。

## 边界与恢复

浏览器能确认发起下载，不能确认操作系统最终保存完成。关闭整个网站后不承诺自动下载，已完成的图片可通过账号通知手动下载。通知数据库故障会写错误日志，图片与即时提醒仍可交付，但该次持久通知不能保证保存。

Trellis 的 brainstorm / before-dev / check / update-spec 流程已执行。遵照用户验收规则，任务保持 in_progress；没有运行 finish、archive、add_session、commit 或 push。
