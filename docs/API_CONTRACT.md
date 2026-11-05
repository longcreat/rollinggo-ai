# API 响应与前端请求约定

所有 `/api` 普通 JSON 响应使用 `{ code, message, data }`，包括健康检查、登录、业务路由、参数校验、权限失败、限流和未知接口。前后端需一起更新；直接调用接口的客户端应读取 `data`。

## 响应格式

成功使用 `code: 0`、`message: "成功"`，保留原本的 HTTP 200/201/202。`data` 是原业务对象、数组或 null，不额外改变分页、行程或会话结构。

```json
{ "code": 0, "message": "成功", "data": { "jobId": "generation-id" } }
```

失败保留 HTTP 4xx/5xx。已有业务字符串码优先（如 `no_llm`、`job_running`、`quota_exhausted`、`chat_quota_exhausted`）；无业务码时 `code` 使用 HTTP 状态码。前端本地传输错误使用 `network_error`、`timeout`、`invalid_response`，其中网络/超时的 `status` 为 0。

```json
{ "code": 401, "message": "未登录或会话已过期", "data": null }
```

```json
{ "code": "quota_exhausted", "message": "今日生成次数已用完", "data": { "resetAt": 1791043200000 } }
```

`message` 用于可读提示，业务分支使用 `code` 和 HTTP 状态；`jobId`、`resetAt`、`hasSiteKey` 等附加信息位于 `data`。不要把所有失败改成 HTTP 200，也不要从文案推断错误类别。内部异常只返回通用提示，不返回堆栈、SQL、密钥或参数校验内部细节。

## 服务端

`installApiResponses(app)` 在注册业务路由之前安装统一边界。现有路由继续返回业务对象或 `reply.code(status).send({ error, code?, ...extra })`，由 `onSend` 在原响应 schema 序列化后包装。这样既保留字段白名单过滤，也保留 Cookie、限流头和 HTTP 状态。新增独立 Fastify 测试实例也应安装这个边界。

以下响应遵守各自的 HTTP/流协议：

- SSE 保留 `text/event-stream` 和既有事件帧；建连前返回的 JSON 错误仍使用统一外层。流内的 `done/error` 事件按各自共享 schema 解析。
- OAuth 3xx 重定向保留 `Location` 和 Cookie。
- 204/304 无实体响应不增加 JSON body；客户端将 204 视为 null。
- HTML、图片、下载文件及 `/media` 静态资源不包装。

接口整体采用资源路径和 HTTP 方法；`cancel`、`restore` 等已有业务动作保持稳定。本次变更不重命名 URL，不改变请求体、数据库数据或导出 JSON 文件格式。

## 前端

普通请求用 `api.get/post/put/patch/del`，返回值直接是业务 `data`。使用共享 `ApiResponseSchema` 验证外层，拒绝旧格式和畸形响应；具体复杂数据继续由端点自己的 schema 校验。错误统一为 `ApiError`：`status`、`code`、`message`、`data`。

```ts
const trip = await api.get<Trip>(`/api/trips/${id}`, { signal });
// trip 是业务行程，不需要 trip.data。
```

- 请求固定携带同源 Cookie，合并自定义头，自动序列化 JSON；不引入 Axios 或本地 Token。
- 普通请求超时 30 秒，覆盖收到 body 的全过程；聊天 180 秒、数据源探测 90 秒、生图 240 秒。可通过 `timeoutMs` 与 `signal` 调整。主动取消保持 AbortError，不显示成网络故障。
- 普通请求与 POST SSE 建连共用 HTTP 错误与 401 处理。SSE 建连后关闭建连计时器，继续遵循流自己的超时与停止协议。
- 业务 401 只触发一次会话失效处理：清理 React Query 缓存和任务恢复标记，跳转登录并保留路径、查询串和 hash。登录/注册设置 `auth: 'public'`，错误留在表单；登录成功后重置失效去重，旧会话请求的迟到 401 不影响新会话。
- 原生 EventSource 无法读取 HTTP 错误 body；断线时通过任务快照确认状态，401/404 关闭连接，网络异常保留原生重连。
- 默认查询仅对网络、超时和 5xx 重试一次；4xx 不自动重试。写操作不自动重试。具体业务错误由原视图呈现，避免全局提示与局部提示重复。

## 回归

- `node --import tsx --test apps/server/src/__tests__/apiResponse.test.ts apps/web/tests/apiClient.test.ts apps/web/tests/detail-chat.test.ts`（设置测试 `MASTER_KEY`）。
- `npm run typecheck`、`npm run build`。
- `node --import tsx scripts/verify-api-contract-browser.mts`：生产前端 + 正式响应边界 + 内存会话夹具，不访问数据库或外部供应商。
- `node apps/web/tests/generation-recovery-browser.mjs`（Vite 18811）：真实 EventSource 重连、去重和会话失效。
- 浏览器模拟响应使用 `scripts/lib/api-contract.mjs` 中的 `apiSuccess/apiFailure`；Node API 脚本使用 `readApiResponse` 校验外层，成功解包、失败保留外层供断言。
