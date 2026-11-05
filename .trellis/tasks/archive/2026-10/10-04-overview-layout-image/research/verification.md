# 总览调整自查记录

## 本次改动

- TripOverview 删除「出行手册」「每日安排」可见标题，外层无障碍区域改名「行程总览」。
- 旅行建议、注意事项整体移至每日卡片上方，保留两栏自适应圆点列表；建议区后以细线分隔总站数提示和行程卡。
- 保留原有手写标题、日期、天气、路线、选日、添加一天和只读/忙碌状态。
- 更新 weather/editor/photo-layout 浏览器测试中的旧区域名称；天气测试增加建议区位于卡片之前的几何断言，并允许 OUT 指定输出目录。
- 同步前端组件与状态规范中的总览名称、布局顺序；未变更数据、API、地图、聊天或自动保存逻辑。

## 验证结果

- `npm run typecheck`：通过（shared / server / web / eval）。
- `npm run build -w apps/web`：通过；保留已有 >500KB bundle 提示。
- `node --test apps/web/tests/styles.test.mjs`：1 项通过。
- `OUT=.trellis/tasks/10-04-overview-layout-image/research node --import tsx apps/web/tests/trip-weather-browser.mjs`：通过。
- 浏览器验证覆盖默认总览、加载中、逐日天气、建议顺序、天气故障/未配置/预报范围外/日期未定、选日、0 行程写入，以及 390/768/1600px 无横向溢出；使用演示 API fixtures，不代表实时天气。
- 已人工检查完整总览与 390px 手机截图；内容未截断。完整总览截图临时加高视口以展开滚动区，普通截图仍保留实际测试视口。
- editor-browser / photo-layout-browser 本次仅同步区域名称，未额外运行两套全量回归。

## 交付文件

- `before-desktop.png`：保存前序任务的旧版截图，供对照；非本次重新截取。
- `overview-desktop.png`：1600×1000 页面截图。
- `overview-panel.png`：完整总览区域，供 GPT-image 参考。
- `overview-390.png`、`overview-768.png`：窄屏页面截图。
- `overview-panel-390.png`、`overview-panel-768.png`：窄屏完整总览。
- `gpt-image-prompt.txt`：图生图提示词，明确内容、顺序、保留项和禁止项。

## 尚待处理

本会话没有内置 image_gen 工具。按 imagegen 技能的明确要求，已向用户确认是否沿用项目现有脚本与 API 作为备用生图渠道；尚未调用付费生图接口，尚无 GPT-image 输出。页面截图不能作为模型生成结果宣称。

用户尚未验收；任务保持 in_progress，不提交、不归档、不标记完成。
