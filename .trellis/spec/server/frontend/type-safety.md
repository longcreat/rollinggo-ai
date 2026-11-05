# Server Frontend Type Guidance

N/A for server-owned frontend code. Cross-package request, response, and SSE contracts are
defined in `packages/shared` with TypeBox schemas and derived TypeScript types; browser-only
types belong to `apps/web`.

See [server frontend scope](./index.md), the
[web type guidance](../../web/frontend/type-safety.md), and
[server backend structure](../backend/directory-structure.md).
