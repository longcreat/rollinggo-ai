# PRD: 生成中页面改版 —— 步骤执行式 + 旅行手账氛围

## 背景

当前生成中视图（`GenerationRunPanel` + `GenerationTimeline`）是开发者视角：LLM 请求数、token 用量、system prompt 全文折叠等。普通用户不需要这些。
参考 Yuntu PlanningPage（左进度 + 右明信片动画），改为有旅行氛围的步骤执行式页面。

## 目标

1. 风格延续首页方案 A：背景沿用 `public/home-bg.png`，磨砂玻璃卡片，主色 #3B82F6，文字 #1A365D/#4A5568。
2. 布局：左 50% 旅程进度小径（虚线连接 3 个图钉里程碑），右 50% 拍立得候选卡片扇形散开。
3. 三阶段映射（SSE `phase_start/phase_end`，可多轮 round）：
   - research → 「搜罗全城 · 调研灵感」（调研候选 POI 池）
   - plan → 「串联路线 · 编排日程」（确定性排程）
   - review → 「雕琢题名 · 撰写文案」（语义=给行程与每天起标题）
4. 进行中里程碑：蓝色脉冲光环 + 小指南针旋转动画；下方一句友好状态文案（tool 事件 label 映射成人话，如 search → 「正在搜罗…」），缓慢淡入轮换。
5. 候选 POI 卡片（SSE `candidate`）：拍立得样式，随机 -8°~10° 倾斜扇形堆叠，新卡弹跳落入 + 闪光点缀。
6. 标题：「正在为你编织 {城市} 的 {N} 天旅程…」+ 呼吸光晕；背景漂浮纸飞机/云朵（CSS 动画）。
7. **移除开发者信息**：token 用量、LLM 请求详情、system prompt、思考过程折叠块、工具参数——均不展示。
8. 保留：取消生成按钮、超时/失败/已取消三终态文案、数据源降级 banner（简化措辞）、生成成功跳转。

## 非目标

- 不改后端 SSE 事件结构
- 不做 Yuntu 的 GSAP 明信片 3D 动画（纯 CSS transform/animation）
- 不动编辑器和其他页面

## 技术要点

- 改造 `GenerationTimeline.tsx`（或拆新组件），`GenerationRunPanel` 的终态卡片同步改玻璃风
- `buildTimeline`（lib/generationTimeline.ts）产出的模型继续复用；tool label → 友好文案的映射表放组件旁
- 减少动画偏好：`prefers-reduced-motion` 时停用漂浮/脉冲动画
- 耗时保留（用户向信息），token/调用次数移除

## 验收

- [ ] 三阶段步骤以旅程小径呈现，进行中/完成/等待状态正确
- [ ] 工具事件转为友好文案，无开发者信息
- [ ] 候选卡片拍立得扇形散开，新卡有落入动画
- [ ] 背景沿用 home-bg.png，玻璃风格与首页一致
- [ ] 取消/失败/超时/成功四态可用
- [ ] `npm run typecheck` + `npm run build -w apps/web` 通过

## 2026-10-02 归档核对

用户本轮授权提交当前任务，并检查归档其他已落地任务。生成中页面初版与后续视觉对齐均已提交，后续09-27-gen-page-visual-align已归档并记录真实生成验收；未提交的动画追加需求仍在09-29-generation-animation-copy。

工作提交：`9b46bd3`、`a74c157`、`f3d2cd4`、`f44d486`。本轮关闭脚本自动提交，手动以中文信息归档。
