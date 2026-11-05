# 发布候选环境端到端部署验收

## Goal

验证发布候选版本不仅能够构建，而且能在可复现的容器环境启动、经 Caddy 提供服务、在重启后恢复，并完成生成链路与已配置真实外部服务的冒烟检查。

## What I Already Know

- 本机未安装 Docker，不能在本地直接运行 Compose。
- GitHub Actions runner 已成功构建 Compose `app` 镜像，可作为容器运行态验收环境。
- `apps/server/.env` 已配置 `MASTER_KEY`、真实 LLM 三件套和 AMAP Key；搜索 Key 未配置。
- 仓库已有 `verify-c2.mjs`、`smoke-pi.mjs`、`smoke-sources.mjs`，应优先复用。
- 微信内置浏览器真机验收保持暂时搁置。

## Requirements

- CI 从干净 checkout 生成非敏感临时 `MASTER_KEY`，不读取开发者或生产 `.env`。
- CI 启动完整 Docker Compose，包括 `app` 与 Caddy。
- 通过 Caddy 的公开 HTTP 入口验证 `/api/health`。
- 重启 `app` 容器后再次验证健康，覆盖基础恢复路径。
- 执行现有 `verify-c2.mjs`，验证 mock LLM 下的生成、SSE、配额、取消与持久化链路。
- 使用本地 `apps/server/.env` 执行真实 LLM 和数据源冒烟；不得输出密钥值。
- 未配置的可选搜索源按降级处理并明确记录。

## Acceptance Criteria

- [ ] `npm run typecheck` 与 `npm run build` 通过。
- [ ] `node scripts/verify-c2.mjs` 全部通过。
- [ ] `docker compose up -d` 在 GitHub Actions runner 成功。
- [ ] 经 Caddy 请求 `/api/health` 返回成功。
- [ ] 重启 `app` 容器后 `/api/health` 再次成功。
- [ ] CI 无论成功或失败都执行 `docker compose down -v` 清理资源。
- [ ] `node scripts/smoke-pi.mjs` 对已配置真实 LLM 通过。
- [ ] `node scripts/smoke-sources.mjs` 对已配置来源通过；未配置来源报告跳过。
- [ ] 远端 GitHub Actions 对本任务提交运行成功。

## Definition of Done

- 所有可自动化的运行态、生成链路和真实外部源冒烟完成。
- 失败时保留 Compose 日志用于定位，成功时不泄露任何密钥。
- CI、部署文档或质量规范同步反映新的发布验收门槛。
- 工作提交、远端 CI、任务归档和会话记录完成。

## Technical Approach

在现有 CI 中增加离线 `verify-c2`，然后用 `.env.example` 生成 runner 临时 `.env`，写入随机 `MASTER_KEY`，启动完整 Compose。通过 `http://127.0.0.1/api/health` 验证 Caddy 反代，重启 `app` 后复验，最后无条件清理。真实供应商冒烟在本机执行，脚本只输出端点/模型与结果，不输出 Key。

## Decision (ADR-lite)

**Context**: 本机缺少 Docker，但发布验收需要真实容器运行环境；仓库同时已有离线生成 E2E 和真实供应商冒烟脚本。

**Decision**: 用 GitHub Actions 承担容器运行态验收，用本机受保护的环境配置承担真实供应商连通性验收。

**Consequences**: CI 可持续验证发布运行态；真实供应商检查仍依赖站长本地密钥和网络。搜索 Key 缺失时只能验证设计内降级，不能验证真实搜索响应。

## Out of Scope

- 微信内置浏览器真机测试。
- 生产域名、真实 TLS 证书和公网防火墙配置。
- 将镜像发布到 registry 或执行生产部署。
- 自动写入或上传任何真实密钥。
- 为缺失的搜索服务购买或申请凭据。

## Technical Notes

- Workflow: `.github/workflows/ci.yml`
- Compose: `docker-compose.yml`
- Container: `Dockerfile`, `Caddyfile`
- Offline E2E: `scripts/verify-c2.mjs`
- Live smoke: `scripts/smoke-pi.mjs`, `scripts/smoke-sources.mjs`
