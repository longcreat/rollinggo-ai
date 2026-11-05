# 飞鸟 Logo 替换验证

## 实现
- 全站 `AppLayout` 的旧波浪 SVG 替换为透明飞鸟 PNG，显示区域 36 × 36，保持 44 × 44 首页链接及原有导航事件。
- `public/brand/` 保存 256px 导航图案和 16px / 32px 透明 favicon；`index.html` 声明对应图标。
- 生产资源来自用户指定透明图的主体裁切、等比缩放和透明补边，保留原有形状与配色。
- 修改前 `AppLayout.tsx` 已包含其他任务的导航、通知及登录改动；本次只替换其中的图形节点。

## 验证结果
- `npm run typecheck`：通过。
- `npm run build -w apps/web`：通过；存在现有大包体积提示。
- `node .trellis/tasks/10-05-logo-transparent/verify_web_logo.mjs`：通过。
- 1440px、390px、320px：图片加载正常、无横向溢出、44px 点击区域和键盘聚焦正常。
- 首页与我的行程共用新图案，点击品牌链接可返回首页。
- 两种 favicon 返回 image/png，且与构建输出逐字节一致。
- 桌面、手机导航截图已目视确认，无白底、无拉伸。
- 内置浏览器工具本轮未提供可调用接口；已读取浏览器技能并使用本地无头 Chromium 配合隔离 API fixtures 核验，不操作真实账户。
- `git diff --check`：本次修改文件无空白错误。

## 规范与交付
已按 trellis-before-dev / trellis-check 读取前端组件及质量规范，完成 trellis-update-spec 判断：本次是一次性品牌资产替换，不增加接口、状态或可复用组件约定，因此无需改动全局规范。

实现及自测已完成，等待用户验收替换效果；未创建提交、未归档。
