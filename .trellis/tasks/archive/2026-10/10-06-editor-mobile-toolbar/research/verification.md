# 详情页移动端标题栏验证（待用户验收）

## 调整结果
- ≤600px 顶栏采用三列布局：返回、最多两行标题、历史/导出图标；日期、天数、人数在下一行排列。
- 两操作复用 22px EditorIcon，均为 44×44px 点击区域，保留可访问名称。桌面保留文字，导出增加现有 export 图标。
- 保留玻璃背景、菜单层级、历史版本与导出流程。长标题视觉上最多两行，完整文本保留在 DOM 及 title 中。
- 清理影响局部布局的旧祖先 display、手机元信息 block 和 16px 导出图标覆盖；统一为包含 600px 边界的 media query。

## 自测
- `npm run typecheck`：最终代码通过。
- `npm run build -w apps/web`：最终代码通过，保留既有 chunk 大于 500kB 提示。
- `SHARE_TEST_OUTPUT=.trellis/tasks/10-06-editor-mobile-toolbar/research/verification node apps/web/tests/trip-share-image-browser.mjs`：通过。
- 该回归覆盖 320、390、430、600、768、1280px，图标/文字切换、44px 触控区域、标题与按钮不重叠、菜单可点且位于视口内、编辑器页面不溢出、Escape 焦点返回、手机历史弹窗。
- 同时保留原分享图打开不生成、显式生成、等待/关闭/重开、失败重试、结果预览/下载、JSON 备份和打印回归。分享图使用 fixture，无真实模型调用。
- 长标题另测 320/390px，完整文本和 title 保留、视觉两行、元信息位于标题下方。
- 本轮新增历史弹窗检查需要有效版本 createdAt，已补全原 fixture，避免 Invalid time value。
- `git diff --check`：通过。
- 已人工查看 390px 常规、320px 长标题及 1280px 桌面截图；地图瓦片属于测试环境外部资源，未以此回归验证真实地图服务。

## 验收截图
- 常规手机：`verification/toolbar-390.png`
- 小屏长标题：`verification/toolbar-long-320.png`
- 桌面：`verification/toolbar-1280.png`
- 其他宽度及分享图状态见同目录。

## 状态
实现和自测达到交付条件，等待用户明确验收。任务保持 in_progress；未提交、未归档。上一导航任务仍待验收，未执行其收尾。
