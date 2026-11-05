# Tailwind 样式切换验收

验收日期：2026-09-29。

## 范围与结果

| 用户要求 | 当前实现与证据 |
| --- | --- |
| 去掉目的地手绘图 | TripListPage 保留纯文字书封、书脊与淡色背景；浏览器断言书封内没有 SVG。见 verification/desktop.png。 |
| 我的行程、行程详情、生成页面统一 Tailwind | 页面与关联组件直接使用静态 Tailwind 类、状态/响应式 variants；没有运行时旧类名转换层。 |
| 清除旧样式文件及其全站依赖 | 已删除 global.css、print.css、map-canvas.css、kinghwa-font.css、handwriting-font.css；登录、注册、导航、设置、日历、地图和打印视图也已迁移。styles.test.mjs 强制应用仅有 tailwind.css。 |
| 保留正常功能和布局 | 列表、编辑器、生成、公共界面的浏览器回归全部通过；截图人工检查无布局破坏。 |
| 规范约束统一 Tailwind | 更新 frontend/index.md、component-guidelines.md、directory-structure.md、quality-guidelines.md 和 docs/TECHNICAL_ARCHITECTURE.md，取消旧页面例外。 |

tailwind.css 仅集中 Tailwind 导入、语义颜色、低优先级浏览器默认值/打印可见性、字体定义和关键帧。Leaflet 及字体包自带的第三方样式仍按依赖导入。动态动画延时、卡片位姿和按天颜色继续由数据提供。

## 通过的检查

- `npm run typecheck`
- `npm run build -w apps/web`（保留已有的 chunk 大小提示；构建成功）
- `node --test apps/web/tests/styles.test.mjs`：1 项通过。
- `node --import tsx --test apps/web/tests/editorStore.test.ts apps/web/tests/generationCards.test.ts`：8 项通过。
- `node apps/web/tests/trip-collection-browser.mjs`：无手绘图、1920×1080 六卡完整显示、搜索/筛选/排序、返回恢复、键盘打开、异常重试、五种视口、长标题、无额外详情请求及数据写入。
- `node apps/web/tests/editor-browser.mjs`：PNG/JSON/打印导出、长行程不产生文档滚动、编辑/增删/移动、失败重试、移动端面板、缺图降级及地图控制。
- `node apps/web/tests/editor-browser.mjs --amap`：高德渲染器接口与控制契约。使用 SDK stub，不代表真实高德服务网络验收。
- `node apps/web/tests/generation-browser.mjs --motion`：逐张入场、打字、呼吸、减少动态效果、五种布局、卡片边界与底部按钮不重叠。
- `node apps/web/tests/shared-ui-browser.mjs`：登录样式与导航、注册校验、手机认证、设置弹窗及 Escape、首页日历区间选择、手机首页无横向溢出。
- `git diff --check`

## 可复查产物

- `verification/`：我的行程截图和 results.json。
- `editor-verification/`：编辑器截图和 results.json；amap-contract/ 为 SDK stub 检查。
- `generation-verification/after/`：桌面/手机截图、motion.json 和 measurements.json。
- `shared-verification/`：认证、设置、首页日历截图和 results.json。

所有交互检查使用测试数据或被拦截的 API；未修改真实用户行程，也未调用付费生成服务。

## 迁移中修正的问题

- 属性选择器使用单引号，避免源码中转义的双引号使 Tailwind 漏扫卡片色彩状态。
- 合并工具类时清除同属性冲突，避免把 className 顺序误当成 CSS 优先级。
- 生成动效测试在组件挂载前设置动态效果偏好，防止减少动态效果模式先填满卡片后再误测渐进呈现。
- 地图 SDK HTML 保留转义及 DOM 查询钩子，样式直接写为 Tailwind 类，名称避让仍有效。
