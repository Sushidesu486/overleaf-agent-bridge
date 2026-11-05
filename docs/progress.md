# P0 progress

Checked 2026-11-05 (Asia/Shanghai), development host m701.

## Implemented

- Local Git repository and TypeScript project with locked dependencies.
- Isolated Docker Compose lab: CE 6.3.2, MongoDB 8.0 and Redis 7.4 selected and pinned to amd64 image digests. Overleaf binds only 127.0.0.1:18080; database ports are not published. Separate Docker volumes, CPU and memory limits.
- HTTP adapter: cookie jar, CSRF login, project allowlist, project listing, compile and artifact download; no automatic mutation retries or credential-carrying redirects.
- Three stdio MCP tools: service probe, project list, compile.
- Lab account/bootstrap and real MCP smoke scripts prepared. Passwords are generated into ignored files with restricted permissions.

## Validation

`npm run typecheck`, `npm run build`, `npm test` passed. Three tests exercise session/CSRF behavior, endpoint and project constraints, and an actual stdio MCP client/server conversation against a fixture HTTP server. These are not live Overleaf compatibility results.

Live bootstrap and smoke test have not run yet. Image downloads are still in progress: Harbor first returned a short-read error and then Docker Hub upstream rate limiting. The Overleaf image is being fetched directly from Docker Hub; MongoDB's Docker official ECR mirror has the same selected digest. Compose records those image sources for this host-only lab. Redis is cached through Harbor. Production K8s delivery will use the project's normal registry path.

## Next

1. Finish pulling images, start Compose and confirm the runtime revision.
2. Run lab bootstrap, diagnosis and live MCP compile/PDF smoke; resolve differences against actual container source.
3. P1: verify the lab Agent's displayed identity and human invitation, then probe realtime project/document protocols.

No production service, account, database or GitOps manifest was changed by this development task. The new repository has no Git remote configured yet.
