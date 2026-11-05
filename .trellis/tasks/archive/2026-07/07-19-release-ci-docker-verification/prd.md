# 发布前 CI 与 Docker Compose 验证

## Goal

完成开源发布前的自动化验证闭环：将现有 GitHub Actions 的类型检查和构建验证扩展到 Docker Compose 配置与应用镜像构建，并在推送后确认远端工作流结果。

## Requirements

- 将微信内置浏览器真机实测标记为“暂时搁置”，保留检查清单，不将其作为本任务阻塞项。
- 保留现有 `npm ci`、类型检查和生产构建步骤。
- 在 GitHub Actions 中验证 Docker Compose 配置可解析。
- 在 GitHub Actions 中构建 `app` 服务镜像，覆盖 Dockerfile 多阶段构建。
- 为 Compose 校验提供非敏感的示例环境配置，不读取或提交真实 `.env`。
- 推送工作提交后检查 GitHub Actions 运行结果。

## Acceptance Criteria

- [ ] `docs/DEVELOPMENT_PLAN.md` 明确记录微信真机实测暂时搁置。
- [ ] CI 保持 `npm ci`、`npm run typecheck`、`npm run build`。
- [ ] CI 成功执行 `docker compose config`。
- [ ] CI 成功执行 `docker compose build app`。
- [ ] 最新 `master` 推送对应的 GitHub Actions 工作流成功。
- [ ] 未提交真实密钥、`.env` 或本地 `.claude/settings.local.json`。

## Definition of Done

- 工作流 YAML 和 Compose 配置通过本地静态检查。
- 项目类型检查与构建通过。
- GitHub Actions 远端运行结果已记录。
- 相关开发计划状态同步更新。

## Technical Approach

在现有 `.github/workflows/ci.yml` 中复制 `.env.example` 为 runner 临时 `.env`，执行 `docker compose config` 和 `docker compose build app`。Docker 构建只验证镜像可构建，不启动服务、不申请域名证书，也不访问生产数据。

## Decision (ADR-lite)

**Context**: 本机未安装 Docker，无法直接完成 Compose 构建烟测；GitHub Actions runner 已提供受控的 Docker 环境。

**Decision**: 将 Docker Compose 烟测纳入现有 CI，以远端 runner 作为可复现的验证环境。

**Consequences**: 每次推送会增加镜像构建时间，但发布件持续受到验证；运行态 HTTPS、持久卷和真实密钥仍需部署环境验收。

## Out of Scope

- 微信内置浏览器真机实测及问题修复。
- 推送或发布容器镜像到 registry。
- 部署到生产服务器、配置域名或申请 HTTPS 证书。
- 使用真实 LLM、AMAP 或搜索服务密钥执行在线生成。

## Technical Notes

- CI: `.github/workflows/ci.yml`
- Compose: `docker-compose.yml`
- Image: `Dockerfile`
- Deferred checklist: `docs/WECHAT_CHECKLIST.md`
- Release plan: `docs/DEVELOPMENT_PLAN.md`
