## 提交信息

以 `.trellis/spec/guides/commit-convention.md` 为准，一次提交一件事：

- 格式 `<type>(<scope>): <中文简述>`：标题中文、动宾短语、≤20 字、无句号；scope 从该文档的词表取（`web` / `server` / `shared` / `scripts` / `spec` / `task` / `tasks` 等），不新造
- 正文一到两句中文：做了什么 + 验证结果
- 三段式节奏：工作提交 → `chore(task):` 归档 → `chore: 记录…` 日志，不交错；不 `--amend`、不 push

不要用 emoji 前缀（`✨` / `🐛`）加 `- ` 长列表的写法 —— 历史里这类提交是旧写法，不沿用；`gencom` skill 的 emoji 模板只适用于没有提交规范的项目。

<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->
