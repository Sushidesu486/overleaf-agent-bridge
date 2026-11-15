import Settings from "@overleaf/settings";
import logger from "@overleaf/logger";
import mongoose from "../../app/src/infrastructure/Mongoose.mjs";
import { RateLimiter } from "../../app/src/infrastructure/RateLimiter.mjs";
import SessionManager from "../../app/src/Features/Authentication/SessionManager.mjs";
import UserGetter from "../../app/src/Features/User/UserGetter.mjs";
import {
  createGitHubClient,
  createGitHubLinkService,
  githubConfig,
  GitHubLinkError,
} from "./github-core.mjs";
import { createGitHubStore } from "./github-store.mjs";

const config = githubConfig(process.env, Settings.siteUrl);
const callbackInputs = new WeakMap();
const limiter = new RateLimiter("github-link", { points: 20, duration: 600 });
let servicePromise;
function service() {
  return (servicePromise ??= (async () => {
    await mongoose.connectionPromise;
    const store = await createGitHubStore(mongoose.connection.db);
    const client =
      config &&
      createGitHubClient(config, {
        cleanupWarning: () =>
          logger.warn({}, "GitHub identity token cleanup did not complete"),
      });
    return createGitHubLinkService({ store, client });
  })().catch(() => {
    servicePromise = undefined;
    throw new GitHubLinkError("unavailable", 503);
  }));
}

export function githubMiddleware(app) {
  // nginx strips the callback query before forwarding. Remove the private
  // headers before native request/error logging and keep input outside req.
  app.use((req, _res, next) => {
    const input = {};
    for (const name of ["code", "state", "error"]) {
      const header = `x-overleaf-github-${name}`;
      const value = req.headers[header];
      if (typeof value === "string") input[name] = value;
      delete req.headers[header];
      req.rawHeaders = req.rawHeaders.flatMap((value, i, headers) =>
        i % 2 === 0 && value.toLowerCase() !== header
          ? [value, headers[i + 1]]
          : [],
      );
    }
    if (req.path === "/github-callback") callbackInputs.set(req, input);
    next();
  });
}

const messages = {
  session: "Your session has expired. Sign in and connect GitHub again.",
  unconfigured:
    "GitHub connection is not configured. Please contact the administrator.",
  unavailable:
    "GitHub connection is temporarily unavailable. Please try again later.",
  expired:
    "This GitHub connection attempt has expired or was already used. Please start again.",
  denied: "GitHub authorization was cancelled. Your account has not changed.",
  provider: "GitHub authorization could not be completed. Please try again.",
  changed:
    "Your connection changed during authorization. Refresh this page and try again.",
  in_use:
    "This GitHub account is already connected to another Overleaf account.",
  rate_limit: "Too many connection attempts. Please try again later.",
  origin: "Open Account Settings on the primary site to connect GitHub.",
};
const settingsPath = "/user/settings#github-account";

async function context(req) {
  const userId = SessionManager.getLoggedInUserId(req.session);
  if (
    !userId ||
    !req.sessionID ||
    !(await UserGetter.promises.getUser(userId, { _id: 1 }))
  )
    throw new GitHubLinkError("session", 401);
  return { userId: String(userId), sessionId: req.sessionID };
}
function otherOrigin(req) {
  return config && req.hostname !== new URL(config.callbackUrl).hostname;
}
function route(handler, callback = false) {
  return async (req, res) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    try {
      const ctx = await context(req);
      if (req.method === "POST" || callback) {
        try {
          await limiter.consume(ctx.userId, 1, { method: "github-link" });
        } catch (error) {
          if (error instanceof Error) throw error;
          throw new GitHubLinkError("rate_limit", 429);
        }
      }
      const result = await handler(await service(), ctx, req);
      if (callback) res.redirect(303, settingsPath);
      else res.json(result ?? { ok: true });
    } catch (error) {
      const known =
        error instanceof GitHubLinkError && Object.hasOwn(messages, error.code);
      const code = known ? error.code : "unavailable";
      if (!known) logger.error({}, "GitHub account linking failed");
      if (callback) {
        res.redirect(303, `/user/settings?github=${code}#github-account`);
      } else {
        res
          .status(known ? error.status : 503)
          .json({ error: code, message: messages[code] });
      }
    }
  };
}

export function applyGitHubRoutes(router) {
  router.get(
    "/user/github",
    route(async (svc, ctx, req) => ({
      ...(await svc.status(ctx)),
      canonicalSettingsUrl: otherOrigin(req)
        ? new URL(settingsPath, config.callbackUrl).href
        : null,
    })),
  );
  router.post(
    "/user/github/start",
    route(async (svc, ctx, req) => {
      if (otherOrigin(req)) throw new GitHubLinkError("origin");
      return { url: await svc.start(ctx) };
    }),
  );
  router.get(
    "/github-callback",
    route(async (svc, ctx, req) => {
      const input = callbackInputs.get(req);
      callbackInputs.delete(req);
      await svc.callback(ctx, input);
    }, true),
  );
  router.post(
    "/user/github/confirm",
    route((svc, ctx, req) => svc.confirm(ctx, req.body.candidateId)),
  );
  router.post(
    "/user/github/cancel",
    route((svc, ctx, req) => svc.cancel(ctx, req.body.candidateId)),
  );
  router.post(
    "/user/github/unlink",
    route((svc, ctx) => svc.unlink(ctx)),
  );
}
