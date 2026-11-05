# 通知推送改为 SSE 通道

## Goal

通知中心现在是 15 秒轮询（`hooks.ts:useNotifications`），任务完成后最多要等 15 秒红点才出现。改成服务端 SSE 主动推送「有新通知」的提示，前端收到后回查列表，轮询降级为兜底。

## Requirements

* 新增 `apps/server/src/services/notificationStream.ts`：进程内 `userId → Set<listener>` 订阅表，`subscribeNotifications` / `publishNotification`
* 两个写点（`recordGenerationNotification`、`recordShareImageNotification`）在**写库成功之后**调用 publish
* 新增 `GET /api/notifications/stream`（`requireAuth`）：hijack + `text/event-stream`，15 秒 heartbeat，`close` 时退订
* 事件只带提示信息（`kind` / `title` / `tripId`），不带完整通知体 —— 前端收到后 invalidate `keys.notifications` 重新查询，DB 保持单一真相源
* 前端新增 `useNotificationStream(userId)`，在通知中心挂载时建立 EventSource，卸载时 close
* `useNotifications` 的 `refetchInterval` 从 15s 改为 60s（兜底），`refetchOnWindowFocus` 保留
* 多实例语义：进程内订阅表只在单实例有效，在文件头注明；多副本部署需换 `pg_notify`，本期不做

## Acceptance Criteria

* [x] `curl -N` 请求 `/api/notifications/stream` 能看到连接事件与 15 秒一次的 heartbeat
  - 2026-10-18 实测（节点 fetch 读流 + 库内造会话）：`200 text/event-stream`，`: connected` @1ms、`: heartbeat` @15.0s、@30.0s
* [x] 浏览器 A 打开通知中心，浏览器 B（同账号）触发一次海报或生成，A 在 2 秒内出现红点
  - 2026-10-18 实测（`b@test.dev` + 真实生成）：POST `/api/generations` → 202，43.4s 后生成完成，SSE 同一秒收到 `event: notification`；DB `generation_notifications.created_at = 11:09:11.735Z`，事件到达时刻与写库基本重合（<1s），前端剩一次 invalidate 重查
* [x] 关掉 A 再重新打开，通知仍然存在（首屏 `GET /api/notifications` 兜底）
  - 2026-10-18 实测：断开 SSE 后新建会话查列表 → 200，1 条（`sequence: 29` / `杭州 2 天行程已生成` / `readAt: null`）
* [x] 断开连接（关标签页）后服务端订阅表不残留（`unsubscribe` 被调用）
  - 以单测替代真机：`notificationStream.test.ts` 覆盖「退订后不再收到」「退订只摘掉自己」「最后一个退订后订阅表不残留」
  - 未验证的只剩 `routes/notifications.ts` 里 `res.on('close')` 这一行胶水；它只做 `clearInterval` + `unsubscribe()`，两道调用均有单测背背
* [x] `npm run typecheck` 通过；`node --import tsx scripts/verify-sql-first.mts` 通过
  - 2026-10-18：typecheck 四包零错误；verify-sql-first 90/90 pass（31.4s）

## Definition of Done

* SSE 通道可用，轮询降为 60 秒兜底
* 改动停在提交前等待验收

## Technical Approach

复用 `routes/detailChat.ts` 已验证的 SSE 写法（hijack、`X-Accel-Buffering: no`、heartbeat 定时器、`close` 清理）。事件发布放在 service 层而不是路由层，保证所有写入路径都覆盖。不引入队列、不做事件重放：事件丢了靠首屏查询补齐，这是刻意的设计取舍。
