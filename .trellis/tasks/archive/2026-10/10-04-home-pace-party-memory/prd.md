# 首页节奏与同行记为账号记忆

## 目标与已确认范围

2026-10-04 用户确认：首页「节奏与同行」里的**旅行节奏**与**同行人数**要跟「偏好与出行」一样按账号记住上一次选择，下次打开首页自动带入。

即把 `user_travel_preferences` 的契约从「偏好标签 + 出行方式 + 备注」扩展到「再加 节奏 + 同行人数」。目的地把保持现状（它由地图点击选择，不入库），出行日期同理。

已确认的两个问题：

1. 存储位置：**存账号**（扩展 `user_travel_preferences`），不是 localStorage。
2. 同行人数：**一起记**，不只记节奏。

## 需求

- `TravelPreferences` 增加两个字段：`pace`、`partySize`。
  - `pace` 允许为 `null`（新账号「还没选过节奏」），取值仍限于 `PACE_OPTIONS`。
  - `partySize` 取 1~20 的整数，账号默认 2。
- 首页「节奏与同行」面板的初值改为读账号记忆：已记住节奏时提交按钮不再等用户重选；人数同理。
- 首页选择**仍只改本地草稿**，生成行程成功后才由 `NewTripPage` 的 `onDone` 一起提交；失败、刷新、退出都丢弃。
- 个人资料弹窗不新增节奏/人数控件（不在本次范围），但它的「清空」必须把这两个字段一起复位，否则会留下无法清除的节奏。
- 数据库不可用时不伪装成默认值；读取旧行（缺新字段）必须按默认值兼容，不能报 500。

## 技术方案

- `packages/shared/src/schemas.ts`：`TravelPreferencesSchema` 加
  `pace: Type.Union([StringEnum(PACE_OPTIONS), Type.Null()], { default: null })`、
  `partySize: Type.Integer({ minimum: 1, maximum: 20, default: 2 })`。
- `travelPreferencesService.getTravelPreferences`：读库后先用 `Value.Default` 补缺省字段（旧的 3 字段行 → 自动补 `pace: null` / `partySize: 2`），再 `Value.Check` 严格校验。未知字段仍然报错，不因为「有缺省」就吞掉损坏数据。
- 路由 `GET/PUT /api/settings/travel-preferences` 的响应与请求 schema 不变（整包替换），PUT 仍走 `Value.Check` 严格校验。
- `HomeCapsule`：删掉本地 `pace` / `partySize` state，改从 `useTravelPreferencesDraft().value` 读；选择时用 `change({ ...value, pace })` / `change({ ...value, partySize })` 只写草稿。
- `TravelPreferencesFields` 的清空分支补 `pace: null, partySize: 2`，按钮文案同步说明会清节奏。
- `HomePage` 的 URL 参数链路不变（`pace` / `partySize` 仍按「非默认才带」的规则传给 `/trips/new`）。

## 验收标准

- [ ] 新账号首次打开首页：节奏仍未选（提交按钮禁用），人数 2。
- [ ] 选「轻松 / 4 人」→ 生成成功 → 刷新或重新登录，首页面板仍显示「4 人 · 轻松」，无需重选即可提交。
- [ ] 生成失败或中途刷新：账号里仍是上一次记住的值（本次改动被丢弃）。
- [ ] 个人资料弹窗清空后，节奏回到未选、人数回到 2，刷新后仍为空。
- [ ] 库里旧格式行（只有 preferences/transportMode/extraNotes）读取正常，返回 `pace: null, partySize: 2`。
- [ ] 非法 `pace`（如 `'fast'`）、`partySize` 越界或缺字段的 PUT 返回 400，原记录不变。
- [ ] 两个账号互不影响；未登录拒绝读写。
- [ ] typecheck、web build、`verify-travel-preferences.mts`、`travel-preferences-browser.mjs` 通过。

## 调研记录

- 现状：首页首页四段中，「偏好与出行」已按账号记忆（`6f1709b`，spec 见 `.trellis/spec/server/backend/travel-preferences.md`），节奏与同行人数是 `HomeCapsule` 组件内的 `useState`，离开页面即丢。
- spec 原文明确写了「目的地、日期、节奏、同行人数及多套历史不在此契约中」——本任务正好要修改这条边界，spec 需同步。
- `Value.Default` 可从 `@sinclair/typebox/value` 取，能把缺省字段补齐而不改未知字段，正好用于旧行兼容。
- 首页可选做 localStorage，但用户已确认走账号，与「偏好与出行」同一份记忆，避免两套机制。

## 交付状态

实现与自测后交付验收；验收前不提交、不归档。
