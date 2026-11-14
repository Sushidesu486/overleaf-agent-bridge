# Git preview: implementation and handoff

Status: read-only compatibility milestone validated in the isolated m700 lab, 2026-11-15. Production Git access is not enabled. The complete feature scope remains in [the design](git-remote-design.md).

## Implemented

- Optional native `git-access` module and **Integrations → Git** dialog. The project owner enables access; members issue named, project-scoped human/Agent tokens, view usage/expiry and revoke them. Tokens expire after 90 days and only digests are stored. The prototype offers read-only tokens in the UI.
- A private API listener in the CE **API worker** on port 4001. CE runs a separate Web worker; starting the listener in both workers causes `EADDRINUSE`. The current source guards it with `Settings.enabledServices.includes('api')`.
- Official Java/JGit core pinned to `e039ad26c5bf5422eb57b89fc7e57c75055e631d`. The build verifies the source archive and the two patched files. Small CE patches add the internal service header and project/read-write context to token validation, and return a useful 403 for permission denial.
- Native history ZIP export with `X-History-Version`; all Git files are downloaded from one immutable on-disk snapshot. Downloads are signed for 15 minutes and recheck token revocation and project membership. Reads renew two-day export retention; cleanup is serialized with readers and runs when publishing a newer snapshot. Permanent bridge Git history is retained separately. The prototype uses the bridge's service-author fallback; precise web-editor attribution remains pending.
- Per-file 50,000,000-byte and per-snapshot 500,000,000-byte transfer limits, with 2,000 entries. The text-write limit is not exercised until push is implemented. Repeated unchanged fetches retain their Git commit.
- Push is denied before receive-pack. The manifest apply callback, native write barrier, recovery and final Git ref reconciliation remain unimplemented.

## Validation completed

**Real CE and Git clients.** The isolated m700 instance passed `npm run smoke:git`: clone, unchanged fetch, MCP edit → pull, Chinese text, a **50,000,000-byte binary SHA-256 round trip**, read-only push rejection, cross-project denial and revocation. The first native run used the same patched CE code with the base TeX installation. The full-TeX image then passed the complete Git flow with a 1 MB fixture and the existing `npm run smoke` MCP compilation/PDF/account-isolation checks. The final UI-only change passed a new native frontend build and browser acceptance.

**Transport contract.** The actual patched Java/JGit process also passed `npm run smoke:git-bridge` against an in-memory Snapshot API fixture, including the 50 MB boundary. This remains a fast way to check protocol changes without starting CE. The Docker bridge uses Java 21; the standalone local test used Java 26 with Java-21-targeted classes.

**Native UI.** Headless Chromium verified Integrations → Git, the clone command, copying, named Agent-token creation and revocation. Light and dark screenshots were visually inspected. Git controls use the native theme variables and the dialog scrolls on shorter viewports. Private screenshots and session files are under `.local/git-check`; credentials and displayed token values are not published.

**Checks and review.** `npm ci`, typecheck, TypeScript build and full tests passed (73 passed, 8 optional Mongo tests skipped in the local suite). The new Git token-store regression and snapshot-retention regression separately passed against the real MongoDB/native Node environment on m700. Standards and Spec reviews identified hidden active tokens after repeated rotations and premature cleanup of recently served snapshots; commit `0ab6f34` fixes both. The UI theme and custom-config smoke fixes are in `8dd5905`.

## Runtime and source

Development worktree on shared NFS: `/home/shouss/projects/overleaf-git-dev`, branch `feat/git-remote`. The original `/home/shouss/projects/overleaf-agent` checkout is preserved.

The running isolated environment is **m700**, `/var/tmp/overleaf-git-check`, Compose project `overleaf-git-check-m700`, host loopback port **18084**. Build staging and Docker volumes use m700's local disk because the shared NFS was nearly full. MongoDB, Redis, application data and Git history are independent of production. The existing private `.env` and synthetic `account.json` from the earlier lab were reused; users/projects were freshly created in this lab.

Tested source: `8dd5905` (Git core and API at `8695400` / `0ab6f34`, followed by native theme and smoke fixes). Local image identities:

| Image | Local image digest |
| --- | --- |
| `overleaf-git-check:m700` | `sha256:e67daf9bb0f6c7dfa279a0ebf4f02ae81989b87b5bd01c7d16bd143f1b540d7f` |
| `overleaf-git-bridge:m700` | `sha256:c4dee14297197cfd15f164941052494259b94f158e7921af5b7872ec64183a51` |

These are lab images, not registry releases. CE remains the pinned 6.3.2 base (`d17e196…`, runtime revision `370f4763da4bc910da8309c9a71c85ecbe39f6a7`). The Git core is pinned independently as listed above. To work around download failures on m700, the bridge build used the checksum-verified cached upstream archive and cached Maven dependencies, compiled by the pinned Java 21 image. The application's full TeX installation used the ZJU CTAN mirror and passed the existing TeX/report/EPS build checks.

The earlier m701 lab remains at `/home/shouss/projects/overleaf-git-check` with separate host-local Docker volumes. Its first startup exposed the Web/API double-listener conflict, which was fixed. A subsequent clone returned 500 during token validation, then m701 became unreachable. The user redirected development to m700; fresh builds there passed native authentication and clone/pull. The old m701 500 was not diagnosed conclusively and is not the state of the current m700 preview.

## Next: recoverable push

Push remains disabled before receive-pack. The next implementation slice must coordinate the native updater's **per-project** queue/lock with the native structure lock and a durable apply barrier. Stage blobs first, drain accepted edits, recheck the snapshot base, apply through native handlers and persist progress before postback. Reconcile crashes around native apply, postback and Git ref persistence before enabling writes.

Minimum acceptance: text/binary create-edit-delete, unchanged native document IDs for content edits, a stale-base rejection, concurrent browser and two-client writes, restart recovery, and authenticated human/Agent attribution. Precise editor authorship, history labels, Windows credential verification and release/backup preparation follow this read-only milestone. Production deployment remains a separate step after preview acceptance.

## Reproducing the optional lab configuration

`compose.git.yaml` adds the bridge and enables the API. Generate `GIT_BRIDGE_SERVICE_SECRET` in the ignored, mode-0600 `.env`, alongside the existing session secrets. Both services must receive the same value. Do not publish port 4001 or the bridge's port 8000 to the host; the application nginx exposes only the Git smart HTTP paths. The current proxy uses Docker's embedded resolver; Kubernetes routing configuration is a later release-preparation step.

```sh
npm ci
npm run build:extension
npm run build:connector
docker compose -f compose.yaml -f compose.git.yaml build
docker compose -f compose.yaml -f compose.git.yaml up -d
npm run smoke:git
```

For a base lab on port 18080, set `OVERLEAF_LAB_ORIGIN=http://localhost:18080`; the smoke script defaults to the m701 preview on 18084. `OVERLEAF_LAB_ACCOUNT` must name a mode-0600 JSON file containing a synthetic `@example.invalid` account's `email` and `password`.

The standalone transport test takes `GIT_BRIDGE_JAR` when the built JAR is outside `.local/git-upstream/git-bridge/target`. It starts its own private API and Java process and removes its temporary Git repositories. The Maven image uses Java 21; the local transport run used Java 26 with the Java-21-targeted artifact. The native CE base remains the pinned 6.3.2 image recorded in [progress](progress.md).
