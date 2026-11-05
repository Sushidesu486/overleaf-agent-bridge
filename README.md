# Overleaf Agent

Independent MCP adapter for a self-hosted Overleaf. The first milestone is an isolated CE lab and a working HTTP login/project/compile loop. See [development plan](docs/plan.md) and [verified progress](docs/progress.md).

## Development on m701

Repository: `/home/shouss/projects/overleaf-agent`. Node.js 20.19+, Docker and Compose are required. The lab reserves `127.0.0.1:18080` and uses its own Docker volumes. It has no connection to production databases.

```sh
npm ci
npm run lab:init
docker compose config --quiet
docker compose up -d --wait --wait-timeout 300
npm run lab:bootstrap
npm run diagnose
npm run smoke
```

`lab:bootstrap` creates three ordinary lab-only accounts, stores random credentials under `.local/` (0600), and creates one sample project owned by the lab Agent. It does not send emails or grant site-admin privileges. The current test setup does not yet validate human invitation or realtime collaboration.

To browse the lab from your computer:

```sh
ssh -N -L 18080:127.0.0.1:18080 m701
```

Open `http://localhost:18080`. Account details are in the restricted `.local/lab-users.json` on m701; these are test accounts, unrelated to production login.

## Planned user connection

Users will sign in to their existing Overleaf account and generate a personal MCP URL. Pasting that full URL into the client's HTTP MCP configuration will connect the Agent as that user, with no additional browser authorization. The URL contains a secret and maps to a revocable project/action grant. Settings will support revocation, regeneration and optional additional named links. No extra Overleaf account is needed.

The URL must be treated as a credential. The server will store secret digests, redact credential paths before logging, and enforce current Overleaf permissions on every operation. Transport uses Streamable HTTP with custom personal-key authentication; actual client compatibility remains to be tested. Edits retain the human identity, with an Agent connection label added through an Overleaf extension.

This flow is the next milestone and is not available in the running prototype yet. The separate lab Agent account is only a test fixture. See the revised [authorization design](docs/plan.md#4-用户登录后的-agent-授权).

## Current development MCP

Run from the repository: `npm run mcp` (the script runner may print a banner, so use the direct Node command in actual clients). A stdio client should launch:

```json
{
  "command": "node",
  "args": ["/home/shouss/projects/overleaf-agent/dist/src/server.js"],
  "env": {
    "OVERLEAF_AGENT_CONFIG": "/home/shouss/projects/overleaf-agent/.local/client.json"
  }
}
```

Run `npm run build` first. This command runs on m701; use a remote agent environment or an SSH stdio wrapper that keeps login banners off stdout. The server is not an unauthenticated HTTP service.

Current tools: `overleaf_status`, `overleaf_list_projects`, `overleaf_compile`. Project access requires both the configured allowlist and Overleaf's account permission. Empty allowlists expose no projects. Session failure is reported rather than replaying a mutation.

## Checks and lifecycle

```sh
npm run typecheck
npm test
npm run build
npm run smoke
# Stop this lab without removing its data:
docker compose stop
```

Do not use `down -v` for normal shutdown. Credentials and database volumes are not Git artifacts. The initial repository is private/unpublished; an open-source license has not yet been selected. No third-party MCP implementation has been copied into it.
