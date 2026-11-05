# Server Frontend Directory Guidance

N/A: `apps/server` has no frontend source directory. Put browser modules and assets under
`apps/web`; the server only serves `apps/web/dist` in production.

See [server frontend scope](./index.md) and the
[web frontend directory guidance](../../web/frontend/directory-structure.md).

Representative path: `apps/server/src/index.ts`.
