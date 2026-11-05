# 未覆盖城市诚实降级

## Goal

知识库（canonical_places，小红书采集）只覆盖少数城市。用户询问未覆盖城市时生成质量差，需要诚实降级：检测覆盖 → 对话前置提示 → 放宽实时搜索配额。

## What I already know（代码核实，09-25）

- `canonical_places` 表有 `city` + `verified` 列与 `(city, verified)` 索引，按城市计数即可检测覆盖
- 调研 Agent prompt 目前写死：search_web「全阶段最多 2 次」，知识库连续两次无命中才可用（`generation/prompts.ts` L25/L32）
- 降级路径现状：知识库无命中 → search_web 兜底 → 都没有则「模型知识调研」（C3 有 `.gen-banner` 降级标注展示）
- 排程层对无知识库覆盖已有「空天占位」兜底（`schedule.ts` L84），不会编造地点

## Requirements（方向 1，用户已拍板 09-24）

- **R1 覆盖率检测**：按目的地城市查 canonical_places 计数，低于阈值判为「未充分覆盖」
- **R2 对话前置提示**：生成前告知用户「该城市攻略数据较少，更多参考实时搜索」，不编造覆盖能力
- **R3 放宽实时搜索**：未覆盖城市的生成任务放宽 search_web 调用上限（调研阶段）

## Open Questions

- 无（全部拍板）

## Decisions

- **提示时机（09-25 拍板）**：用户说出目的地那轮就在对话里提示，不等生成前一刻。服务端在对话理解后查一次城市覆盖，未覆盖时把提示拼进回复。
- **覆盖阈值（09-25 拍板）**：城市 verified 条数 ≥ 100 算覆盖（北京 1349 / 成都 411 vs 断层下 ≤21，一个数即可分开）；阈值做成常量可配置。
- **搜索放宽（09-25 拍板）**：未覆盖城市 search_web 上限 2 → 6 次；prompt 中的上限按覆盖率动态注入；`SEARCH_DAILY_BUDGET` 日预算照常生效。

## Out of Scope

- 运行时扩充采集 / 回写 canonical_places（方向 2，另开任务）
- 扩大离线采集（方向 3，数据运营）
- 目的地白名单限制（已否决）

## Acceptance Criteria

- [x] 未覆盖城市：用户说出目的地那轮回复中带降级提示（C2：「攻略数据我掌握得比较少」）；生成时 search_web 上限放宽到 6（C2：调研 prompt 注入「全阶段最多 6 次」）
- [x] 已覆盖城市（北京 100 条 seed）：不提示、上限保持 2，行为与现状一致（C2 对照断言）
- [x] 阈值常量可配置（`CITY_COVERAGE_THRESHOLD`）；覆盖结果进程内按城市缓存

**验证结果（09-25）**：typecheck 全绿；单测 265/265；verify-c2 全过；verify-c3 49/49。

## Technical Approach

- **检测**：`services/cityCoverageService.ts` — `SELECT count(*) FROM canonical_places WHERE city=$1 AND verified` ≥ 100（常量 `CITY_COVERAGE_THRESHOLD`）
- **提示**：`routes/conversations.ts` 发消息路径里，理解后若 Brief 目的地变化/新出现，查覆盖；未覆盖时在 assistant 回复尾部拼提示（不落库为独立消息，避免消息对计数错位）
- **放宽**：`generation/prompts.ts` 调研 prompt 的 search_web 上限由参数注入；`orchestrator.ts` 生成前查一次覆盖传入

## Implementation Plan

- PR1：`cityCoverageService` + 单测（阈值边界、缓存）
- PR2：对话提示接线（conversations 路由）+ C2 断言
- PR3：生成链路放宽（prompts/orchestrator 注入）+ C2 断言
- PR4：spec 同步 + 收尾
