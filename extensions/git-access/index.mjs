import { createServer } from "node:http";
import Settings from "@overleaf/settings";
import logger from "@overleaf/logger";
import mongoose from "../../app/src/infrastructure/Mongoose.mjs";
import { User } from "../../app/src/models/User.mjs";
import SessionManager from "../../app/src/Features/Authentication/SessionManager.mjs";
import AuthorizationManager from "../../app/src/Features/Authorization/AuthorizationManager.mjs";
import ProjectGetter from "../../app/src/Features/Project/ProjectGetter.mjs";
import DocumentUpdaterHandler from "../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs";
import HistoryManager from "../../app/src/Features/History/HistoryManager.mjs";
import { RateLimiter } from "../../app/src/infrastructure/RateLimiter.mjs";
import { createGitAccess, GitError } from "./access.mjs";
import { createGitStore } from "./store.mjs";
import { createSnapshotCache } from "./snapshots.mjs";
import { createGitApi } from "./http.mjs";

const enabled = process.env.GIT_ACCESS_ENABLED === "true";
Settings.enableGitBridge = enabled;
const secret = process.env.GIT_BRIDGE_SERVICE_SECRET ?? "";
const internalUrl =
  process.env.GIT_ACCESS_INTERNAL_URL ?? "http://overleaf:4001";
const limiter = new RateLimiter("git-token-issue", {
  points: 20,
  duration: 600,
});
let promise;
function services() {
  return (promise ??= (async () => {
    await mongoose.connectionPromise;
    const store = createGitStore(mongoose.connection.db);
    const access = createGitAccess({
      store,
      users: {
        async get(userId) {
          const user = await User.findById(userId, {
            email: 1,
            first_name: 1,
            last_name: 1,
            suspended: 1,
          })
            .lean()
            .exec();
          return user && !user.suspended
            ? {
                name:
                  [user.first_name, user.last_name].filter(Boolean).join(" ") ||
                  user.email,
                email: user.email,
              }
            : null;
        },
        async role(userId, projectId) {
          return AuthorizationManager.promises.getPrivilegeLevelForProject(
            userId,
            projectId,
            null,
            { ignoreSiteAdmin: true, ignorePublicAccess: true },
          );
        },
      },
    });
    const snapshots = createSnapshotCache({
      root: process.env.GIT_SNAPSHOT_DIR ?? "/var/lib/overleaf/git-snapshots",
      async capture(projectId) {
        await DocumentUpdaterHandler.promises.flushProjectToMongo(projectId);
        await HistoryManager.promises.flushProject(projectId);
        const project = await ProjectGetter.promises.getProject(projectId, {
          "overleaf.history.id": 1,
        });
        if (!project?.overleaf?.history?.id)
          throw new GitError(
            "history_unavailable",
            "Project history is not ready for Git export.",
            409,
          );
        return HistoryManager.promises.getLatestZipWithHistoryId(
          project.overleaf.history.id,
        );
      },
    });
    return { access, snapshots };
  })().catch((error) => {
    promise = undefined;
    throw error;
  }));
}

function route(handler) {
  return async (req, res) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    try {
      if (!enabled)
        throw new GitError("disabled", "Git access is not enabled.", 404);
      const userId = SessionManager.getLoggedInUserId(req.session);
      if (!userId)
        throw new GitError("session", "Sign in to manage Git access.", 401);
      if (req.method === "POST") {
        try {
          await limiter.consume(String(userId), 1, { method: "git-token" });
        } catch {
          throw new GitError(
            "rate_limit",
            "Too many requests. Try again later.",
            429,
          );
        }
      }
      res.json(await handler((await services()).access, String(userId), req));
    } catch (error) {
      const known = error instanceof GitError;
      if (!known) logger.error({}, "Git access request failed");
      res.status(known ? error.status : 503).json({
        error: known ? error.code : "unavailable",
        message: known
          ? error.message
          : "Git access is temporarily unavailable.",
      });
    }
  };
}

export default {
  appMiddleware() {
    // CE starts separate web and API workers; only the API worker owns this port.
    if (!enabled || !Settings.enabledServices.includes("api")) return;
    if (secret.length < 32)
      throw new Error(
        "GIT_BRIDGE_SERVICE_SECRET must contain at least 32 characters",
      );
    const server = createServer(async (req, res) => {
      try {
        await createGitApi({
          ...(await services()),
          secret,
          internalUrl,
          onError: (error) =>
            logger.warn(
              { code: error instanceof GitError ? error.code : error.name },
              "Git adapter request failed",
            ),
        })(req, res);
      } catch {
        res.writeHead(503);
        res.end();
      }
    });
    server.requestTimeout = 180_000;
    server.headersTimeout = 15_000;
    server.listen(4001, "0.0.0.0");
  },
  router: {
    apply(router) {
      const base = "/user/git/projects/:projectId";
      router.get(
        base,
        route(async (access, userId, req) => ({
          ...(await access.status(userId, req.params.projectId)),
          cloneUrl: `${Settings.siteUrl.replace(/\/$/, "")}/git/${req.params.projectId}`,
          pushEnabled: false,
        })),
      );
      router.post(
        `${base}/enabled`,
        route(async (access, userId, req) => {
          await access.enable(userId, req.params.projectId, req.body.enabled);
          return { ok: true };
        }),
      );
      router.post(
        `${base}/tokens`,
        route((access, userId, req) =>
          access.issue(userId, req.params.projectId, req.body),
        ),
      );
      router.post(
        `${base}/tokens/:id/revoke`,
        route(async (access, userId, req) => {
          await access.revoke(userId, req.params.projectId, req.params.id);
          return { ok: true };
        }),
      );
    },
  },
};
