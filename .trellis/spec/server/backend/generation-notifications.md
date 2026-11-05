# 导航、后台生成与站内通知

## 1. 适用范围

2026-10-05：登录后的全局导航、独立生成页、账号通知持久化。仅站内提醒；不调用 Notification API，不请求系统推送权限。现有生成仍为单实例内存任务，服务器重启不承诺继续计算。

## 2. 接口与存储

- `GET /api/generations/current` → 当前账号正在执行的 `GenerationJobView | null`。
- `GET /api/generations/:jobId` → 优先内存任务；过期后从账号通知恢复终态。
- `GET /api/notifications?before=<sequence>&limit=20` → `NotificationPage`。
- `POST /api/notifications/:id/read` → `{ok:true}`。
- `POST /api/notifications/read-all`，body `{through:number}` → `{ok:true}`。
- `generation_notifications`：bigserial sequence、id 主键、user_id、job_id、kind、trip_id、destination、days、title、message、job_created_at、created_at、read_at；唯一键 `(user_id,job_id)`，索引 `(user_id,sequence)`。schema 与启动 migration 同步。

## 3. 数据与状态契约

共享 `notifications.ts` 导出 TypeBox schemas 与派生类型。页面响应包含 `items,hasUnread,readThrough,nextCursor`；通知包含 `id,sequence,jobId,kind,tripId,title,message,createdAt,readAt`。时间为毫秒，未读为 `readAt:null`；sequence 仅用于游标，不显示计数。limit 为 1～50，before/through 为非负安全整数。

列表、全局未读和 readThrough 在同一个 repeatable-read 只读事务中查询。全部已读只更新当前账号且 `sequence <= through` 的行；晚到消息保持未读。分页按 sequence 降序，nextCursor 取本页末项。

成功通知必须与行程、成功审计在同一事务内写入，提交后才发布 job_done。同一账号/任务去重。失败与超时在释放运行锁后尽力写错误通知，失败日志不含敏感详情；主动取消不额外通知。通知故障不得让运行锁永久占用，成功事务失败不得扣成功配额。

`GenerationProvider` 挂在登录后的 AppLayout，切页不关闭任务生命周期；`/generations/:jobId` 只恢复已有任务，不重新 POST。sessionStorage 的 `tw.activeJobId` 仅为刷新线索，重新打开网站由 current 接口发现任务。SSE 负责实时阶段，通知和 current 以 15 秒可见页面轮询及焦点恢复补查。

完成时仅当前生成页在可见状态下自动进入详情；其他页面保留位置，聚焦标签弹最近一条提醒。首次读取只建立通知序列基线，不重放历史 Toast。通知保存于账号，关闭网站仍可写入。成功打开详情后才标记该消息已读，关闭 Toast 不标记已读。

纯 Logo、首页、我的行程、按需出现的生成入口；铃铛与退出仅图标，铃铛右上角仅未读红点。桌面 details 通知面板，手机原生 Modal sheet。通知查询与写入以 userId 隔离缓存；退出清理缓存、连接与 sessionStorage。

`NavigationProvider.perform(action)` 在 navbar、通知、退出前执行编辑器 guard：拒绝未完成行程操作和路线规划，等待 `save.flush()`，保存失败留在原页面与草稿。发起任务使用实际表单构造偏好快照；成功后只保存本任务快照，不覆盖新草稿。409 接管其他任务不保存当前表单偏好；退出后迟到的启动回调须校验 mounted 与账号。

## 4. 校验与错误矩阵

| 情况 | 行为 |
| --- | --- |
| 未登录 | 401，统一会话失效流程 |
| 非本账号通知或任务 | 404，不泄露归属 |
| 非法游标、limit 越界、缺少 through | 400 |
| 无通知 / 无进行中任务 | 空 items / null，不能把网络失败视为空 |
| 通知加载失败 / 已读保存失败 | 面板展示失败，可重试 |
| 成功通知指向已删除行程 | 保持当前位置，提示行程已不可用 |
| 暂时断网 | 保留恢复线索，由重连/快照补齐 |
| 内存终态过期 | 从通知恢复完成 tripId 或错误信息 |
| 服务器重启丢失运行任务，且没有持久结果 | 不假装仍运行，提示恢复失败和重试入口 |

## 5. 正常、基线与反例

- 正常：生成杭州行程 → 查看北京详情 → 杭州完成，仅弹提醒 → 保存北京草稿后打开杭州。
- 基线：关闭网站后任务完成，下次打开显示未读点与通知，不自动跳页。
- 反例：卸载生成页即取消；收到任意 job_done 全局跳转；全部已读更新无游标边界；success 通知先于行程事务提交。

## 6. 必要验证

- `node --import tsx scripts/verify-generation-flow.mts`：事务回滚、幂等、401/404、分页、已读边界、current 归属与持久结果恢复。
- `node --import tsx apps/web/tests/navigation-notifications-browser.mjs`：图标/红点、桌面与手机、Escape 焦点、返回同一任务、后台完成不导航、重开未读、编辑保存失败、空态/重试。
- `node scripts/verify-generation-browser.mjs`：生产包 + 隔离数据库/模型 fixture，首页到生成/详情、刷新、取消、后台通知与新偏好草稿保留。
- `node apps/web/tests/generation-recovery-browser.mjs`：原生 EventSource 增量恢复与游标重置（Vite 18811）。
- `node --import tsx apps/web/tests/travel-preferences-browser.mjs`：首页偏好成功保存、失败重试、账号隔离与图标退出。
- typecheck、web build、styles gate、trip-collection-browser 回归。模拟生成验证应用链路，不代表真实模型质量或速度。

## 7. 错误与正确示例

```ts
// 错误：无论用户在看哪个页面，完成就打断当前工作。
onDone: (tripId) => navigate(`/trips/${tripId}`);

// 正确：全局只更新结果和缓存，由对应生成页决定可见时跳转。
onDone: (_tripId, jobId) => {
  persistSubmittedPreferences(jobId);
  invalidateNotifications();
};
// 全部已读使用已返回给客户端的边界，保留后续消息。
where(and(eq(userIdColumn, userId), lte(sequenceColumn, through)));
```

## 8. 海报完成通知（2026-10-09）

### 适用范围

AI 旅行海报生成完成后的账号通知、即时提醒与浏览器下载。复用站内通知，不请求系统推送权限。

### 接口与存储

- `generation_notifications.share_image_style TEXT NULL`：空值为原行程通知；非空为共享 `TripShareImageStyle`，schema 与幂等迁移同步。
- `GenerationNotification.shareImageStyle?` 是可选判别字段，兼容旧通知。
- `POST /api/trips/:id/share-image` 返回 `TripShareImageGeneratedResponse`：原 `url,mimeType` 加可选 `notification`。GET 仍返回纯 `TripShareImageResponse`。
- `createTripShareImageService(store, generate?, notify?)` 在合并中的生成 promise 内，保存图片成功后调用一次 notify；缓存命中和 GET 不调用。

### 契约

每次真实生成（含 regenerate）新增通知；同行程同风格合并请求共享通知。通知不保存会被替换删除的旧图片 URL，点击「下载图片」通过鉴权 GET 获取对应风格当前有效成品。海报通知不能作为 `getGenerationResult` 的结果，也不能仅因打开行程详情而被标已读。手动下载发起成功或用户全部已读才更新已读。

前端模块级任务在 AppLayout 账号生命周期内共享，使用账号与当前任务对象拒绝退出/切换账号后迟到的响应。成功 POST 每次发起一次下载；GET 回显从不下载。下载异常独立于生成状态，保持成品与手动恢复入口。即时事件刷新通知缓存并按通知 ID 与轮询去重；刷新页面只建立基线，不重放旧提醒。

Toast 保留现有桌面右上角/手机底部样式。原生 dialog 打开时挂入当前弹窗，确保位于顶层且可交互；下载失败在 Toast 内显示。只在存在 Toast 时观察弹窗挂载，卸载清理 MutationObserver；隐藏/失焦窗口暂停自动消失计时。微信跳过自动下载，提醒提供成品预览及长按保存。文案只承诺「已发起自动下载」，不声称操作系统已保存文件。

### 校验与错误矩阵

| 场景 | 行为 |
| --- | --- |
| 图片生成或保存失败 | 不发布成功通知，不自动下载，保留上一成品 |
| 图片保存成功但通知数据库写入失败 | 记录非敏感错误；返回图片，前端临时提醒与下载仍可用 |
| 下载触发抛错 | 成品保持成功，清理临时链接，提示手动下载 |
| 通知指向已删除/已修改行程或丢失图片 | GET 404；原页面保留，提示打开行程重新生成 |
| 非法图片/通知响应 | TypeBox 校验失败，不发布成功或下载 |
| 浏览器关闭后服务端完成 | 持久通知保留；下次可手动下载，不承诺关闭网站时自动下载 |
| 微信 | 不声称自动保存，打开图片后长按保存 |

### 正常、基线与反例

- 正常：关闭弹窗或切到首页 → 图片生成 → Toast + 单次下载 + 铃铛未读点。
- 基线：刷新再打开已有海报 → GET 回显，零新通知、零自动下载。
- 反例：按行程与风格永久去重下载，导致重新生成的新图不交付；在组件卸载后丢掉完成提醒。

### 必要验证

- `tripShareImage.test.ts`：保存后通知、并发合并、缓存无通知、重新生成新通知、失败不通知。
- `scripts/verify-trip-share-image.mts`：真实隔离 PostgreSQL 的旧表补列与幂等迁移、持久记录、账号隔离、已读边界、GET 无通知、通知写入故障不丢图片。可用 `SHARE_IMAGE_TEST_DATABASE_URL` 指定本地测试实例。
- `trip-share-image-browser.mjs`：弹窗内提醒、轮询去重、每次重新生成下载、切页交付、刷新静默、通知手动下载、失败恢复、微信与退出后迟到响应。
- `navigation-notifications-browser.mjs`：原行程通知、导航保存 guard、桌面/手机回归。

### 错误与正确

```ts
// 错误：同风格首次后永久禁止下载，新成品也被跳过。
if (delivered.has(`${trip.id}:${style}`)) return;
// 正确：成功 POST 按本次任务交付，GET 回显不产生交付事件。
if (currentUserId !== userId || jobs.get(trip.id) !== running) return;
// 下载是异步取字节（可能是 CDN 地址）：等它返回再决定通知文案，别把没发起的下载写成已发起。
try { downloadStarted = await downloadShareImage(image, trip.title); } catch { /* 保留成功成品与手动入口 */ }
```
