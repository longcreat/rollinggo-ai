# Server Frontend Quality Guidance

N/A for frontend source: none is owned by `apps/server`. For production static serving,
run `npm run build`, then use `node scripts/verify-c3.mjs` or
`node scripts/verify-d1.mjs` when the affected flow warrants it.

See [server frontend scope](./index.md), the
[web frontend quality guidance](../../web/frontend/quality-guidelines.md), and
[server backend verification](../backend/quality-guidelines.md).
