# 实现与验证记录

状态：待用户验收。任务保持 `in_progress`；未提交、未归档。

## 交付行为

- 首页“偏好与出行”提供最多 200 字的备注，偏好、交通方式和备注按账号自动保存。
- 面板内控件（偏好胶囊、备注输入框）按首页 `--ui` 缩放并使用同一套 token；个人资料弹窗以 1px 兜底保持基础尺寸。输入框只保留加载中、保存中、失败三种状态行。
- 右上角“个人资料”展示账号，共用首页草稿，支持修改及清空；清空恢复公共交通。
- 500ms 防抖、串行写入、旧回执保护及显式重试；页面内导航继续保存。
- 生成 Brief 和请求复用 `extraNotes`，个人资料后续修改不改写已提交快照。
- 使用独立 `user_travel_preferences` 表，迁移不影响原有凭据设置。

## 本次续作修正

1. 排队保存真正发送前、成功回执写入缓存前均校验当前身份，防止旧账号请求在会话切换后继续操作。
2. 新增非法输入测试发现 Fastify 的默认 AJV 会把 `null` 备注转成空字符串。PUT 使用共享 TypeBox schema 严格检查原值，拒绝 null、错误类型、缺失字段及未知字段，保护原记录。
3. 补充数据库损坏、存储不可用、无记录只读、SPA 退出/重新登录、会话失效队列及生成快照测试。

## 自测证据

- `npm run typecheck`：共享包、server、web、eval 类型检查。
- `npm run build -w apps/web`：生产构建；保留现有单包大于 500 kB 提示。
- `node --import tsx scripts/verify-travel-preferences.mts`：真实 PostgreSQL 随机临时数据库 + Fastify inject；幂等迁移、旧凭据设置保留、401、非法输入、账号隔离、独立新会话恢复、清空持久化、损坏数据与读写故障均通过，临时数据库在 finally 清理。
- `node apps/web/tests/travel-preferences-browser.mjs`：真实 Chromium + mock API；刷新、同页同步、串行保存、失败重试、Brief/生成请求、快照不变、退出/登录、旧会话队列隔离、375px 手机布局及 Escape/焦点恢复通过。保存同步点由“已记住”文案改为轮询 mock 服务端 +「正在保存…」消失。
- `node apps/web/tests/shared-ui-browser.mjs`：登录/注册、行程导航、设置弹窗、日期选择与首页布局通过。
- `git diff --check`：无空白错误。
- 已目视检查首页及个人资料的桌面和手机截图，无横向溢出或控件裁切。

浏览器验证使用现有 5173 Vite；数据库验证使用本机 18797 隔离测试实例。没有调用真实模型、地图供应商或写入真实用户偏好。未运行真实供应商行程生成；生成链路验证到 Brief 和请求载荷。

## 预览

- `data/travel-preferences-review/home-desktop.png`
- `data/travel-preferences-review/profile-desktop.png`
- `data/travel-preferences-review/home-mobile.png`
- `data/travel-preferences-review/profile-mobile.png`

## 已知边界

- 首页选择只存在本地草稿，生成成功后才写入账号；刷新、退出、生成失败都会丢弃草稿（个人资料弹窗仍 500ms 防抖即时保存）。
- 多标签页或多设备采用服务端最后一次成功写入值，不提供冲突合并或历史版本。
- 本地测试 PostgreSQL 缺少可选 pgvector；偏好功能与该扩展无关，故障注入与持久化测试正常完成。

## 2026-10-04 变更（改为生成后记忆）

- `node apps/web/tests/travel-preferences-browser.mjs` 通过：首页勾选/填写后 800ms 内无 PUT；刷新后草稿丢失；生成失败（400）不写账号；生成成功（SSE `job_done`）后一次性 PUT；个人资料即时保存、串行写入、失败重试、清空、账号隔离、会话切换旧队列隔离、移动端边界与 Escape 均保持通过。
- `node apps/web/tests/shared-ui-browser.mjs`、`npm run typecheck`、`npm run build -w apps/web` 均通过。
- `apps/web/tests/picker-browser.mjs` 仍失败：该脚本的 mock 未包含 `/api/settings/travel-preferences`，偏好面板拿不到值就渲染不出选项。它在本次改动前就是同样的失败原因（属于已归档的 09-29 任务），未纳入本任务修改。
