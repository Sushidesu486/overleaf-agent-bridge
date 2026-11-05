# Development progress

Personal-URL milestone verified 2026-11-05T19:58:35+08:00 on m701. Sources: Compose health, official MCP SDK clients, the real Overleaf smoke script and Chrome UI/editor interaction. Old production Overleaf and its databases remain unchanged.

History attribution verified 2026-11-05T22:55:53+08:00 on m701. Sources: native history API/diff responses, the patched native compressor, and Chrome on the existing `test` project. Previously recorded MCP edits now show `Your agent`, while the manual creation still shows `You`; the existing document content was not changed for this check.

Native UI milestone verified 2026-11-06T00:37:28+08:00 on m701. Sources: the native production webpack build, Chrome desktop/mobile interaction, personal MCP smoke and the legacy compilation smoke. The account page now shares Overleaf’s layout/components; the editor exposes a native Agent sidebar entry.

## Delivered

- Repository `/home/shouss/projects/overleaf-agent`, branch `main`, no Git remote configured. User-facing page: `http://localhost:18080/user/agent` through an SSH tunnel.
- Human login → personal URL generation → direct HTTP MCP connection. Uses the same human identity, without an additional Overleaf account or a client OAuth round trip.
- Named grants support all current user-accessible projects or a selected subset, read/edit/compile scopes, last-use time, rotation and revocation. Secrets are displayed once and stored only as digests.
- Native “我的 Agent” account page uses `layout-react`, `OLPageContentCard`, shared form/button/notification components and the application navbar. Connections show current project names and an optional revoked-link view.
- The editor’s `railEntries` extension opens a project Agent panel; its link opens management in a new tab, preselects the current project, and preserves the editor. Invalid or inaccessible project context disables link creation.
- Six HTTP tools: identity, project list, project tree, versioned document reads, unique-text replacement, compilation. The old three-tool stdio adapter remains available.
- Edits use the native updater's OT, history and broadcast path. A pinned source patch adds expectedVersion comparison inside its existing document lock. The adapter reauthorizes immediately before submitting, rejects unknown document types, and reserves operation IDs so interrupted submissions are not replayed.
- History uses persisted `origin.kind=agent` to present the owner as `Your agent`, or `<owner name>'s agent` to other viewers, including diff tooltip metadata. Only history responses use the presentation ID `agent:<userId>`; the human ID is retained in `userId`. Stored authors and account permissions remain unchanged. Adjacent human/Agent insertions and deletions stay separate in diff compression.
- Compile responses contain build ID, observed root-document version, observation time, available native history version, and `snapshotPinned: false` for live project inputs.
- Original lab Agent account remains only a fixture for old stdio tests. Personal-URL tests use `lab-human@example.invalid` and the unrelated human fixture. Human-owned sample project: `6aec6b41a662231c7da0943a`.

## Verification

- Typecheck, TypeScript build and all seven tests passed. The targeted new revocation test covers a grant withdrawn during backend preparation, before the actual write.
- `npm run smoke:personal`: human-account MCP connection, scoped project access, Chinese replacement, dry-run, stale-version rejection at both MCP and updater-lock levels, compilation, read-only/outsider denial, CSRF, rotation, revocation and credential-log scan passed. Each run revokes its test links.
- `npm run smoke`: original stdio handshake/list/compile, real PDF header (248,689 bytes), allowlist rejection and unrelated-account denial passed.
- Chrome: actual login and link generation, desktop/mobile page inspection, live update in the open CodeMirror editor, matching human `user_id` in the received update, and UI revocation passed. A raw HTTP MCP client in that check used the exact generated URL; no extra Authorization header was needed.
- Code-review Standards axis: no actionable violation. Spec axis found three issues (late revocation, unknown OT types, compile input state); all three were fixed and the reviewer confirmed closure.
- `docker compose config --quiet` and diff whitespace checks passed. Compose services are healthy.
- History change: typecheck/build, all 10 tests, personal and legacy smoke passed. The native compressor regression failed on the prior image and passed after the patch, covering inserts/deletes in both human→Agent and Agent→human order. `smoke:personal` now verifies History author IDs, display names, diff metadata and private/no-store caching. Chrome confirmed `Your agent` and `You` badges, rendered the existing document's diff, and showed `Added by Your agent` on hover; collaborator labels are covered by the presentation-module tests.

History change review: Standards 0 actionable findings; Spec 0 findings. Both axes checked the native presentation and history merge paths against the same-account Agent requirement.

Native UI verification: the production frontend build, core typecheck and 10 tests passed. Chrome checked native button font/colour/radius, navbar, desktop/mobile layout, editor rail entry, single-project defaults, create/rotate/revoke and blocked invalid context, with no page errors. A final fresh 390px viewport check confirmed the connection table scrolls internally (608px content within 318px) without widening the page. Personal and legacy MCP smoke passed. Standards and Spec reviews each reported 0 actionable findings. A separate TypeScript probe of native frontend imports could not complete because the CE image omits commercial-module declarations (and the narrowed probe lacked the Cypress global); webpack and real-browser checks provide the frontend verification for this milestone.

## Runtime and implementation decisions

- Base: Overleaf CE 6.3.2, upstream image digest `sha256:d17e196b04222837440b5efb2890864eb200a2e9341e434c0e6bd57a61011cbb`; revision `370f4763da4bc910da8309c9a71c85ecbe39f6a7`.
- Derived image: `overleaf-agent-lab:6.3.2-dev`, local image ID `sha256:aa383996ab4b15d28d928ffcdeca9aefe2d4c0c81e62136839d8cc1250345b4b`. Dockerfile and source-hash checks define how to reproduce the extension on this base. The preceding History image was `sha256:bf520465740e079482e587f8437c02009a674c5a7d9523f6b6e46b6ae2f88cfa`; the first personal-URL image was `sha256:0a14f3de38af03bd996e5994705f49379b0163d9e94f88ec805b603dbd0819b5`.
- TeX Live 2026, MongoDB 8.0.34 (single-member replica set), Redis 7.4.12/AOF. Baseline versions were verified at 2026-11-05T17:24:53+08:00; this milestone keeps those base dependencies.
- Frontend build: restore the pinned web workspace’s development dependencies from the image’s Yarn cache with networking/scripts disabled, then rebuild every entrypoint and the asset manifest together. Copy only the generated assets and compiled Pug page into the runtime stage, retaining its production dependencies. `patches/frontend.py` guards module registration and the rail tab type against known source hashes.
- The first implementation runs a separately bundled MCP module inside Overleaf Web. This gives the authorization code direct access to native user/project permission checks and avoids creating unrestricted user sessions. A separate gateway can be introduced if operational needs justify it later.
- Nginx suppresses credential-route access/error logs and forwards a fixed internal URL. The extension consumes and removes the credential header. HTTP MCP is stateless and revalidates every request. Grant and edit-operation metadata are in the new `agent_grants` and `agent_operations` collections within this lab database.
- Independent Docker volumes/network; only `127.0.0.1:18080` is published, no database port or GPU. Stop with `docker compose stop` to preserve data.

## Remaining work

- Native online-member/cursor Agent label; persisted history and live updates retain the human user ID. History now distinguishes the Agent, while `overleaf_whoami` still reports `presenceLabel: false` for online presence. All personal links for one user share the same history Agent label.
- Real configuration checks in students' chosen MCP applications. Official SDK and direct HTTP clients are verified; application-specific OAuth requirements or URL-import behavior are not yet tested.
- ShareJS replaces surrogate code units upstream. The adapter rejects emoji/non-BMP writes before submission, while Chinese works. The native history-OT path is allowed but still needs its own real-project fixture before broad use.
- HTTPS domain, production gateway redaction, K8s delivery, quotas and broader user rollout. Cloud-hosted clients cannot reach this loopback-only lab.
- Optional file creation, artifact/log retrieval, native review UI, IPA integration and old-instance migration remain separate milestones. Compile filenames and the editor link are returned; the new HTTP tools do not yet download PDFs.

## Image transfer history

The initial base-image pull encountered incomplete Harbor layers and Docker Hub rate limiting. Official Docker Hub/ECR blobs were fetched in ranges and every manifest/config/layer SHA-256 verified before importing OCI archives. Scratch archives were removed. Current extension builds use that cached pinned base; future K8s delivery will use the normal project registry path.
