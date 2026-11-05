# 安装 chrome-devtools MCP 服务器

## 背景

用户希望在本机 Codex 环境中安装官方 `chrome-devtools-mcp`（npm 包，Chrome 团队维护），以便后续会话可通过 MCP 工具调用 Chrome DevTools 能力（页面导航、DOM 操作、截图、性能分析等）。

当前用户级 Codex 配置（`C:\Users\Aimer\.codex\config.toml`）已注册 4 个 MCP 服务器：`context7`、`ace-tool`、`grok-search`、`stitch`。本次仅在 `[mcp_servers]` 下新增 `chrome-devtools` 条目，不动其他条目。

`smart-search` 能力经 `smart-search doctor --format json` 检查为 `ok: true`（openai-compatible 主搜索 + Tavily 网页搜索/抓取 + Context7 文档搜索），无需变更，不在本任务范围。

## 需求

1. 在 `C:\Users\Aimer\.codex\config.toml` 的 `[mcp_servers]` 下新增：

   ```toml
   [mcp_servers.chrome-devtools]
   type = "stdio"
   command = "npx"
   args = ["-y", "chrome-devtools-mcp@latest"]
   ```

2. 验证安装：
   - `npx -y chrome-devtools-mcp@latest` 可启动；
   - 通过 MCP `initialize` 握手成功，返回合法 serverInfo；
   - 配置语法不破坏现有 `[mcp_servers]` 其他条目。

## 验收标准

- [ ] 用户级 `config.toml` 中出现 `[mcp_servers.chrome-devtools]` 且参数正确。
- [ ] 独立启动 `chrome-devtools-mcp@latest` 握手成功。
- [ ] 重启 Codex 会话后 MCP 服务器自动挂载（可由会话内工具列表确认）。
- [ ] 现有 4 个 MCP 服务器配置保持不变。

## 范围

- 只改用户级 Codex 配置（`~/.codex/config.toml`）。
- 不改动本仓库代码、不修改其他 MCP 服务器、不调整 smart-search。

## 备注

- 修改目标在仓库外（用户主目录），写入需提权审批。
- 遵循 AGENTS.md 验收规则：用户明确验收前不提交、不归档。
