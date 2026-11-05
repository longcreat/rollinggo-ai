# Server Backend Guidelines

These guidelines describe the code that actually exists in `apps/server`. They are the
entry point for server work and override generic inherited placeholders where the server
has a more specific convention.

## Guides

- [Directory structure](./directory-structure.md): module roles, naming, route/service boundaries, and shared contracts.
- [Database guidelines](./database-guidelines.md): Drizzle/SQLite schema, startup migrations, ownership queries, and storage representations.
- [Error handling](./error-handling.md): global, route, service, and integration failure behavior.
- [Logging guidelines](./logging-guidelines.md): Fastify/Pino usage, levels, context, and secret redaction.
- [Security guidelines](./security-guidelines.md): authentication, sessions, OAuth, encryption, SSRF, and environment bootstrap.
- [Integration guidelines](./integration-guidelines.md): external source adapters, Null implementations, caches, queues, limits, and accounting.
- [行程天气](./trip-weather.md)：和风十五日预报、日期匹配、独立额度、生成快照与详情补查。
- [行程专属建议](./trip-advice.md)：第三阶段基于最终行程与知识库撰写、来源校验、快照持久化及编辑过期提示。
- [Generation guidelines](./generation-guidelines.md): background jobs, SSE, cancellation, persistence, task-local POI reuse, local revisions, and single-instance limitations.
- [导航与生成通知](./generation-notifications.md)：全局生成恢复、账号通知、已读游标、事务边界与离开保存。
- [RAG retrieval guidelines](./rag-guidelines.md): verified-place hybrid recall, prompt injection points, the embedding client, and offline knowledge ingestion scripts.
- [Chat and conversational intake guidelines](./chat-guidelines.md): dialogue intents, Brief readiness and intake controls, chat quota, revision and version chains, and the two-TypeBox-package trap.
- [账号旅行偏好](./travel-preferences.md)：首页备注、账号记忆、个人资料、保存顺序及生成快照。
- [详情对话流与版本恢复](./detail-chat-history.md)：POST SSE、真实候选、幂等添加、保存并发和历史恢复契约。
- [Quality guidelines](./quality-guidelines.md): validation rules and the real command matrix.
- [Evaluation execution](./evaluation.md): isolated live PostgreSQL, frozen knowledge export/import, immutable runs, comparison/baseline acceptance, offline CI and mock verification.
- [Research photo selection](./research-photo-selection.md): independent local comparison-site feedback, atomic persistence and preference-sample semantics; outside the production application.
- [Preference photo pipeline](./preference-photo-pipeline.md): authorized Beijing selections first, reviewed fallback, independent visual model, durable nonblocking backfill and versioned cross-source selection.

## Pre-Development Checklist

- 地点实体、别名、导入或去重变更先读 [地点稳定身份与治理](./place-identity.md)。

- Identify the owning module under `apps/server/src` and reuse its existing route, service, integration, or generation boundary.
- Read the relevant contracts in `packages/shared/src/schemas.ts` and `packages/shared/src/types.ts` before changing an API payload.
- For protected data, plan both `requireAuth` and a `userId` ownership predicate; authentication alone is not authorization.
- For every request input, plan a TypeBox schema for `body`, `params`, and/or `querystring` rather than relying on casts.
- For database shape changes, plan matching edits to both `apps/server/src/db/schema.ts` and `apps/server/src/db/migrate.ts`.
- For outbound calls, identify timeout, SSRF, Null fallback, cache, serialization, task limit, and quota/accounting behavior.
- For retrieval, prompt-injection, or knowledge-table work, read [RAG retrieval guidelines](./rag-guidelines.md); retrieval stays optional enrichment that degrades to an empty result.
- For community enrichment fields (`payload.openHours` / `payload.aliases` / `place_relation`) or the scheduling inputs that consume them, read [RAG retrieval guidelines](./rag-guidelines.md) — association pairs are UNDIRECTED and serve same-day clustering only, never ordering.
- For `/trips/new`, dialogue understanding, Planning Brief, chat quota, or revision/version-chain work, read [Chat and conversational intake guidelines](./chat-guidelines.md) — chat collects parameters and never generates itineraries.
- Check whether a verification script needs a built `apps/web/dist` or starts its own isolated server.

## Quality Check Checklist

- Run `npm run typecheck` from the repository root for shared, server, and web TypeScript checking.
- Run the smallest relevant verification script from [Quality guidelines](./quality-guidelines.md).
- Confirm protected reads and writes are filtered by the authenticated `userId` and return non-enumerating failures such as 404 where appropriate.
- Confirm request schemas cover every changed input surface and response bodies do not expose secrets.
- Confirm schema and migration definitions remain synchronized.
- Confirm expected integration failures degrade without aborting generation, while programming and persistence failures remain visible.
- Confirm retrieval changes still degrade to an empty result without failing generation, and that `source` ownership between the golden set and imported libraries is preserved.
- Run `git diff --check -- .trellis/spec/server/backend .trellis/spec/server/frontend` for documentation changes.
