# GitHub account linking

This release adds **Account Settings → GitHub account** to existing Overleaf accounts. A signed-in user authorizes GitHub, reviews the returned username, and confirms the connection. Email/password login, account IDs, projects, invitations and personal MCP access remain unchanged. Self-registration stays closed.

This is identity linking. GitHub login and repository synchronization are separate future features. The current database stores a GitHub numeric user ID, its display username and verification timestamps. It does not match accounts by email or retain GitHub access/refresh tokens.

## Register the GitHub App

Create an organization-owned App at [ZJUSCT → Settings → Developer settings → GitHub Apps](https://github.com/organizations/ZJUSCT/settings/apps). Suggested name: `OverLeaf ZJUSCT` (GitHub requires a globally unique name).

| Setting | Value |
| --- | --- |
| Homepage URL | `https://latex.clusters.zjusct.io` |
| Callback URL | `https://latex.clusters.zjusct.io/user/github/callback` |
| Expire user authorization tokens | Enabled |
| Request user authorization during installation | Leave disabled; account settings starts authorization |
| Enable Device Flow | Disabled |
| Setup URL | Leave empty |
| Webhook → Active | Disabled for this phase |
| Repository, organization and account permissions | No additional permissions; leave defaults |
| Where can this GitHub App be installed? | **Any account** |

“Any account” allows existing Overleaf users outside ZJUSCT's GitHub organization to authorize the App and supports later personal-repository installations. No Marketplace listing or repository installation is required for identity linking. See [GitHub's App visibility rules](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private).

After creating the App, record its **Client ID** and generate a **Client secret**. The numeric App ID and a private signing key are not needed for this phase. Put the values in a private environment file or Kubernetes Secret, not in chat or Git:

```dotenv
GITHUB_APP_CLIENT_ID=<client ID>
GITHUB_APP_CLIENT_SECRET=<client secret>
```

For the Compose lab, the root `.env` supplies these optional variables. Use a separate development App with callback `http://localhost:18083/user/github/callback` for the m701 port-18083 preview. A browser on the developer's computer reaches that callback through its SSH tunnel. Production credentials belong only in production secrets.

The callback is derived from `OVERLEAF_SITE_URL`; non-loopback deployments require HTTPS. On an alternate hostname, the settings page directs users to the primary site before starting authorization. They may need to sign in there. Missing credentials leave the connection button disabled, with an explanatory message.

## Enable on Kubernetes after preview verification

1. Build and pin the tested image digest. Keep the current image digest for rollback.
2. Put both environment variables in the private GitOps/deployment secret mechanism and reference them from the Overleaf container. Do not copy the public repository's examples into a committed plaintext Secret.
3. Allow this application's outbound HTTPS to `github.com` and `api.github.com`. The current production NetworkPolicy allows MongoDB, Redis, DNS and SMTP only. Kubernetes NetworkPolicy has no portable FQDN rule; use the cluster's supported domain-aware policy or an explicitly reviewed TCP-443 egress rule/proxy.
4. Add a dedicated public callback route for `/user/github/callback` (including its trailing-slash form) to the same Overleaf backend. Before enabling the App, apply the same credential-path telemetry protections as the existing personal MCP route: no query strings in gateway access logs, no callback trace sampling, and redacted URL/path trace tags. Keep these policies in the private Argo repository. The current MCP-only tracing rule does not cover this new callback.
5. The image's nginx callback location removes query parameters before forwarding to Web. The module removes its internal credential headers before native application logging. Keep Web port 4000 private; expose only nginx port 80. In a preview and then at the public gateway, use synthetic callback markers to verify that code/state do not appear in nginx, Web, Loki or Tempo.
6. Exercise one real authorization with an existing test account: cancel, connect, confirm the displayed GitHub username, reload, disconnect, then confirm normal email login and project access. Also check duplicate binding with a second test account. Do not use existing student identities as fixtures.

No live configuration or credentials were installed while preparing this feature. Real GitHub authorization remains a deployment acceptance check after the App exists.

## Storage and lifecycle

- `github_account_links`: one document per Overleaf user (`_id` as the user ID string), a revision counter, and optional `githubUserId`, `githubLogin`, `linkedAt`, `verifiedAt`. A unique partial index on `githubUserId` prevents binding one GitHub identity to two users. Revisions prevent older confirmations from restoring an association after disconnect.
- `github_link_flows`: one attempt per user/browser session, with a 10-minute TTL and explicit expiry checks. State is stored as a hash. A PKCE verifier exists only until the callback consumes the attempt; the confirmed identity then requires a fresh single-use confirmation ID. A new attempt replaces the old one in that session.
- Both collections are covered by a full MongoDB backup. Existing `users`, project membership, passwords and MCP grants are not rewritten. No account data migration is needed.
- Callback authorization uses state and PKCE S256. The server retrieves `/user`, attempts to revoke the issued access token, and discards access and refresh tokens. Cleanup failure logs only a fixed outcome. Local Disconnect deletes the binding; users can separately revoke the App authorization under [GitHub Settings → Applications](https://github.com/settings/apps/authorizations).
- Removing both environment variables disables new authorization. Existing associations remain available to view/disconnect. Rolling back the image leaves these collections dormant and preserves email login.
- For account deletion, remove that user's records from these two collections as part of the administrator's deletion procedure; this initial release does not add automatic account-deletion hooks.

## Verification and next phase

Protocol tests run with `node --test test/github-link.test.mjs`. The Mongo-backed cases require `GITHUB_LINK_TEST_MONGO_URL` against an **isolated** Mongo instance and the pinned Overleaf workspace's `mongodb` driver. They create randomly named `github_link_check_*` databases and drop them after each case. No configured production database name is used. Native HTTP checks cover email login, login protection, CSRF, disabled configuration, callback redaction, and preservation of closed registration.

The future repository integration should keep App installations and project/repository mappings separate from identity associations. Request repository permissions only when implementing sync, let users select repositories, verify both Overleaf and GitHub access for each operation, and handle conflicts explicitly. See [API research and primary sources](github-account-linking-research.md).
