# Overleaf Agent

Personal MCP links for self-hosted Overleaf. Sign in to Overleaf, generate a private URL, and paste it into an HTTP MCP client. The Agent reads, edits and compiles as that same human user. Links can be limited to selected projects, made read-only, regenerated or revoked.

## Try the m701 lab

Repository: `/home/shouss/projects/overleaf-agent`. The isolated CE 6.3.2 lab listens only on m701's loopback interface. From your computer:

```sh
ssh -N -L 18080:127.0.0.1:18080 m701
```

Open <http://localhost:18080/user/agent> and sign in. The navbar also has a “我的 Agent” link. Lab credentials are in `.local/lab-users.json` on m701; the first account is `lab-human@example.invalid`. These are separate from production accounts.

Click “生成专属链接”, copy the URL into your client's HTTP MCP configuration, then ask the Agent to call `overleaf_whoami`. The URL works on a machine that can reach that loopback address through the tunnel; a cloud-hosted client needs a publicly reachable HTTPS deployment, which has not been set up yet.

Full links are shown only when generated. Keep them in personal client settings. “重新生成” invalidates the old URL; “停用” rejects subsequent requests. Already submitted edits remain. Optional project and action restrictions are under “访问范围与权限”.

## Available HTTP tools

| Tool | Behavior |
| --- | --- |
| `overleaf_whoami` | User identity, grant scope and capabilities; no credential. |
| `overleaf_list_projects` | Projects allowed by both the link and the user's current permissions. |
| `overleaf_get_project_tree` | Text-document and file IDs and paths. |
| `overleaf_read_document` | Text, current version and OT type. |
| `overleaf_edit_document` | Unique text replacement with expected version, operation UUID and optional dry-run. |
| `overleaf_compile` | Build status, output filenames, editor link and input-state metadata. |

Edits appear live in the web editor and retain the human user's attribution. Current ShareJS projects support Chinese but reject emoji/non-BMP writes before submission because upstream sanitizes those characters. The native online-member/cursor “user's Agent” badge is a later step; `whoami` reports `presenceLabel: false`. History-OT support uses the native updater; the current lab fixture exercises ShareJS.

History labels MCP edits as **Your agent** for the owner and **<owner name>'s agent** for other viewers. Manual edits still show **You**. The same labels appear in diff tooltips. Existing history carrying `origin.kind = agent` gains these labels without rewriting stored authors or creating accounts. The history response uses a presentation ID `agent:<userId>` for the badge/colour and preserves the human ID in `userId`; authentication, permissions and persisted history continue to use the human account. Links currently share one Agent label per owner.

## Develop and verify

Node.js 20.19+, Docker and Compose are required.

```sh
npm ci
npm run lab:init
npm run build:extension
docker compose build overleaf
docker compose config --quiet
docker compose up -d --wait --wait-timeout 300
npm run lab:bootstrap
npm run typecheck
npm run build
npm test
docker compose exec -T overleaf node --input-type=module < test/history-native.mjs
npm run smoke:personal
npm run smoke
```

`smoke:personal` exercises the real personal-URL flow with human and outsider fixtures, project/action isolation, Unicode handling, stale-version rejection under the updater lock, compilation, rotation/revocation and credential-log scanning. It creates a reusable human-owned test project and revokes its test links afterward. `smoke` preserves the original stdio integration check. Use only the isolated lab for these scripts.

The web extension is bundled from `src/agent` into ignored `extensions/agent-access/mcp.cjs`. The image is built from the pinned CE digest in `Dockerfile`; `patches/install.py` and `patches/history.py` reject unexpected upstream source hashes. The history patch presents Agent actors after user resolution and keeps adjacent human/Agent diff fragments separate. The extension uses existing login/CSRF and project authorization, with no human password or unrestricted browser-session delegation.

Link digests and scoped grants live in the application's `agent_grants` collection; edit operation records live in `agent_operations`. Mongo backups include both. The HTTP transport is stateless: every request carries and validates the personal credential. Nginx removes the secret path before forwarding and suppresses credential-route access/error logging; the module removes the private credential header before downstream logging. A future public gateway needs the same redaction rules. Compile input metadata describes observed versions; it does not pin a multi-document snapshot.

To rebuild after changes, run `npm run build:extension`, `docker compose build overleaf`, then `docker compose up -d --no-deps --wait overleaf`. Stop without removing data using `docker compose stop`. Roll back to the pinned upstream image in `Dockerfile` to disable the extension while preserving project data and dormant grant collections.

## Local stdio diagnostic

The original three-tool stdio adapter remains available for protocol debugging. After `npm run build`, launch `node dist/src/server.js` with `OVERLEAF_AGENT_CONFIG` pointing to a mode-0600 lab configuration. It uses its own explicit project allowlist. The personal HTTP flow does not use those credentials.

See [plan](docs/plan.md) and [verified progress](docs/progress.md). The development repository is private/unpublished; the standalone package license has not yet been selected. The image contains Overleaf and version-specific source patches; distribution must preserve upstream licensing requirements.
