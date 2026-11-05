# 通知面板时间格式与点击交互调整

## 状态

2026-10-09 用户在「顶部导航与后台生成通知」验收阶段提出的三条 UI 反馈。需求已明确，范围已确认（面板与 Toast 一同处理）。

## 背景

上一轮实现（`.trellis/tasks/10-05-navigation-generation-notifications/`）交付了通知面板与完成提醒。用户验收后提出三点调整，涉及组件 `apps/web/src/components/NotificationCenter.tsx`。

## 用户已明确的需求

1. **时间加时分**：通知面板的时间在只有「月/日」时也要显示时分，例如 `10/6 20:09`。
2. **去掉箭头图标**：去掉操作按钮右侧的箭头图标。
3. **点击交互收窄**：整条通知不再可点击，只有右侧操作按钮点击才触发原有事件。

2026-10-09 确认：**通知面板与完成提醒 Toast 都改**（统一去掉箭头、统一只在操作按钮上触发）。

## 详细设计

### 1. 时间格式（`notificationTime`）

保持相对时间语义，只补上缺失的时分：

| 时间 | 现状 | 改后 |
| --- | --- | --- |
| 1 分钟内 | `刚刚` | `刚刚`（不变） |
| 今天 | `18:32` | `18:32`（不变） |
| 昨天 | `昨天 18:32` | `昨天 18:32`（不变） |
| 更早 | `10/6` | `10/6 20:09` |

- 复用已计算好的 `time`（`Intl.DateTimeFormat` `hour: '2-digit', minute: '2-digit'`），不新增格式化器。
- 未来时间（时区/时钟偏差导致的负数差）沿用现有分支，不特殊处理。

### 2. 去掉箭头图标

- 通知面板条目右侧操作文字后的 `<NavigationIcon name="arrow" />` 删除。
- 完成提醒 Toast 操作文字后的同名图标删除。
- 「查看行程」「下载图片」「返回重试」等文案本身不变。

### 3. 点击交互收窄

**通知面板条目**

- 整条由 `<Button>` 改为非交互容器（`div`），不再有点击与 `disabled` 语义。
- 右侧操作文字改为真正的 `<Button>`，只有它承载 `onClick={() => void open(item)}` 与 `disabled={opening !== null || navigation.pending}`。
- 未读圆点、标题、时间的视觉与布局不变。
- 可访问性：整条不再有 `aria-label`；操作按钮获得可辨识名称，包含行程标题与动作，例如 `查看行程：杭州 3 天行程已生成`、`下载图片：…`、`返回重试：…`。未读状态仍由文字字重与圆点表达，不依赖颜色。
- 按钮保持键盘可聚焦、可见焦点；点击热区不小于 44×44px（沿用现有 `min-h`/内边距或补足）。

**完成提醒 Toast**

- 整条不再可点击；只有操作按钮触发 `open`。
- 关闭按钮行为不变（只关闭提醒，不标记已读）。
- 悬停/聚焦暂停消失的 `onMouseEnter` / `onFocusCapture` 等事件保留在容器上。

### 边界

- 移动端底部抽屉复用同一份 `contents`，改动自动同步。
- 打开中（`opening === item.id`）沿用「正在打开…」文案并禁用按钮。
- 原有「全部已读」「查看更多」、空态、错误态、分页不改动。
- 浏览器验证脚本 `apps/web/tests/navigation-notifications-browser.mjs` 依赖旧的整条按钮可访问名称（`/杭州 3 天行程已生成，未读/`），需同步改为点击操作按钮。

## 验收标准

- [x] 更早的通知显示 `10/6 20:09` 形式；今天、昨天、`刚刚` 三种文案不变。
- [x] 通知面板与 Toast 中均不再出现箭头图标。
- [x] 点击面板条目的标题/时间区域不触发跳转；点击右侧操作按钮才打开行程/下载图片/重试。
- [x] Toast 同样只在操作按钮上触发，关闭按钮仍只关闭提醒且不标记已读。
- [x] 未读点、已读字重、加载态、错误态、全部已读、分页、手机抽屉行为不变。
- [x] `apps/web/tests/navigation-notifications-browser.mjs` 同步更新并跑通。
- [x] web type-check / build 与浏览器回归通过（项目未配置 lint 脚本）。

## 验证记录

2026-10-09：

- `npm run typecheck`（shared + server + web + eval）通过。
- `npm run build -w apps/web` 成功（944 kB 主包，仅体积提示）。
- `node --import tsx apps/web/tests/navigation-notifications-browser.mjs` 七项 PASS，新增三档时间文案断言与「面板内点击标题不跳页」断言。
- `node --import tsx apps/web/tests/trip-share-image-browser.mjs` 通过；同步把旧的可访问名匹配 `/图片已生成，未读，下载图片/` 改为 `/下载图片：/`。
- `node --import tsx --test apps/web/tests/styles.test.mjs` 失败，失败文件是 `apps/web/src/pages/LoginPage.tsx`（登录弹窗任务的未提交改动），与本次无关。

