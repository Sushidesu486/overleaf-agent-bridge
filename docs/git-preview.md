# Git preview: implementation and handoff

Status: experimental read-only implementation, 2026-11-14. Production Git access is not enabled. The complete feature scope remains in [the design](git-remote-design.md).

## Implemented

- Optional native `git-access` module and **Integrations → Git** dialog. The project owner enables access; members issue named, project-scoped human/Agent tokens, view usage/expiry and revoke them. Tokens expire after 90 days and only digests are stored. The prototype offers read-only tokens in the UI.
- A private API listener in the CE **API worker** on port 4001. CE runs a separate Web worker; starting the listener in both workers causes `EADDRINUSE`. The current source guards it with `Settings.enabledServices.includes('api')`.
- Official Java/JGit core pinned to `e039ad26c5bf5422eb57b89fc7e57c75055e631d`. The build verifies the source archive and the two patched files. Small CE patches add the internal service header and project/read-write context to token validation, and return a useful 403 for permission denial.
- Native history ZIP export with `X-History-Version`; all Git files are downloaded from one immutable on-disk snapshot. Downloads are signed for 15 minutes and recheck token revocation and project membership. Two-day export retention is separate from permanent bridge Git history. The prototype uses the bridge's service-author fallback; precise web-editor attribution remains pending.
- Per-file 50,000,000-byte and per-snapshot 500,000,000-byte transfer limits, with 2,000 entries. The text-write limit is not exercised until push is implemented. Repeated unchanged fetches retain their Git commit.
- Push is denied before receive-pack. The manifest apply callback, native write barrier, recovery and final Git ref reconciliation remain unimplemented.

## Validation completed

The actual patched Java/JGit process was built and run against the in-memory Snapshot API fixture on the development computer. `node scripts/smoke-git-bridge.mjs` passed clone, unchanged fetch, live snapshot change → pull, **50,000,000-byte binary SHA-256 round trip**, project scope denial, read-only push denial and revocation against an already-cloned repository. This verifies transport and our API contract; the fixture supplies snapshots in place of the native CE history service.

The access/API tests also verify that a member becoming read-only loses push permission, a token cannot access another project, signed download paths cannot be changed, and revocation invalidates an already-issued download URL. The native frontend webpack build succeeded on m701. Browser automation was unavailable in this session, so the dialog still needs visual acceptance.

Local `npm ci`, typecheck and TypeScript build completed; the full suite passed 72 cases, with seven optional Mongo-backed GitHub cases skipped. Those cases were not changed by this prototype. The real native smoke remains incomplete as described below.

## m701 runtime and current blocker

The isolated environment is `/home/shouss/projects/overleaf-git-check`, Compose project `overleaf-git-check`, host loopback port **18084**. Its MongoDB, Redis, application data and Git volume are independent of production and the earlier previews. A synthetic account is stored privately in this directory; credentials are not in the repository.

Initial images `overleaf-git-check:20261114-ui` and `overleaf-git-bridge:20261114` built and started. The API-worker listener fix was applied to that lab for diagnosis and restored HTTP 200 at `/login`; it still needs a final image rebuild. The real `scripts/smoke-git.ts` successfully logged in, created a project/token, and uploaded its 50 MB attachment through MCP, then **clone returned HTTP 500 from the bridge's token-validation flow**. No native clone/pull success has been recorded. Its temporary Git/MCP tokens were revoked by the test cleanup.

m701 subsequently became unreachable on SSH both through the normal gateway and from m601 (`172.25.4.71`). The API-error diagnostic and improved 403 response are in source but could not be deployed there after that interruption. Do not describe port 18084 as a working Git preview until this is resolved. Private local evidence is under `.local/git-check` and `.local/git-upstream`.

## Resume steps

1. Confirm m701 SSH is available. Sync the current source to the isolated directory and rebuild both experimental images. Keep `GIT_ACCESS_ENABLED=true` only in this lab. Start the existing Compose project with its existing private `.env` and volumes.
2. Inspect the adapter's sanitized error code and bridge response status during token validation. Verify the public `/git/<projectId>/info/refs` proxy preserves the project ID and the bridge sends the same service secret as the API worker. Use private files/environment for credentials; never put a Git token in a remote URL or diagnostic output.
3. Forward port 18084 and run `npm run smoke:git`. Resolve the first real CE failure, then complete native clone/pull, unchanged fetch, attachment integrity and revocation. Exercise the native dialog in a browser. Capture the final image digests and tested source commit.
4. Prototype recoverable push. The deployed updater's `UpdateManager.lockUpdatesAndDo` already drains a **per-project** realtime queue under `ProjectLockManager`; the existing CAS spans one HTTP operation. Combine this with the native structure lock and a durable apply barrier. The unrelated `blockProject` only blocks loading an unloaded project. Verify browser pending edits and crash recovery before enabling receive-pack.

## Reproducing the optional lab configuration

`compose.git.yaml` adds the bridge and enables the API. Generate `GIT_BRIDGE_SERVICE_SECRET` in the ignored, mode-0600 `.env`, alongside the existing session secrets. Both services must receive the same value. Do not publish port 4001 or the bridge's port 8000 to the host; the application nginx exposes only the Git smart HTTP paths. The current proxy uses Docker's embedded resolver; Kubernetes routing configuration is a later release-preparation step.

```sh
docker compose -f compose.yaml -f compose.git.yaml build
docker compose -f compose.yaml -f compose.git.yaml up -d
npm run smoke:git
```

For a base lab on port 18080, set `OVERLEAF_LAB_ORIGIN=http://localhost:18080`; the smoke script defaults to the m701 preview on 18084. `OVERLEAF_LAB_ACCOUNT` must name a mode-0600 JSON file containing a synthetic `@example.invalid` account's `email` and `password`.

The standalone transport test takes `GIT_BRIDGE_JAR` when the built JAR is outside `.local/git-upstream/git-bridge/target`. It starts its own private API and Java process and removes its temporary Git repositories. The Maven image uses Java 21; the local transport run used Java 26 with the Java-21-targeted artifact. The native CE base remains the pinned 6.3.2 image recorded in [progress](progress.md).
