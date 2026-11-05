# 顶部导航调整与验证

## 当前结果（待用户验收）
- 首页、行程列表与其他页面共用顶部胶囊导航，移除底部「首页 / 我的行程」及 72px 配套留白。
- 顶部保留两入口、当前页高亮、通知、账号和生成进度；访客的行程入口沿用原底部导航的登录弹窗行为，关闭后保留草稿及焦点。
- 手机保留顶端安全区；320px 下品牌、导航和账号操作不重叠。
- 本记录替代 10-05-home-mobile-layout 中关于底部导航的旧设计；规划卡片、日期、地图及精选保持原逻辑。

## 验证
- `npm run typecheck`：通过。
- `npm run build -w apps/web`：通过，仍有既有 chunk 大于 500kB 提示。
- `HOME_TEST_URL=http://127.0.0.1:5175 HOME_TEST_OUTPUT=.trellis/tasks/10-06-mobile-top-navigation/research/verification node apps/web/tests/home-mobile-browser.mjs`：8/8，通过 320×568、375×812、390×844、430×932、768×1024、844×390、1024×768、1440×900。
- 首页回归覆盖顶部导航可见且与账号区不重叠、零底部导航/占位、首页→行程列表→首页与高亮、访客弹窗和草稿保留，同时保留原表单及地图覆盖。
- `NAVIGATION_TEST_URL=http://127.0.0.1:5175 node --import tsx apps/web/tests/navigation-notifications-browser.mjs`：通过，含手机通知、离页保存、后台生成恢复与完成提示。
- `LOGIN_TEST_URL=http://127.0.0.1:5175 node apps/web/tests/login-dialog-browser.mjs`：通过，已同步访客顶部入口与会话过期断言，验证登录、退出、无访客私有请求、焦点返回和草稿延续。
- `git diff --check`：通过。
- 人工查看 320px / 390px 首页、375px 行程列表及 1440px 桌面截图，顶部排版完整，底部无重复导航。所有浏览器业务请求为隔离 fixture，不修改真实账号或行程。

## 验收入口
- 预览：http://127.0.0.1:5175/ （固定隔离数据，仅用于界面验收）
- 服务：`node .trellis/tasks/10-05-home-mobile-layout/research/preview.mjs`，读取最新 apps/web/dist。
- 首页截图：`verification/home-390.png`（访客）、`verification/home-320.png`（登录）。
- 行程列表：`verification/trips-375.png`。
- 通知与登录回归截图已复制到本任务 `regressions/`，恢复了本次脚本覆盖的其他任务旧截图。

## 状态
实现和自测已具备交付条件，任务保持 in_progress，等待用户明确验收；未提交、未归档、未运行自动收尾。
