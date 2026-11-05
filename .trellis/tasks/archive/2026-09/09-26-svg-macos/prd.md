# PRD: 首页改版 —— SVG 中国地图 + macOS 磨砂玻璃风格

## 背景

参考 D:\Project\study\Yuntu 的首页（CinematicHomepagePage）：全屏 SVG 中国地图渲染 + 城市打点选择 + 渐进式胶囊卡片。
当前首页是纯文字城市卡片网格，无视觉吸引力。

## 目标

1. 首页改为全屏布局：SVG 中国地图轮廓作为主体视觉，已覆盖城市在地图上打点。
2. 视觉风格：macOS 磨砂玻璃（backdrop-blur + 半透明 + 细边框 + 大圆角）简约风。
3. 交互：渐进式胶囊卡片 —— 用户在地图上点选城市后，浮出玻璃胶囊卡片，分步确认必要信息，最终跳转 `/trips/new?city=…`。
4. 保持产品边界：只有已覆盖城市可点选（`GET /api/destinations/covered`），未覆盖城市不出现。
5. 交付 GPT 生图提示词：首页氛围背景图（柔和渐变/云海质感，衬托磨砂玻璃）。

## 非目标

- 不做 Yuntu 的 GSAP 相机动画、沉浸模式
- 不在首页内嵌完整表单（日期/偏好等在 /trips/new 完成）
- 不引入 Tailwind（项目用原生 CSS，见 global.css）

## 技术要点

- 中国轮廓 path 复用 Yuntu 的 `CHINA_OUTLINE_PATH`（web/src/constants/chinaGeo.ts）
- 城市打点：需要每座已覆盖城市的经纬度 → SVG 坐标（Yuntu 用 900x700 viewBox 投影）
- 玻璃风格：`backdrop-filter: blur() saturate()`、`rgba(255,255,255,0.6~0.75)` 半透明、`border: 1px solid rgba(255,255,255,0.4)`、圆角 16~28px、柔和投影
- 拖拽平移/缩放：复用 Yuntu CinematicMap 的 pointer 手势逻辑（简化版）

## 验收

- [ ] 首页全屏 SVG 中国地图，已覆盖城市打点可点
- [ ] 点选城市后浮出磨砂玻璃胶囊卡片，渐进式引导，最终进入 /trips/new?city=…
- [ ] macOS 磨砂玻璃简约风格统一
- [ ] GPT 生图提示词文档交付
- [ ] `pnpm -r typecheck` 通过（或项目对应校验命令）
