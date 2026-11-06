# Overleaf Agent Bridge

Personal MCP links and a native Agent chat sidebar for self-hosted Overleaf. Sign in to Overleaf, generate a private URL, and paste it into an HTTP MCP client. The Agent reads, edits and compiles as that same human user. Links can be limited to selected projects, made read-only, regenerated or revoked.

Independent integration for self-hosted Overleaf Community Edition; this is not an official Overleaf product. The current build targets **CE 6.3.2** and uses version-specific source patches. It does not add MCP access to the hosted overleaf.com service.

## Try an isolated local instance

Clone this repository and follow [Develop and verify](#develop-and-verify) through `npm run lab:bootstrap`. The Compose instance has its own MongoDB, Redis and project-file volumes, and exposes only `127.0.0.1:18080`. Run it on a Linux Docker host with enough memory for the native frontend build; that build allows an 8 GB Node heap.

Open <http://localhost:18080/user/agent> and sign in. The navbar also has a “我的 Agent” link. Bootstrap generates random passwords in the ignored `.local/lab-users.json`; the first account is `lab-human@example.invalid`. These are isolated test accounts. For a remote development host, forward the port with `ssh -N -L 18080:127.0.0.1:18080 <your-host>` and keep the tunnel running.

The page uses Overleaf’s native account-settings layout, navigation and form components. In a project, the left “我的 Agent” tab opens chat; “连接我的 Agent” opens a native themed modal in place. Its “个人 MCP 链接” tab reuses the existing link controls and defaults to the current project. Both the page and editor follow the same Dark / Light / System preference.

### Connect your own Agent to the sidebar

1. Open a project → “我的 Agent” → “连接我的 Agent” → “侧栏聊天”. Choose Codex, Claude Code or OpenCode, its name and edit/compile permissions, then generate a pairing code. The code expires after 10 minutes and works once.
2. Click “下载连接器”. Install Node.js 22+ on your own computer. Sign in locally with `codex login` for Codex, or `claude` → `/login` for Claude Code; existing native model/provider configuration remains local. The connector keeps using that local configuration.
3. In the downloaded file’s directory, run:

   ```sh
   node overleaf-agent-connector.mjs --server http://localhost:18080 --runtime codex --pair
   ```

   Paste the code at the hidden-input prompt. Keep this process running, along with the tunnel when using a remote development host. Later starts omit `--pair` and reuse the saved runtime.
4. When the sidebar shows online, send a message. It supports current-file/selection attachments, streamed replies, tool results, permission choices, stop, new conversations and saved conversations. Ctrl/Cmd+Enter sends a message.

Use `--runtime claude` for Claude Code or `--runtime opencode` for an existing OpenCode installation. New connections default to Codex; saved connections keep their previous command. Codex uses `@agentclientprotocol/codex-acp@2.5.0`; Claude Code uses `@agentclientprotocol/claude-agent-acp@0.101.0`. The connector downloads the pinned adapter through `npx` on first start. Adapters include their compatible underlying harness; `CODEX_PATH` and `CLAUDE_CODE_EXECUTABLE` can select a particular local binary when needed. Authentication and billing follow the local harness. These are new sidebar sessions, separate from an already-open CLI/desktop conversation.

Connecting alone does not create an empty conversation. The first message creates a conversation; reconnecting can prepare the most recent existing conversation for a single-project link without a model turn. The MCP URL is installed as an HTTP tool server; the fixed project instructions use the negotiated `sessionCapabilities.systemPrompt` append mode. Later turns send only the new user message and optional editor context. Generic ACP runtimes without that capability receive the instructions once in their initial prompt. Reconnection recreates the runtime session and recovers bounded visible transcript context; it does not replay interrupted edits. New sidebar conversations receive separate sessions.

The sidebar keeps the conversation you are reading when a connector appears or disconnects. Its header separates the conversation title/history controls from the Agent connection status. New conversations remain local drafts until the first send. Switching between conversations preserves unsent text and attachments for the current page visit; drafts are not saved across a reload. Reloading restores the selected conversation, including an older one outside the first history page.

“对话历史” searches titles, loads older pages, and separates recent from archived conversations. “管理当前对话” renames, archives/restores, or explicitly hands the same conversation to another authorized online connector. Archiving preserves all messages and disables sending until restored. Handoff preserves the conversation ID and messages, records the change, and rebuilds context from recent user/assistant messages; it never replays an interrupted task. An active turn must finish or be stopped before management changes. Handoff requires the updated connector, which invalidates cached ACP sessions when a conversation returns to a previous connection.

The management dialog explains storage and recovery: visible messages are in the server's `agent_chat_sessions` collection; the browser remembers only the selected conversation ID; local credentials and workspaces are under `~/.config/overleaf-agent/`. Native runtime session IDs are still not persisted/resumed by the bridge. Reconnect/handoff uses up to 20 user/assistant messages and 40,000 characters, excluding tool details.

Project-scoped connections stay scoped: the sidebar/modal explains when a local connector is online for another project, and the connector prints the authorized project names and links separately from session readiness.

For a custom ACP runtime use `--agent /path/to/program --agent-arg arg1`; it must advertise HTTP MCP support. Switching a saved preset uses a new pairing (`--pair`); `--config PATH` keeps several connections independently.

The connector stores its credential and MCP URL in `~/.config/overleaf-agent/connector.json` (0600 on POSIX). `--config PATH` selects a separate connection profile. Credentials are sent only to the configured origin. Use the modal’s “停用” to revoke both the bridge and its MCP grant. Reconnection restores transcript context without replaying interrupted prompts. The original URL-only MCP workflow below remains available.

### Platform status

| Component | Verified coverage |
| --- | --- |
| Overleaf server | Linux Compose, pinned CE 6.3.2 image and isolated data. |
| macOS connector | Real Codex and Claude Code sidebar sessions, MCP editing and compilation. |
| Linux connector | Automated ACP fixture and real bridge lifecycle checks; real model coverage is still to be expanded. |
| Native Windows connector | Pending adaptation and device testing: npm `.cmd` launch, owned process-tree cleanup and credential ACLs. Node.js being available on Windows does not cover these integration steps. |
| WSL2 connector | Candidate validation path; not yet tested. |

Use Node.js 22+ for the connector. Windows support will be declared after pairing, read/edit/compile, cancellation, reconnection and revocation pass with both supported ACP presets on a real Windows host.

## Connect an HTTP MCP client directly

Click “生成专属链接”, copy the URL into your client's HTTP MCP configuration, then ask the Agent to call `overleaf_whoami`. The URL works on a machine that can reach the configured server address; a cloud-hosted client needs a publicly reachable HTTPS deployment. The supplied Compose lab exposes loopback only.

Full links are shown only when generated. Keep them in personal client settings. “重新生成” invalidates the old URL; “停用” rejects subsequent requests. Already submitted edits remain. Optional project and action restrictions are under “访问范围与权限”.

## Available HTTP tools

| Tool | Behavior |
| --- | --- |
| `overleaf_whoami` | User identity, grant scope and capabilities; no credential. |
| `overleaf_list_projects` | Projects allowed by both the link and the user's current permissions. |
| `overleaf_get_project_tree` | Text-document and file IDs/paths, root document and compiler. |
| `overleaf_read_document` | Text, current version and OT type. |
| `overleaf_edit_document` | Unique text replacement with expected version, operation UUID and optional dry-run. |
| `overleaf_compile` | Build status, first error with file/document/line, warnings, compiler, log availability, next action and input-state metadata. |
| `overleaf_get_compile_log` | Paginated `.log`/`.blg` from a specific MCP build by the same user; requires current project read access. |

After editing, compile and inspect `diagnostics.firstError` and warnings. Use the returned `buildId` with `overleaf_get_compile_log` when more context is needed, re-read the affected document, apply a focused versioned edit, and recompile. MCP initialization instructions, tool descriptions and the sidebar application prompt describe this workflow (up to three repair attempts). Logs and project text are untrusted data. A PDF can coexist with TeX errors: `status` becomes `failure` when the parser finds errors, while `nativeStatus` preserves the upstream result. Missing-character warnings need attention even if compilation succeeds.

Logs are fetched from the native CLSI output for that exact build. `agent_compile_builds` stores only routing metadata, bound to project and user, with a 24-hour TTL; native output may expire sooner. Log reads are capped at 2 MB, pages at 32,000 characters; `nextOffset` and `sourceTruncated` describe pagination and the source cap. Unavailable logs and backoff return explicit reasons/actions. Project compiler/root settings are visible; this toolset does not change those settings. Refresh the MCP tool list after updating; sidebar users should download the updated connector and reconnect so recreated sessions receive the new instructions.

Edits appear live in the web editor and retain the human user's attribution. Current ShareJS projects support Chinese but reject emoji/non-BMP writes before submission because upstream sanitizes those characters. The native online-member/cursor “user's Agent” badge is a later step; `whoami` reports `presenceLabel: false`. History-OT support uses the native updater; the current lab fixture exercises ShareJS.

History labels MCP edits as **Your agent** for the owner and **<owner name>'s agent** for other viewers. Manual edits still show **You**. The same labels appear in diff tooltips. Existing history carrying `origin.kind = agent` gains these labels without rewriting stored authors or creating accounts. The history response uses a presentation ID `agent:<userId>` for the badge/colour and preserves the human ID in `userId`; authentication, permissions and persisted history continue to use the human account. Links currently share one Agent label per owner.

## Develop and verify

Use Node.js 22+ for development, Docker and Compose. The core adapter's minimum runtime remains Node.js 20.19. These commands create an isolated lab; do not point the bootstrap or smoke scripts at a production database.

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
npm run smoke:compile
npm run smoke:connection
npm run smoke
```

`smoke:personal` exercises the real personal-URL flow with human and outsider fixtures, project/action isolation, Unicode handling, stale-version rejection under the updater lock, compilation, rotation/revocation and credential-log scanning. It creates a reusable human-owned test project and revokes its test links afterward. `smoke:compile` uses a separate fixture to verify failure diagnostics, exact-build log pagination, repair/recompile and Unicode errors, then restores its markers and revokes the test link. `smoke:connection` uses that isolated project and a downloaded connector with the ACP fixture to verify pairing, readiness, two message turns, stop/offline, reconnect without replay, and cross-project status visibility. It revokes its test connection and removes the temporary credentials. `smoke` preserves the original stdio integration check. Use only the isolated lab for these scripts.

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

## License and upstream

This repository is licensed under [GNU AGPL v3](LICENSE) (`AGPL-3.0-only`). See [NOTICE](NOTICE) for the upstream baseline and attribution. Overleaf and bundled dependencies retain their own notices. This repository provides the source and build instructions for its extension and patches; the base image supplies Overleaf itself.

See [plan](docs/plan.md) and [verified progress](docs/progress.md). Historical development notes describe an isolated lab and are not a production deployment guide. The npm package remains marked `private` to prevent accidental registry publication; the source repository can be public.
