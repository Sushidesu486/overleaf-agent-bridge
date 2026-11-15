# GitHub account linking and later repository integration

Researched on 2026-11-14 against GitHub's official documentation. This is a design recommendation; no GitHub App was registered and no production configuration was changed by this research.

## Recommended first release

Use a GitHub App's OAuth web flow to attach a GitHub identity to an **already authenticated Overleaf user**. Preserve the current 47 accounts and their IDs, email addresses, passwords, projects, and MCP ownership. This phase adds account linking only: no email-based account merging, account creation, GitHub login replacement, organization-membership requirement, or repository synchronization.

GitHub explicitly supports using a GitHub App as an identity provider. GitHub App authorization and installation are independent: users can authorize their identity without installing the app on a personal account or organization. Repository installation and access can be introduced later. [GitHub App overview](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps), [Authorization versus installation](https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps#difference-between-authorization-and-installation).

Recommended UI: **Connect GitHub**, then **Connected as @username**, with a local **Disconnect** action. Explain that repository sync will require a separate setup step. Keep UI text in English.

## Current protocol facts

GitHub Apps and OAuth Apps currently both support PKCE with `S256`; advice claiming that GitHub does not support PKCE is outdated. Both still require the client secret in the server-side authorization-code exchange. OAuth Apps use scopes; GitHub Apps use permissions configured on the app registration. [GitHub App flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app), [OAuth App flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

| Step | GitHub endpoint and inputs |
| --- | --- |
| Authorize | `GET https://github.com/login/oauth/authorize`: `client_id`, configured `redirect_uri`, random `state`, `code_challenge`, `code_challenge_method=S256`; optionally `prompt=select_account`. |
| Callback | GitHub returns `code` and the supplied `state`. Abort on a state mismatch. |
| Exchange | `POST https://github.com/login/oauth/access_token`: `client_id`, `client_secret`, `code`, the same `redirect_uri`, and original `code_verifier`. |

Use the **client ID**, not the app ID. The callback must match a configured callback URL without additional parameters. GitHub App scopes do not grant resource permissions; the supported `offline_access` value only requests expiring tokens. [GitHub App flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).

Request `Accept: application/json` for the token exchange. Validate the response body, including OAuth errors, before using its token. With a new token, fetch the current account rather than relying on a username hint or a prior authorization. GitHub's OAuth documentation explicitly warns that users can choose another account during authorization. [OAuth App flow](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

Fetch `GET https://api.github.com/user` using `Authorization: Bearer <access_token>`, `Accept: application/vnd.github+json`, and a pinned supported API version. Current examples use `X-GitHub-Api-Version: 2026-03-10`. This endpoint accepts GitHub App user access tokens and **requires no additional fine-grained permissions**. Its profile includes `id`, `node_id`, `login`, and `html_url`; email is not needed for this feature. [Get authenticated user](https://docs.github.com/en/rest/users/users#get-the-authenticated-user).

## Implementation choices for Overleaf

The following are proposed application mechanisms, rather than extra GitHub API requirements:

1. Begin linking through a CSRF-protected POST from the account page. Require an active Overleaf session at both initiation and callback.
2. Store a short-lived pending authorization server-side, bound to the Overleaf user ID and the initiating session. Use cryptographically random state and a separate PKCE verifier; set a ten-minute application expiry.
3. Match the pending authorization, session, and user before exchanging the code. Consume the pending attempt atomically so concurrent or repeated callbacks cannot link twice. Logout or an account switch invalidates the attempt. Cancellation clears it.
4. Take the callback URL from trusted deployment configuration. Redirect back to a fixed clean account-page URL after handling the callback. Exclude code, state, token responses, and secrets from access/application logs; do not render raw upstream errors.
5. Persist only the GitHub identity and timestamps. Enforce unique indexes for both the GitHub user ID and the Overleaf user ID. Repeating the same binding is idempotent; conflicts require an explicit disconnect/reconnect rather than silently moving a binding.
6. Keep existing Overleaf permissions and MCP principals unchanged. A GitHub connection does not modify project ownership or membership.

Recommended record: `overleafUserId`, `githubUserId` (canonical decimal string), `githubLogin` (display cache), `linkedAt`, and `verifiedAt`. Validate a positive, safely represented numeric `id` before canonicalization. GitHub directs integrations to use durable IDs: handles, organization names, and emails can change. [GitHub identity best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app#use-the-durable-unique-id-to-store-the-user).

## Token lifetime and disposal

For this first release, the access token is only needed to fetch `/user`. **Do not persist access or refresh tokens** in MongoDB, Redis, browser storage, or the local binding record. The result is a timestamped identity binding; later repository access starts another authorization flow.

The cleanup endpoint `DELETE https://api.github.com/applications/{client_id}/token` supports GitHub App user tokens. Authenticate with HTTP Basic using client ID and client secret, and send JSON `{ "access_token": "..." }`; success is `204`. By comparison, `DELETE .../grant` removes the user's entire authorization and all associated app tokens. [OAuth authorization REST endpoints](https://docs.github.com/en/rest/apps/oauth-applications).

Recommendation: after profile retrieval, attempt single-token revocation in a bounded cleanup path and discard all token material regardless of the result. Record only a redacted cleanup outcome. Do not automatically delete the whole grant, because future repository sessions may share it. The documentation does not explicitly promise whether deleting one access token also revokes its paired refresh token; do not rely on that cascade. No refresh token is retained or used in this phase.

Configure expiring user tokens. New GitHub Apps enable expiration unless opted out; access tokens last eight hours and refresh tokens six months. Refreshing rotates both tokens and invalidates the old pair. If repository sync later persists user credentials, refresh requests use the token endpoint with `grant_type=refresh_token`; serialize refreshes and atomically replace the pair. [Token refresh and expiration](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).

Local **Disconnect** removes the Overleaf binding. Because there are no retained tokens, explain that users manage the remaining GitHub authorization in **GitHub Settings → Applications → Authorized GitHub Apps**. Do not label local deletion as GitHub authorization revocation. [Review and revoke authorization](https://docs.github.com/en/apps/using-github-apps/reviewing-and-revoking-authorization-of-github-apps).

## Path to repository hosting and sync

Keep three records separate: **user identity binding**, **GitHub App installation**, and **Overleaf project ↔ GitHub repository mapping**. Installing an app grants repository/organization access and lets the installer select repositories. A user access token can only reach resources that both the user and the app can access. [Authorization and installation](https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps).

For a later repository picker, `GET /user/installations` returns this app's installations accessible to the user. Then paginate `GET /user/installations/{installation_id}/repositories` and inspect each repository's permissions. The latter requires repository Metadata read permission. Treat installation IDs returned in browser redirects as inputs to verify, not as authorization. [Installation REST API](https://docs.github.com/en/rest/apps/installations).

Start later sync permissions with repository **Contents** read/write for Git operations. Workflows permission is needed specifically for Actions files under `.github/workflows`; exclude those operations initially. Add further permissions only for implemented features. Permission increases require installation-owner acceptance; an installation retains its previous permissions until accepted. [Choosing GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).

For user-triggered sync, prefer user access tokens: GitHub applies both app and user limits. Installation tokens represent the app and are suitable for separately authorized background automation. Store any durable tokens encrypted on the server. [Token type and storage guidance](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app).

Background jobs can mint installation tokens with `POST /app/installations/{installation_id}/access_tokens`, authenticating with the app JWT. Restrict the minted token to the intended `repository_ids` and permissions; it expires in one hour. The signing key is unnecessary for phase-one identity linking. [Installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

Application design for that later phase must also check Overleaf project permissions on every operation, preserve repository IDs across renames, handle branch protection/conflicts, and stop sync after installation or user access is revoked. Identity linking can ship independently of those workflows.

## Registration and verification handoff

Recommend an organization-owned `ZJUSCT` GitHub App for maintainability, with zero additional repository, organization, or account permissions for this release. Configure the exact production HTTPS callback and keep preview credentials separate. The app's client secret stays in deployment secrets; the client ID may be exposed. GitHub's login tutorial documents the required registration, callback, and client-secret setup. [GitHub App login tutorial](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-login-with-github-button-with-a-github-app).

Choose **public / Any account** visibility: current GitHub documentation limits authorization of a private organization-owned app to members of its owning organization. Public visibility permits existing Overleaf users outside the GitHub organization to link and supports later personal-repository installations. Marketplace publication is optional. Overleaf's own login and registration policy remains enforced by Overleaf. [App visibility](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/making-a-github-app-public-or-private).

A minimal meaningful verification set covers: successful linking and disconnect, authorization denial, invalid/expired/replayed state, wrong or logged-out session, PKCE exchange, binding conflicts, a nullable GitHub email, GitHub/API failure, and absence of persisted tokens. Verify that account and project IDs remain unchanged. A real GitHub round trip still requires configured app credentials and a registered callback; mocked transport tests do not complete that deployment check.
