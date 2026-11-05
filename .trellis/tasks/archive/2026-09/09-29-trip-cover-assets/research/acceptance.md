# 验证与设计记录

## 实现

- 对照旧任务 `research/ui-reference.png`：移除封面的 5px 白色左边框和偏移双竖条，将圆弧亮暗层、窄压痕和两处 15px 装订线收在 21px 书脊区域。
- 抽出 `TripCover`，其余列表行为与色系不变；原有无图城市继续居中。
- 本地城市 SVG 以 URL 形式由 Vite 收集，不解析/注入第三方 SVG 标记。成功加载后用 alpha mask 按封面文字色呈现；失败回退无图封面。
- 免费素材研究及官方链接见 `docs/CITY_LANDMARK_ASSETS.md`。未将第三方素材纳入产品。

## 检查结果

- `npm run typecheck`：通过。
- `npm run build -w apps/web`：通过，仍有既存大 chunk 提示。
- `node --test apps/web/tests/styles.test.mjs`：通过。
- `TRIP_COLLECTION_URL=http://127.0.0.1:5174` / `TRIP_COLLECTION_OUTPUT=<本任务>/research/verification` 下运行 `node apps/web/tests/trip-collection-browser.mjs`：通过。
- 桌面 1920×1080 六卡完整展示；1280×800、820×1100、375×812、812×375 无横向溢出。
- 搜索/筛选/排序、URL 返回恢复、键盘导航、请求失败重试、空数据、长标题通过。
- 临时本地 SVG 加载及染色、城市“市”后缀、损坏 SVG、多个城市不误配通过。测试素材已自动清除。
- 已查看 `verification/desktop.png` 与 `verification/local-svg-mobile.png`：书脊生效、装订线对齐、窄屏地标和文字不相互遮挡。

## 限制

- 免费图库风格不等于原图手绘插画。IconPark 最易统一，但较简洁；Iconfont 中的具体免费作者作品由用户手动挑选。
- 真实地标尚待用户选择下载，因此产品默认仍显示文字封面；测试房屋图形仅验证接入流程。
