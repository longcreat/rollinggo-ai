# GPT 生图提示词 —— 行程生成中页面（步骤执行式 · 旅行手账氛围版）

用途：/trips/new 提交后的生成中页面 UI 参考图。风格延续首页方案 A，**背景沿用首页同一张图（apps/web/public/home-bg.png）**，磨砂玻璃卡片。
画布：**1920×1080（16:9，标准 1080p）**，整页铺满、无浏览器边框、无留白边。前端按这个尺寸换算设计标尺（--ui），图不是这个尺寸会让全页比例偏移。
SSE 结构：三阶段步骤（调研灵感 → 编排行程 → 打磨标题，可多轮）+ 工具调用转友好文案 + POI 候选拍立得卡片扇形散开。
原则：不展示 token、LLM 请求、工具参数等开发者信息。

## 整页 UI 提示词（直接复制）

```
A high-fidelity UI design mockup of a dreamy travel itinerary AI-generation progress page, macOS frosted glass aesthetic meets playful travel-journal creativity, full-screen soft pastel gradient background of pale sky blue and misty lavender. At the top, a slim translucent frosted glass navigation bar with logo text "织程 TripWeaver". Center top headline in dark navy serif-ish font "正在为你编织 北京 的 4 天旅程…" with a gentle breathing glow. The main area is a two-column layout: left column (50%) shows a vertical journey-themed progress path — a thin dashed route line connecting three circular milestone badges like map pins on a trail: milestone 1 "搜罗全城 · 调研灵感" with a green check, milestone 2 "串联路线 · 编排日程" active with a soft blue pulsing halo and a tiny animated compass icon spinning, milestone 3 "雕琢题名 · 撰写文案" greyed pending; under the active milestone, one line of friendly handwritten-style status text in soft grey "正在搜罗胡同里的隐藏咖啡馆…" with a slow fade animation. Right column (50%) shows polaroid-style photo cards fanned out at playful angles like physical postcards scattered on a desk — five frosted polaroid cards with photo placeholders of Beijing scenes, tilted at -8° to +10°, each with handwritten-style caption like "故宫·角楼黄昏", the newest card dropping in with a soft bounce and a tiny "new" sparkle. At the bottom center, a single minimal ghost pill button "取消生成". No technical metrics, no token counts, no developer logs anywhere. Clean typography, generous whitespace, airy, high-key, soft shadows, rounded corners, whimsical yet minimal, Apple design language with travel-journal warmth, exact canvas 1920x1080 16:9 standard 1080p, full-bleed edge to edge with no browser chrome and no padding, dribbble shot quality
```

## 要素核对清单

| 元素 | 说明 |
|---|---|
| 左侧旅程小径 + 3 个图钉里程碑 | ✓完成(绿勾) / ●进行中(蓝色脉冲 + 旋转指南针) / ○等待(灰)，对应 phase_start/phase_end |
| 进行中里程碑下的一句友好文案 | tool 事件映射成人话，缓慢淡入轮换，不出现工具名 |
| 右侧拍立得候选卡片 | -8°~10° 倾斜扇形散开，新卡弹跳落入 + ✨，对应 candidate 事件 |
| 顶部标题 | 「正在为你编织 {城市} 的 {N} 天旅程…」+ 呼吸光晕 |
| 氛围 | 保持干净：不加纸飞机、云朵等漂浮装饰（09-27 决定） |
| 底部 | 仅一个「取消生成」幽灵按钮；无 token/用量/LLM 信息 |
| 背景/玻璃质感 | 沿用首页 home-bg.png 与方案 A 风格 |
| 画布尺寸 | **必须 1920×1080（16:9）**，不要 4:3 或自适应高宽——前端 --ui 标尺按它换算 |

## 可选追加

- 想强调流动感：`, subtle animated progress shimmer on the active step, a thin blue progress line connecting the three steps`
- 想要完成态版本（第二张图）：`, final state variant: all three steps checked green, a success banner "行程已生成" with a gradient blue button "立即打开行程"`
