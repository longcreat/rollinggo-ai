# PRD — Phase E1 开源工程化

> 指针 PRD：以 [docs/DEVELOPMENT_PLAN.md](../../../docs/DEVELOPMENT_PLAN.md) Phase E1 与 [docs/TECHNICAL_ARCHITECTURE.md](../../../docs/TECHNICAL_ARCHITECTURE.md) §10 为准。

## 范围

- Dockerfile / docker-compose.yml / Caddyfile / .env.example 与当前实现一致性核对与修正
- CI：分支覆盖修正（master/main）+ 补验收脚本可选跑法说明
- README：路线图勾选 M2/M3、截图（verify-shots 精选）、推荐模型量级（R2）、验收脚本说明、compose 内 MCP 地址提示
- 干净目录部署演练（Docker 可用则 compose build+run 冒烟；否则记录环境限制）

## 验收

- PRD §7 成功标准 2（站长 30 分钟可复现）+ 4（用量可查可估算）；CI 配置正确（推送后绿）
