import { createHash, randomBytes } from "node:crypto";

const ttl = 10 * 60_000;
const random = () => randomBytes(32).toString("base64url");
export const hash = (value) =>
  createHash("sha256").update(value).digest("base64url");

export class GitHubLinkError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function githubConfig(env, siteUrl) {
  if (!env.GITHUB_APP_CLIENT_ID || !env.GITHUB_APP_CLIENT_SECRET) return null;
  const url = new URL(siteUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("Invalid GitHub callback origin");
  return {
    clientId: env.GITHUB_APP_CLIENT_ID,
    clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    callbackUrl: new URL("/user/github/callback", url).href,
  };
}

// The identity token never leaves this client and is never persisted.
export function createGitHubClient(
  config,
  { fetchImpl = fetch, cleanupWarning = () => {} } = {},
) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "Overleaf-ZJUSCT-GitHub-Link",
  };
  async function request(url, options) {
    try {
      return await fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch {
      throw new GitHubLinkError("provider", 502);
    }
  }
  return {
    authorize(state, verifier) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: config.callbackUrl,
        state,
        code_challenge: hash(verifier),
        code_challenge_method: "S256",
        prompt: "select_account",
      }).toString();
      return url.href;
    },
    async identity(code, verifier) {
      let token;
      try {
        const response = await request(
          "https://github.com/login/oauth/access_token",
          {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              client_id: config.clientId,
              client_secret: config.clientSecret,
              redirect_uri: config.callbackUrl,
              code,
              code_verifier: verifier,
            }),
          },
        );
        const data = await response.json();
        if (
          !response.ok ||
          data.error ||
          typeof data.access_token !== "string" ||
          !data.access_token
        )
          throw new GitHubLinkError("provider", 502);
        token = data.access_token;
        const profileResponse = await request("https://api.github.com/user", {
          headers: { ...headers, Authorization: `Bearer ${token}` },
        });
        const profile = await profileResponse.json();
        if (
          !profileResponse.ok ||
          profile.type !== "User" ||
          !Number.isSafeInteger(profile.id) ||
          profile.id <= 0 ||
          typeof profile.login !== "string" ||
          !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(profile.login)
        )
          throw new GitHubLinkError("provider", 502);
        return { githubUserId: String(profile.id), githubLogin: profile.login };
      } catch {
        // Provider errors can contain codes/tokens. Only return a fixed error.
        throw new GitHubLinkError("provider", 502);
      } finally {
        if (token) {
          try {
            const response = await request(
              `https://api.github.com/applications/${encodeURIComponent(config.clientId)}/token`,
              {
                method: "DELETE",
                headers: {
                  ...headers,
                  "Content-Type": "application/json",
                  Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
                },
                body: JSON.stringify({ access_token: token }),
              },
            );
            if (response.status !== 204 && response.status !== 404)
              cleanupWarning();
          } catch {
            cleanupWarning();
          }
        }
      }
    },
  };
}

export function createGitHubLinkService({
  store,
  client,
  now = () => new Date(),
}) {
  const key = ({ userId, sessionId }) => hash(`${userId}:${sessionId}`);
  const requireClient = () => {
    if (!client) throw new GitHubLinkError("unconfigured", 503);
  };
  const publicLink = (link) =>
    link?.githubUserId
      ? {
          login: link.githubLogin,
          linkedAt: link.linkedAt,
        }
      : null;
  return {
    async status(context) {
      const [account, flow] = await Promise.all([
        store.getAccount(context.userId),
        store.getFlow(key(context), now()),
      ]);
      return {
        configured: Boolean(client),
        link: publicLink(account),
        pending:
          flow?.stage === "confirm"
            ? {
                id: flow.candidateId,
                login: flow.githubLogin,
                expiresAt: flow.expiresAt,
              }
            : null,
      };
    },
    async start(context) {
      requireClient();
      const account = await store.ensureAccount(context.userId);
      const state = random();
      const verifier = random();
      await store.putFlow({
        _id: key(context),
        userId: context.userId,
        revision: account.revision,
        stateHash: hash(state),
        verifier,
        stage: "authorize",
        expiresAt: new Date(now().getTime() + ttl),
      });
      return client.authorize(state, verifier);
    },
    async callback(context, { state, code, error } = {}) {
      requireClient();
      if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state))
        throw new GitHubLinkError("expired");
      const flow = await store.consumeFlow(key(context), hash(state), now());
      if (!flow) throw new GitHubLinkError("expired");
      if (error)
        throw new GitHubLinkError(
          error === "access_denied" ? "denied" : "provider",
        );
      if (typeof code !== "string" || !/^[A-Za-z0-9_-]{1,512}$/.test(code))
        throw new GitHubLinkError("provider");
      const identity = await client.identity(code, flow.verifier);
      const saved = await store.saveCandidate(
        flow,
        {
          ...identity,
          candidateId: random(),
          verifiedAt: now(),
        },
        now(),
      );
      if (!saved) throw new GitHubLinkError("expired");
    },
    async confirm(context, candidateId) {
      if (typeof candidateId !== "string") throw new GitHubLinkError("expired");
      const candidate = await store.takeCandidate(
        key(context),
        candidateId,
        now(),
      );
      if (!candidate) throw new GitHubLinkError("expired");
      try {
        const linked = await store.link(context.userId, candidate, now());
        if (!linked) throw new GitHubLinkError("changed", 409);
      } catch (error) {
        if (error.code === 11000) throw new GitHubLinkError("in_use", 409);
        throw error;
      }
    },
    async cancel(context, candidateId) {
      if (typeof candidateId === "string")
        await store.cancelCandidate(key(context), candidateId);
    },
    async unlink(context) {
      // Increment before clearing pending flows so an already-consumed confirmation
      // cannot restore a link after the user disconnects it.
      await store.ensureAccount(context.userId);
      await store.unlink(context.userId);
      await store.deleteUserFlows(context.userId);
    },
  };
}
