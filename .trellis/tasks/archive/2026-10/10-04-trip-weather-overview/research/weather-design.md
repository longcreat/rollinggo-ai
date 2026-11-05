# 天气接口与总览设计

- 2026-10-04 使用 `smart-search fetch https://lbs.amap.com/api/webservice/guide/api-advanced/weatherinfo --format markdown` 阅读官方文档（页面更新 2026-02-02）。
- GET https://restapi.amap.com/v3/weather/weatherInfo；city=adcode、extensions=all、output=JSON、key=服务端 Web 服务密钥。
- 预报当天至第四天，每日约 8/11/18 点更新，以 reporttime 为准；casts.date 为精确匹配依据。旧基础文档仍写三天，采用最新高级 API 文档四天契约。
- 复用 amapRequest 和 amapQueue；新增 weather 额度与现有五项 LBS 配额隔离，保守默认 100 次/日，可配置，不能声称为官方配额。
- 设计：沿用项目现有浅蓝面板、品牌蓝和手写主题字体。每日路线用日期序号、主题、活动顺序及天气摘要形成层次；建议/注意事项作为独立列表，避免整块文字和过度重复标题。默认总览，点击某天深入。
- ui-ux-pro-max SKILL.md 已读；scripts 实为失效路径占位文件，搜索脚本不可用。依据规范中的信息层级、44px 触控、键盘焦点、响应式和可访问性要求实现。
- Browser 技能已读，但此会话工具未暴露 node_repl js，后续使用项目已有独立 Playwright 回归方式验证，不控制内嵌浏览器。
