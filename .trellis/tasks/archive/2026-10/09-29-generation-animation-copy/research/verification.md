# 排查与验证记录

## 主要原因
用户确认目标是步骤呼吸光圈／页面动效。orchestrator.ts 在 review phase_end 后继续运行最终坐标解析、通勤复核、跨天优化和持久化。旧 milestoneState 仅依据阶段 done 标记，导致任务仍运行但所有光圈均被移除。

浏览器回归模拟该事件顺序，修复前失败：`final route checks must retain a live halo`，实际 0，预期 1。修复后保持最后一个步骤 active 到任务终态；首个阶段到达前显示准备状态。不会修改 SSE 原始数据或后端阶段协议。

## 附带修复
- 同文案的新 tool_start 不播放打字动画：以阶段与事件 key 驱动，普通 rerender 不重播。修复前回归失败，修复后通过。
- 同 POI 更新封面 URL 时 figure 重新入场。
- 拍立得仅显示 name，长名称换行；三阶段及工具标签改为用户向短文案。

## 验证结果
- `npm run typecheck` 通过。
- `npm run build -w apps/web` 通过，存在既有 bundle > 500kB 提示。
- `node --import tsx --test apps/web/tests/generationCards.test.ts`：6/6 通过。
- `node apps/web/tests/generation-browser.mjs --motion` 通过：逐张入场、同文案新事件、无关刷新、换图、收尾光圈实际跨帧变化、准备状态、减少动态效果、五种屏幕/空状态布局、名称溢出。
- `git diff --check` 通过。
- 视觉检查桌面和手机截图：长名称换行，照片不遮挡底部按钮。

## 范围与限制
使用本地 Vite 和确定性事件 fixture，未发起付费模型生成；内置浏览器不可用，采用项目现有 Playwright 回归脚本。测试图片为本地背景占位图，验收截图不代表实际景点照片。

当前处于待用户验收状态，未提交、未归档。
