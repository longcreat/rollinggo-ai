# 参考页面实现与验证记录

日期：2026-10-05。状态：已实现并自查，等待用户验收；未创建 Git 提交、未归档。

## 实现范围

- 参考图的磨砂胶囊导航：只显示现有 Logo、首页、我的行程、通知图标、退出图标；个人资料与设置入口移除。
- 我的行程保留现有搜索、目的地筛选、排序、书脊封面与操作；按参考图调整桌面卡片间距、高度和字号。
- 通知铃铛右上角仅未读小红点；桌面下拉面板、手机底部抽屉、全部已读、分页、加载/错误/空态。
- 生成任务由登录布局持有，切页不取消；导航返回同一任务，独立地址可刷新恢复；已有任务时首页入口改为查看生成。
- 成功通知与行程/审计同事务，按账号保存未读；浏览其他页时弹提示，不抢页面；点击正确进入详情。关闭提醒不标已读。
- 导航、通知和退出等待编辑器保存；保存失败保持当前详情与草稿，待更新路线/行程操作阻止离开。
- 生成成功保存实际提交偏好快照，保留首页新草稿；保存失败重试原快照，账号切换拒绝旧回调。

## 验证证据

| 验证 | 覆盖 |
| --- | --- |
| `npm run typecheck` | shared/server/web/eval 严格类型 |
| `npm run build` | 生产包可构建 |
| `node --test apps/web/tests/styles.test.mjs` | Tailwind 单入口约束 |
| `node --import tsx scripts/verify-generation-flow.mts` | 隔离 PG；通知与行程事务、回滚、幂等、401/404、分页、已读边界、终态恢复与既有生成回归 |
| `node --import tsx apps/web/tests/navigation-notifications-browser.mjs` | 桌面/手机、红点、Escape 焦点、生成离开/返回、重开未读、保存失败、空态/错误/重试 |
| `node apps/web/tests/trip-collection-browser.mjs` | 原有列表搜索、筛选、排序、卡片操作与布局 |
| `node apps/web/tests/generation-recovery-browser.mjs` | 原生 EventSource 重连、游标去重、刷新与 401 收尾 |
| `node scripts/verify-generation-browser.mjs` | 生产包 + 隔离 PG/模型；首页→生成→详情、刷新、取消重试、后台完成提醒、旧快照不覆盖新偏好草稿 |
| `node --import tsx apps/web/tests/travel-preferences-browser.mjs` | 首页成功后记忆、失败/刷新不保存、偏好保存重试、图标退出、账号隔离与手机边界 |

界面回归截图使用隔离 API/SSE 数据；生产链路使用隔离数据库和模型 fixture，未改用户行程或调用真实付费模型。用于验证应用行为，不代表真实模型质量/耗时。

## 截图与预览

- [桌面通知面板](verification/desktop-notifications.png)
- [手机通知抽屉](verification/mobile-notifications.png)
- [生成完成提醒](verification/completion-toast.png)
- [用户参考图](ui-reference.png)
- 本地开发预览：`http://localhost:5173/trips`，使用已有登录账号。无历史通知时显示正常空态；上线前旧行程不会批量补发完成通知。

## 约束与未扩展范围

- 仅站内通知；网页关闭期间无系统弹窗，下次打开可读账号未读。
- 生成仍依赖正在运行的服务进程；服务端重启不承诺恢复未完成计算。已落库结果与通知不受内存任务过期影响。
- 按参考图使用导航生成入口，未额外增加列表生成卡片。首页地图、规划胶囊、生成时间线、详情三栏沿用当前产品。
- 本次没有清理个人配置数据，也没有恢复设置入口。
- 保留工作区既有的 city-landmarks 用户图片和其他无关改动。
