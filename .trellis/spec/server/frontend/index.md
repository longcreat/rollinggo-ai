# Server Frontend Guidance

## Scope

`apps/server` owns no frontend source, components, hooks, or client state. Browser code lives
in `apps/web`; shared request and event contracts live in `packages/shared`. In production,
the server only serves the already-built `apps/web/dist` directory and provides an SPA
fallback for non-API paths.

Representative paths: `apps/server/src/index.ts`, `apps/web/src`,
`packages/shared/src/schemas.ts`.

## Redirects

- [Directory structure](./directory-structure.md)
- [Component guidance](./component-guidelines.md)
- [Hook guidance](./hook-guidelines.md)
- [State management](./state-management.md)
- [Quality guidance](./quality-guidelines.md)
- [Type safety](./type-safety.md)
- Canonical browser guidance: [web frontend index](../../web/frontend/index.md)
- Cross-package frontend guidance: [shared frontend index](../../shared/frontend/index.md)

## Pre-Development Checklist

- If the change adds or edits browser source, work under `apps/web` and load the web frontend spec.
- If the change alters an API payload or SSE event, coordinate `packages/shared` contracts with server and web consumers.
- If the change affects production serving, verify the expected `apps/web/dist` build and SPA/API fallback behavior.

## Quality Check Checklist

- Confirm no frontend source was added under `apps/server`.
- Run `npm run typecheck` for shared, server, and web contract compatibility.
- Run `npm run build` when production static serving or browser assets are affected.
- Use `node scripts/verify-c3.mjs` for production static serving plus generation/SSE browser flow.
- Use `node scripts/verify-d1.mjs` for production export/import browser flow.
