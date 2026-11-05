# 实现与自测交付记录

状态：实现与自测就绪，等待用户验收。没有提交、归档或标记完成。

## 交付范围
- 共享 ApiResponseSchema 与客户端外层运行时校验。
- 服务端 onSend 在业务响应 schema 序列化之后包装；保留 HTTP 状态、Cookie、限流头；统一处理验证错误和服务异常。
- 前端自动解包、ApiError.status/code/message/data、30 秒默认超时及长请求独立时限、取消、有限查询重试、写入不重试。
- 任意受保护业务请求 401 统一清缓存并回到登录；保留原路径；并发去重、登录错误豁免、旧会话迟到 401 隔离。
- POST SSE 共用建连与 HTTP 错误；原生 SSE 经快照检测 401/404 后停止重连，忽略已清理订阅的迟到响应。
- 既有脚本与浏览器模拟接口迁移到新契约，原业务数据与导出文件不变。
- 文档入口：docs/API_CONTRACT.md；同步 README、架构文档及相关后端/前端规范。

## 通过的验证
- `npm run typecheck`：通过（包含 shared/server/web/eval）。
- `npm run build`：通过；仍有既有 bundle 大于 500 kB 的提示。
- `node --import tsx --test apps/server/src/__tests__/apiResponse.test.ts apps/web/tests/apiClient.test.ts apps/web/tests/detail-chat.test.ts`：14/14 通过（使用纯测试 MASTER_KEY）。
- `node --import tsx scripts/verify-api-contract-browser.mts`：生产构建 + 正式响应边界 + 内存会话夹具；初次鉴权、错误密码、路径恢复、业务 401、用户缓存隔离、503 不登出及再次会话失效通过。
- `node apps/web/tests/shared-ui-browser.mjs`：登录/注册/设置及公共界面回归通过。
- `node apps/web/tests/trip-share-image-browser.mjs`：显式开始、关闭后继续、失败重试、预览、下载、移动端布局通过。
- `node apps/web/tests/generation-recovery-browser.mjs`：真实 EventSource 的断线增量恢复、事件去重、任务切换、刷新恢复、401 停止重连通过。
- 18 个已有 JavaScript 验证脚本通过 `node --check`。
- `git diff --check`：通过。
- 运行中 8787 后端只读验证：health 返回 code=0/data；auth/me、trips、settings 返回 HTTP 401/code=401/data=null；未知接口返回 HTTP 404/code=404/data=null。

## 测试中处理的问题及边界
- 生图浏览器夹具缺少当前编辑器所需的版本列表，补齐后回归通过。
- 一次 SSE 夹具测试被 Vite 热更新打断页面执行；停止修改源码后重跑通过，包含新增 401 场景。
- 本次未运行完整 PostgreSQL 业务 E2E（专用 18797 实例未启动）；响应边界通过独立 Fastify 测试与生产前端浏览器回归验证，没有访问真实模型、生图或地图供应商。
- 内置 browser 控制工具在当前会话不可用；已先读取 browser skill，再使用项目现有 Playwright 工具验证。
- 仓库在任务开始前已有大量其他任务修改；本任务没有回滚、提交或归档它们。
