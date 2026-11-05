# PRD：首页改版收尾（删除新建页表单 + 遗留待办）

## 背景

09-26 首页已改为「SVG 中国地图 + 磨砂玻璃胶囊」，收集完目的地/日期/节奏/偏好后带 `autostart=1`
直达 `/trips/new` 自动发起生成。此时 `/trips/new` 的那套 4 段胶囊表单已经不会被任何入口用到
（行程列表的「＋ 新建行程」已经指向首页），它变成了必须维护的第二套收集 UI。

## 目标

1. **删除新建页的表单页**：`/trips/new` 只保留「启动生成 → 生成中/失败」流程，不再渲染表单。
   - 无 `autostart` 或参数不完整时重定向回首页（首页是唯一的收集入口）。
   - 连带清理仅服务于该表单的 CSS（`.capsule-*`、`.city-grid`、`.city-card*`、`.preset-row`）。
2. **处理三个遗留待办**：
   - a. 入场动画的 `prefers-reduced-motion` 降级：降级为「逐字淡入」（保留逐字节奏，去掉位移/模糊/旋转）。
   - b. 省界数据体积：**实测后不做**。紧凑编码只省 1.2KB gzip（总量 0.4%），却引入运行时解码层；
     真正的大头是写进 SVG `d` 的 88KB，编码方式改不掉。结论与实测数据见 `research/province-data-size.md`。
   - c. `RangeCalendar` 的双套字号体系：把尺寸收敛为组件级 CSS 变量，首页只覆写变量，不再逐条覆写选择器。

## 非目标

- 不改动生成后端的请求契约（`briefToGenerateForm` 保持不变）
- 不引入新的样式系统；首页仍是 Tailwind 原子类，存量页面继续用 `global.css`
- 不做 SSR / 路由懒加载改造

## 验收

- [x] `/trips/new` 无参数访问 → 跳回首页；带完整参数 + `autostart=1` → 直接进入生成中页面（代码路径就位，未做浏览器实测）
- [x] 生成发起失败的提示仍然可见：`failure = error ?? run.errorMessage ?? blocked`，配「回首页重新选择」按钮
- [x] 删掉表单后 `global.css` 无 `.capsule-*` / `.city-grid` / `.city-card*` 死规则
- [ ] ~~`.preset-row`~~ **保留**：它不是表单专属规则，`SettingsDialog.tsx:151` 与 `chat/IntakeControls.tsx:77` 仍在用（PRD 原文写错）
- [x] 开启系统「减少动态效果」时首页文案仍可读（`.home-hero-char` 降级为 `home-hero-char-fade`，`.home-hero-sub` 停动画）
- [x] `RangeCalendar` 首页双月与新建页单月的尺寸差异只通过 `--rc-*` CSS 变量表达
- [x] `npm run typecheck` 与 `npm run build -w apps/web` 通过（CSS 179.6 kB / gzip 63.9 kB）

## 未覆盖

- 浏览器实测：`/trips/new` 跳转与 `autostart` 直发、首页 reduced-motion 观感。代码侧已核对，未跑真机。
- 提交受生成中页面改版（09-27-planning-steps-glass）耦合：`NewTripPage` 新传的 `city`/`days` props
  只有新版 `GenerationRunPanel` 才接受，单独提交本任务会产生编译不过的中间态。
## 2026-10-02 归档核对

用户本轮授权提交当前任务，并检查归档其他已落地任务。首页唯一入口及旧表单清理已有提交；后续修复autostart跳转，生成主流程审查已有验收记录。省界压缩明确不做，preset-row因仍有消费者保留。

工作提交：`9b46bd3`、`fbae83e`、`c23d943`。本轮关闭脚本自动提交，手动以中文信息归档。
