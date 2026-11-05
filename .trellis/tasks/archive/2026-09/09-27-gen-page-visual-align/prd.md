# PRD：生成中页面视觉对齐（按设计稿）

## 背景

`09-27-planning-steps-glass` 已把生成中页面改成「旅程小径 + 拍立得」，但未与设计稿逐项校对。
本次用无头 Chrome 走真实流程取图（`verify-shots.mjs`，5 张实测图在本目录），逐条比对 `ui-ref.png`，
差异清单见 `research/visual-diff.md`。

用户确认的对齐范围：A1（天数 bug）+ D1（死 CSS）、A5+A6（里程碑与布局）、A2+A4（标题与背景装饰）。
顶栏（B1）**保持现状**，不按设计稿改成图标，也不另开任务。

## 目标

### 1. 标题天数取真实任务天数（A1）

现状：恢复/刷新链路打开的 URL 只有 `?city=北京`，`NewTripPage.parseDraft()` 用
`isoDateAfter(1)` / `isoDateAfter(3)` 兜底算出 3 天，于是 4 天的任务标题写「3 天旅程」。

做法：`job_start` 事件补 `days`（服务端 `orchestrator` 处有 `form.days`），前端经 `buildTimeline`
取出，面板标题优先用它，prop 里的 `days` 只作兜底。

- `packages/shared/src/types.ts`：`job_start` 加 `days?: number`（可选，兼容旧事件与重放）
- `apps/server/src/generation/orchestrator.ts`：`emit(job, { type: 'job_start', … , days: form.days })`
- `apps/web/src/lib/generationTimeline.ts`：模型加 job 级 `destination` / `days`
- `apps/web/src/components/GenerationRunPanel.tsx`：标题用 `model.days ?? days`

选它的理由：SSE 重放天然包含首个 `job_start`，无需改 `GenerationJobView` 与路由，也不用在前端另存草稿。

### 2. 清掉 GenerationTimeline 遗留死 CSS（D1）

`GenerationTimeline.tsx` 已删除，`global.css` 里它的类全站无使用者，约 `363-429` 行、25 个类：
`.gen-timeline` `.gen-phase*` `.gen-round` `.gen-note` `.gen-items` `.gen-tool*` `.gen-thought*` `.gen-llm*`
`.gen-foot` `.gen-metrics` `.gen-duration` `.gen-result*` `.gen-review-notes` `.gen-candidates`。

`.poi-card-compact` 需先确认真无使用者再决定（`.gen-candidates` 的兄弟规则）。

### 3. 里程碑与左列布局对齐设计稿（A5 + A6）

| 项 | 现在 | 目标 |
| --- | --- | --- |
| 图标 | emoji 🔍/🧭/📝 | 内联 SVG 线性图标（放大镜 / 指南针 / 文档），`currentColor` 描边 |
| 图标状态色 | 等待态 `grayscale(0.6)` 压暗 | 等待态浅灰线稿；进行中蓝；完成绿勾（勾可保留字符或换 SVG） |
| badge | 56px / 2px 边框 | 60~64px，1.5px 边框 + 轻微外发光 |
| 标题 | `1.05rem` 粗体 | `1.35rem`（约 21.6px） |
| 副文案 | `0.82rem` | `0.95rem` |
| 三点间距 | `padding: 22px 0` | `28~32px 0` |
| 关联线 | 只连相邻 badge，第 1→2 段几乎不可见 | 从当前 badge 中心连到下一个 badge 中心，贯穿小径 |
| 左列宽度 | `sm:w-[40%]`，容器 `max-w-6xl` | 内容区放宽（约 1400px），左列 42~45%，里程碑整体更靠左、更疏朗 |

注意：`h1` 字号规则写在 `global.css` 的 `.gen-page-root` 段（元素规则层级问题），改标题字号时别踩。

### 4. 标题与背景装饰（A2 + A4）

- 标题行内的 `✈️ / ✨` emoji 去掉，改为两侧 SVG 星形光点（小、低饱和）
- 保留并强化标题下的笔刷弧线 `gen-title-arc`（设计稿里更明显）
- 背景层新增三个装饰（纯装饰、`aria-hidden`、绝对定位、不参与布局）：
  - 云朵：2 处，柔化椭圆/ SVG 云，低透明度
  - 纸飞机：2 只（左上、右上），缓慢浮动
  - 右下角天坛剪影：SVG，低透明度，压在右下角
- `prefers-reduced-motion: reduce` 下这些浮动动画全部停用（沿用现有 reduce 段）

## 非目标

- 不改顶栏（`AppLayout`）与全站导航
- 不改 SSE 事件结构（只在 `job_start` 上加一个可选字段）
- 不引入图形库或新依赖，装饰用内联 SVG / CSS
- 不动编辑器、首页、行程列表

## 验收

- [ ] 恢复链路（`?city=…` 无日期）打开时，标题天数等于真实任务天数（4 天任务显示 4）
- [ ] `global.css` 中 `GenerationTimeline` 遗留类清零，`.poi-card-compact` 有结论
- [ ] 里程碑使用线性图标，字号/间距与设计稿量级一致，虚线贯穿三点
- [ ] 标题无 emoji，背景有云/纸飞机/天坛剪影，`prefers-reduced-motion` 下静止
- [ ] `npm run typecheck`、`npm run build -w apps/web` 通过，服务端既有测试不回归
- [ ] 重跑 `verify-shots.mjs` 出图，与 `ui-ref.png` 并排比对

## 未覆盖（本次不做，除非用户追加）

- 候选拍立得照片是否真能渲染（A3）：截图窗口 60/100s 只见空框，需拉到 180s 或 mock 数据验证
- 完成态 / plan / review 阶段推进 / 终态三卡片 / 移动端布局（visual-diff.md 的 C 节）

## 09-28 继续校对

用户要求继续校对生成中界面样式。本轮在既有实现上修正：

- [x] 进行中副文案复用千图笔锋手写体，等待阶段标题使用淡色。
- [x] 拍立得只展示最近五张，回到设计稿的五张位姿，避免第六张侵入底部区域。
- [x] 背景由 AppLayout 统一绘制，去除面板再次绘制同一背景产生的接缝。沿用上一轮移除背景装饰的状态，不重新加云/飞机/剪影（上方原始 A4 要求已被上一轮实施记录取代）。
- [x] 修复窄屏裁切和卡片覆盖取消按钮：900px 以下使用两列网格，重置标题水平偏移。
- [x] 固定示例数据截图覆盖 1672×941、1280×800、390×844，以及手机长地名、空候选；减少动态效果下无运行中的动画。
- [x] `npm run typecheck`、`npm run build -w apps/web`、`git diff --check` 通过。

证据与限制见 `research/09-28-review.md`。本轮只验证真实组件的固定输入布局，不重新验证后端生成、登录、路由恢复或终态操作；不将原始验收清单全部标成完成。

### 09-28 追加真实生成核对

用户再次指定 `行程生成2.png` 并要求跑真实生成。已执行北京 4 天任务，114 秒出现成功态，真实照片曾五张全部加载；后续候选替换后变成占位图。
以 `research/live-09-28/review.md` 为最新验收依据：仍有背景、标题层次、图钉/弯曲小径、Pexels 署名挤压卡片等差异，不能判定视觉对齐完成。

### 09-28 用户确认的最终修改范围（覆盖前文冲突项）

用户要求：云层、纸飞机等不需要；去掉署名；其余视觉差异全部修改。

- 不添加云层、纸飞机、建筑剪影，保留统一渐变背景。
- 生成页移除 Pexels 署名，卡片区不再受第三个 flex 子项挤压。
- 城市名放大；标题下方使用 SVG 笔刷曲线。
- 图钉增加白色内芯、渐变外圈、多层光晕和明显尖角；连线改为弯曲虚线，指南针指向东北。
- 拍立得使用白底锯齿 new 贴纸与黄色光点；说明从真实 POI 简介首句提取，缺失时仅用地点名。
- 优先保留最近五张有图候选；加载失败的 URL 排除并回退到其他候选，后续无图候选不把现有照片全部挤掉。
- 保留真实的阶段并发状态；顶栏仍按此前范围不改。
- 验证：桌面/窄屏截图、减少动态效果、候选筛选四项回归、typecheck、web build，以及真实生成复测。

最终范围已实现并通过上述验证，详情见 `research/final-verification.md`；真实复测 174 秒成功、175 秒自动进入编辑器。

### 09-28 动效与字体追加

- 当前阶段图钉使用 2.8 秒柔和呼吸光晕。
- SSE 最新正文/进度和工具 label 逐字淡入（约 45ms/字、最长约 2.4 秒），长正文只展示 90 字预览并限制两行；新文案重新播放，读屏一次读取完整预览。
- 候选按 1.2 秒节拍逐张加入/替换，入场持续 1.1 秒，不让 SSE 突发更新反复重置等待，不拖延取消、成功或跳转。
- 标题从京華老宋体改为更贴近 UI 稿规整字形的 SimSun，其他设备使用系统宋体/思源宋体兜底。截图无法唯一确认设计稿原始字体文件，不再把旧字体溯源推测当成已证实结论。
- 减少动态效果时立即展示目标卡片与完整文案，关闭呼吸和光标。
