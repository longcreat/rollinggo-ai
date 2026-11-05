# 旧标题缺字复发诊断（2026-09-30）

- 行程`32c3abae-eb1e-4587-8832-5531b2169385`第1天：中轴宫苑漫步。原始创建时间`2026-09-29T00:45:48.360Z`；照片更新前后快照均保留同一标题。
- `missingTitleCharacters(['中轴宫苑漫步'])`当前返回`['苑']`，前次写入检查有效。原实现只在`update_titles`拒绝不支持的字符，历史数据/默认骨架/导入/手改不受检查。前端`DaySection`直接渲染旧文本，`TripEditorPage`字体列表会对单个缺字回退，造成混排。
- 当前完整原始千图TTF本身缺苑/麓/雍/颐/榭，重新加载7个WOFF2分片或清理浏览器缓存无法补出不存在的字形。
- 官方替代字体来源与实测见`font-coverage-comparison.json`、`wenkai-source.md`、`mashanzheng-source.md`，预览脚本为`build-font-comparison.py`。字体许可证已保存，预览分片与许可证放在`data/photo-pilot/review/fonts/`。不安装系统字体。
- 浏览器`CSS.getPlatformFontsForNode`核验：原字体标题5字来自千图、1字来自SimSun；马善政/霞鹜各6字均来自所选字体。`font-comparison-result.json`和桌面/手机截图留证。不是仅凭`document.fonts.check()`判断覆盖。
- 建议优先B马善政以保留毛笔笔锋，若字库广度优先则C霞鹜文楷。当前等待用户审美选择，没有擅自替换全部手写字体或更改历史标题文字。
- 后续实现须让字体资源、cmap校验数据、前端显示兜底同步；仅阻止模型生成缺字标题不能保证历史/手改标题表现一致。
