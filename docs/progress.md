# P0 progress

Verified 2026-11-05T17:24:53+08:00 on m701. Source: Compose health, container image metadata, runtime version commands and the real MCP smoke test.

## Running lab

- Repository: `/home/shouss/projects/overleaf-agent`, branch `main`; no Git remote configured.
- Overleaf CE 6.3.2 on `127.0.0.1:18080`; image digest pinned in `compose.yaml`.
- Actual image label `com.overleaf.ce.revision`: `370f4763da4bc910da8309c9a71c85ecbe39f6a7`. This differs from the earlier main-branch research revision; use the running image source for further protocol work.
- TeX Live 2026; MongoDB 8.0.34 (single-member replica set); Redis 7.4.12 with AOF enabled. All three services are healthy.
- Independent Docker network and volumes; database ports are not published; CPU and memory limits are configured. No GPU requested.
- Three ordinary lab accounts: human, Agent and unrelated outsider. Their randomly generated credentials are in `.local/lab-users.json`, mode 0600. One sample project is owned by the Agent. These accounts are unrelated to production identities.

## Implemented and verified

- TypeScript project with locked dependencies, HTTP cookie jar and CSRF login, explicit project allowlist, project listing, compile and artifact download.
- Three stdio MCP tools: `overleaf_status`, `overleaf_list_projects`, `overleaf_compile`.
- No credential-carrying redirects or automatic mutation retries. Stdout contains only protocol messages when the server is launched directly with Node.
- `npm run typecheck`, `npm run build`, `npm test`: passed (three tests covering session/CSRF, endpoint/project constraints and a real stdio MCP exchange against a fixture backend).
- `npm run lab:bootstrap`, `npm run diagnose`, `npm run smoke`: passed against the actual lab. MCP client handshake/listing succeeded; one project was visible; compile returned success; a 248,689-byte artifact started with `%PDF-`.
- A project outside the local allowlist was rejected. An unrelated Overleaf account with that project placed in its local allowlist still saw no project and was denied compilation by Overleaf itself.
- CE account creation requires `analyticsId`; the lab bootstrap now supplies a generated UUID. It reuses existing lab accounts and does not reset their passwords.

## Image transfer note

Harbor returned an incomplete large layer and then Docker Hub upstream rate limiting. Direct long-running Docker downloads also stalled. The official Docker Hub/ECR blobs were fetched in ranges, each manifest/config/layer SHA-256 was verified against the pinned manifest, then imported as OCI archives with the original digest references. Redis was pulled through Harbor. The helper and archives were temporary development artifacts; the normal Compose workflow remains unchanged. Production K8s delivery will use the normal project registry path.

## Next: P1 / remaining P0 protocol work

1. Probe the target image's Socket.IO project/document join, document versions and OT format.
2. Verify human invitation, Agent presence and display name in the web editor, and edit attribution.
3. Implement realtime reads, then local patches and concurrent-edit/reconnect tests.
4. Shared HTTP MCP, user binding, OAuth and revocation remain later milestones. Current configuration is a single local development identity, not a deployed multi-user service.

Old Overleaf, production accounts, databases and GitOps manifests were not changed. Lab data remains in its own volumes; use `docker compose stop` to stop without removing it.
