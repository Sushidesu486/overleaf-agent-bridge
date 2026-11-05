# Development conventions

- Work against the isolated Compose lab only. Production Overleaf and its databases are outside this repository's development scope.
- Keep credentials in ignored `.env` / `.local/` files with restricted permissions. Do not print passwords, sessions or activation links in logs or commits.
- Use Node.js >=20.19 and `npm ci`. Run `npm run typecheck`, targeted tests, then `npm test` and `npm run smoke` for affected behavior.
- HTTP routes are private upstream interfaces. Record the tested image digest and runtime revision; use the target container's source to resolve differences.
- The MCP process uses stdout exclusively for protocol messages. Diagnostics go to stderr.
- Read `docs/plan.md` and `docs/progress.md` before extending the adapter. Personal HTTP URLs and native realtime writes are implemented; online Agent presence remains pending.
- UI changes use the native Overleaf React layout, OL components and editor extension points. Keep presentation in `extensions/agent-access/frontend`; Docker builds the frontend with the pinned upstream source and cached dependencies.
- Use conventional commits with a model-name Co-authored-by trailer.
