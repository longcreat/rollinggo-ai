# 验收记录

- 根因：`TripCover` 只收集、查找 `.svg`，未包含用户放入的 `北京.png`。
- 北京素材为 1024×1024 RGBA，alpha 范围 0–255；四周及抽查的建筑内部空白透明，保留用户原始文件。
- 已支持小写 `.svg`、`.png`、`.webp`，同名优先 SVG → PNG → WebP；城市精确匹配、加载失败回退不变。
- 已核对 `verification/desktop.png` 与 `verification/mobile.png`：北京天坛显示为淡蓝图案，没有矩形白底；其他城市继续显示文字。
- `npm run typecheck`、`npm run build -w apps/web`、`node --test apps/web/tests/styles.test.mjs` 均通过。
- `TRIP_COLLECTION_URL=http://127.0.0.1:5174` 下运行 `node apps/web/tests/trip-collection-browser.mjs` 通过：五种视口、原有列表交互、三种格式加载与优先级、PNG alpha、城市后缀、多城市不误配、错误回退。
- 浏览器格式检查兼容 Vite 将小图片内联为 data URL 的行为；临时 fixture 自动清理后再次生产构建，避免测试图片进入最终包。
- 构建保留原有大 chunk 提示，不影响通过。
