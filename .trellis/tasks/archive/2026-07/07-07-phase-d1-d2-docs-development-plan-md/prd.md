# PRD — Phase D1+D2 导出三件套与响应式安全走查

> 指针 PRD：需求与验收以正式文档为准，不重复正文。
> - 需求：[docs/PRD.md](../../../docs/PRD.md)（F5 导出/导入、§7 成功标准 1/3/5）
> - 计划：[docs/DEVELOPMENT_PLAN.md](../../../docs/DEVELOPMENT_PLAN.md)（Phase D1 / D2 清单与验收）
> - 架构：[docs/TECHNICAL_ARCHITECTURE.md](../../../docs/TECHNICAL_ARCHITECTURE.md)（§8 前端要点、§9 安全设计、R12 微信怪癖）

## 范围

**D1 导出三件套**（apps/web）：
- PrintView + print.css（打印视图）
- export.ts（html-to-image toPng 2x 长图 / JSON `{version:2, trip}` / 打印）
- 导入 → POST /api/trips（TripExportSchema 校验）；ExportMenu 组件

**D2 响应式、微信真机与安全走查** —— 🏁 M3：
- ≤768px 三页签打磨（切地图 invalidateSize）；空态/长文本/无坐标标识
- 微信内置浏览器真机实测（**需要用户真机操作，本 session 只能准备核对清单**）；长图 download 失效 → 「长按保存」引导兜底
- 安全走查：横向越权/限流/Key 不见于响应与日志/Cookie 属性/ssrfGuard 双查/邀请码
- 全量回归：PRD 24 条 + 三包 tsc + build + 生产模式复验

## 验收

- D1：PRD F5 通过（跨账号导入还原）
- D2：PRD §7 成功标准 1、3、5 达成；微信真机项由用户执行（提供 checklist）

## 差异与决策记录

- 长图导出库：架构选型 html-to-image（待安装 apps/web）
- 微信真机测试无法自动化，交付 checklist 待用户回填；其余验收用 Playwright（含 390px 视口）覆盖
