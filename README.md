# Overleaf Agent

Personal MCP links and a native Agent chat sidebar for self-hosted Overleaf. Sign in to Overleaf, generate a private URL, and paste it into an HTTP MCP client. The Agent reads, edits and compiles as that same human user. Links can be limited to selected projects, made read-only, regenerated or revoked.

## Try the m701 lab

Repository: `/home/shouss/projects/overleaf-agent`. The isolated CE 6.3.2 lab listens only on m701's loopback interface. From your computer:

```sh
ssh -N -L 18080:127.0.0.1:18080 m701
```

Open <http://localhost:18080/user/agent> and sign in. The navbar also has a “我的 Agent” link. Lab credentials are in `.local/lab-users.json` on m701; the first account is `lab-human@example.invalid`. These are separate from production accounts.

The page uses Overleaf’s native account-settings layout, navigation and form components. In a project, the left “我的 Agent” tab opens chat; “连接我的 Agent” opens a native themed modal in place. Its “个人 MCP 链接” tab reuses the existing link controls and defaults to the current project. Both the page and editor follow the same Dark / Light / System preference.

### Connect your own Agent to the sidebar

1. Open a project → “我的 Agent” → “连接我的 Agent” → “侧栏聊天”. Choose Codex, Claude Code or OpenCode, its name and edit/compile permissions, then generate a pairing code. The code expires after 10 minutes and works once.
2. Click “下载连接器”. Install Node.js 22+ on your own computer. Sign in locally with `codex login` for Codex, or `claude` → `/login` for Claude Code; existing native model/provider configuration remains local. The connector keeps using that local configuration.
3. In the downloaded file’s directory, run:

   ```sh
   node overleaf-agent-connector.mjs --server http://localhost:18080 --runtime codex --pair
   ```

   Paste the code at the hidden-input prompt. Keep this process and the SSH tunnel running. Later starts omit `--pair` and reuse the saved runtime.
4. When the sidebar shows online, send a message. It supports current-file/selection attachments, streamed replies, tool results, permission choices, stop, new conversations and saved conversations. Ctrl/Cmd+Enter sends a message.

Use `--runtime claude` for Claude Code or `--runtime opencode` for an existing OpenCode installation. New connections default to Codex; saved connections keep their previous command. Codex uses `@agentclientprotocol/codex-acp@2.5.0`; Claude Code uses `@agentclientprotocol/claude-agent-acp@0.101.0`. The connector downloads the pinned adapter through `npx` on first start. Adapters include their compatible underlying harness; `CODEX_PATH` and `CLAUDE_CODE_EXECUTABLE` can select a particular local binary when needed. Authentication and billing follow the local harness. These are new sidebar sessions, separate from an already-open CLI/desktop conversation.

On connection, a single-project link creates or restores its latest sidebar conversation and prepares the ACP session without a model turn. The MCP URL is installed as an HTTP tool server; the fixed project instructions use the negotiated `sessionCapabilities.systemPrompt` append mode. Later turns send only the new user message and optional editor context. Generic ACP runtimes without that capability receive the instructions once in their initial prompt. Reconnection recreates the runtime session and recovers bounded visible transcript context; it does not replay interrupted edits. New sidebar conversations receive separate sessions.

For a custom ACP runtime use `--agent /path/to/program --agent-arg arg1`; it must advertise HTTP MCP support. Switching a saved preset uses a new pairing (`--pair`); `--config PATH` keeps several connections independently.

The connector stores its credential and MCP URL in `~/.config/overleaf-agent/connector.json` (0600). `--config PATH` selects a separate connection profile. Credentials are sent only to the configured origin. Use the modal’s “停用” to revoke both the bridge and its MCP grant. Reconnection restores transcript context without replaying interrupted prompts. The original URL-only MCP workflow below remains available.

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
npm run build:connector
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

The native React frontend is built from the pinned image’s source and cached Yarn dependencies in a separate Docker build stage. It uses `layout-react`, `OLPageContentCard`, native form/button components and the `railEntries` extension point. All frontend entrypoints are rebuilt together to keep the shared runtime and manifest consistent; the runtime image retains its original production dependencies. `patches/frontend.py` checks the upstream registration/type/stylesheet files and the native external-update notification handler before changing them.

The web extension is bundled from `src/agent` and `src/chat` into ignored `extensions/agent-access/mcp.cjs`. The image is built from the pinned CE digest in `Dockerfile`; `patches/install.py` and `patches/history.py` reject unexpected upstream source hashes. The history patch presents Agent actors after user resolution and keeps adjacent human/Agent diff fragments separate. The extension uses existing login/CSRF and project authorization, with no human password or unrestricted browser-session delegation.

Link digests and scoped grants live in the application's `agent_grants` collection; edit operation records live in `agent_operations`. Mongo backups include both. The HTTP transport is stateless: every request carries and validates the personal credential. Nginx removes the secret path before forwarding and suppresses credential-route access/error logging; the module removes the private credential header before downstream logging. A future public gateway needs the same redaction rules. Compile input metadata describes observed versions; it does not pin a multi-document snapshot.

To rebuild after changes, run `npm run build:extension`, `npm run build:connector`, `docker compose build overleaf`, then `docker compose up -d --no-deps --wait overleaf`. Stop without removing data using `docker compose stop`. Roll back to the pinned upstream image in `Dockerfile` to disable the extension while preserving project data and dormant grant collections.

## Sidebar transport and persistence

The connector launches its locally configured Agent using ACP v1 over stdio. It opens an outbound SSE command stream to `/agent-bridge/connect` and posts results to `/agent-bridge/events`; the browser receives authenticated session snapshots over SSE and uses native CSRF-protected POST routes. This reuses the existing HTTP port without inbound access to the user’s device. The native HTTP MCP URL remains the document-tool channel.

`agent_chat_pairings`, `agent_chat_connections` and `agent_chat_sessions` are included in Mongo backups. Pairing and connection secrets are stored as digests. Sessions bind the human user, project and connection; the server rechecks current project access. Chat is private to its owner while document edits remain collaborative. Agent-authored external updates skip the native overwrite-warning modal; other external sources retain it, and all document edits still use the existing version check and history path.

Live streams currently belong to one Overleaf Web worker. Keep one Web replica until a shared connection-routing layer is added. Restarted/disconnected runs become interrupted, with no automatic replay. The connector recreates ACP sessions after reconnect and supplies up to the latest 20 conversational messages (40,000 characters) as recovery context; this is not an Agent’s internal reasoning state. Conversation length is bounded; start a new conversation when the UI requests it.

`test/chat.test.ts` covers one-time pairing, user/project isolation, revocation, prompt serialization, stale events and disconnect recovery. `test/acp.test.ts` runs an ACP subprocess to cover consecutive turns, multiple permission requests and cancellation. Browser verification and tested runtime versions are recorded in `docs/progress.md`.

## Local stdio diagnostic

The original three-tool stdio adapter remains available for protocol debugging. After `npm run build`, launch `node dist/src/server.js` with `OVERLEAF_AGENT_CONFIG` pointing to a mode-0600 lab configuration. It uses its own explicit project allowlist. The personal HTTP flow does not use those credentials.

See [plan](docs/plan.md) and [verified progress](docs/progress.md). The development repository is private/unpublished; the standalone package license has not yet been selected. The image contains Overleaf and version-specific source patches; distribution must preserve upstream licensing requirements.
