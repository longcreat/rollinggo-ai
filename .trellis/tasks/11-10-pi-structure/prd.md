# 拆包重构：对齐 pi 的 monorepo 结构

## 目标

把 `apps/server/src` 的平面目录拆成与 `work/harness/pi` 同构的领域工作区包，降低跨层耦合、方便扩展与管理。

## 目标结构

```
packages/
  shared/         # 纯领域 schema/类型/纯函数（已有）
  core/           # env、db、lib 基础工具、凭证/配额、provider 常量
  integrations/   # amap / qweather / websearch / embedding / image / resend + detailSources
  services/       # 业务服务（trip/conversation/health/place/share…）、brief/parse、itinerary
  agent/          # chat harness、generation、tasks、tools
  evals/          # 原根目录 eval/
apps/
  server/         # Fastify 入口、routes、http、auth、test
  web/
```

## 依赖方向（单向）

`shared ← core ← integrations ← services ← agent ← apps/server`

## 约束

- 不改变运行时行为、API、数据库结构。
- 每个包独立 `package.json` + `tsconfig.json`，导出 TS 源码（与现有 `@rollinggo-trip/shared` 一致）。
- 用 `git mv` 保留历史；跨包引用统一 `@rollinggo-trip/<pkg>/<path>`。
- 通过 `npm run typecheck` 与现有 `eval:test` 子集验证。
