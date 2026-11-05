# UI 一致性检查与改动

## 原问题

- 23 个 TSX 文件存在约百处原生控件；常规按钮复制同一长串 Tailwind 样式，表单通过父级选择器重复覆盖 input/select。
- EditorMenu 与 ExportMenu 分别处理弹层和关闭行为；导出缺少统一的 Escape、外部点击与焦点离开关闭。
- Modal 缺少标题关联，长内容滚动限制不足；onClose 引用变化会重复安装 effect。
- 删除活动、删除当天、修改主题使用 window.confirm/prompt，脱离产品视觉体系。
- 活动菜单及两种地图均有编辑入口，活动菜单另有完整详情弹窗。

## 落地组件

- ui/Button：primary / secondary / ghost / danger / plain，IconButton、Spinner、链接可复用 buttonClassName；统一焦点与禁用、loading。
- ui/Field：Input / Select / Textarea，保留原生 ref、事件和校验语义；checkbox/radio/file/range 不套文本输入布局。
- ui/Dropdown：原生 details/summary，统一面板和关闭行为；路线菜单复用 useDismissibleDisclosure，保持其选中和异步状态。
- Modal：原生 dialog 的焦点陷阱、Escape、标题关联、焦点恢复及移动端滚动；只点击实际遮罩才关闭。
- ui/ActionDialog：确认删除与输入主题；长图保存预览也使用 Modal。

## 覆盖与边界

全站 JSX 的 button/input/select/textarea 均经共享组件，使用静态测试防回归。日历格、地图筛选、首页胶囊及路线选项保留领域布局（plain 变体），基础交互共用。原生 select 的系统选项面板遵循平台行为，不引入自绘键盘选择器。

## 验证

typecheck、web build、样式静态检查、路线交互回归、登录注册/设置/首页日历、行程列表筛选、详情导出与两种地图均执行。截图位于本目录各 verification 子目录；上游 API 使用测试夹具，高德 SDK 使用 stub。
