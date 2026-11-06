import { fileURLToPath } from "node:url";
import mongoose from "../../app/src/infrastructure/Mongoose.mjs";
import { User } from "../../app/src/models/User.mjs";
import SessionManager from "../../app/src/Features/Authentication/SessionManager.mjs";
import ProjectGetter from "../../app/src/Features/Project/ProjectGetter.mjs";
import UserSettingsHelper from "../../app/src/Features/Project/UserSettingsHelper.mjs";
import AuthorizationManager from "../../app/src/Features/Authorization/AuthorizationManager.mjs";
import CompileManager from "../../app/src/Features/Compile/CompileManager.mjs";
import ClsiManager from "../../app/src/Features/Compile/ClsiManager.mjs";
import LatexParser from "./native-latex-log-parser.mjs";
import Settings from "@overleaf/settings";
import bundled from "./mcp.cjs";
const {
  CompileLogs,
  logPage,
  compileDiagnostics,
  compileNextAction,
  AgentService,
  AgentError,
  handleMcp,
  errorResponse,
  ChatService,
  handleBridge,
  startEvents,
  sendEvent,
} = bundled;
const publicOrigin = new URL(process.env.OVERLEAF_SITE_URL).origin;
async function collection(name) {
  await mongoose.connectionPromise;
  return mongoose.connection.db.collection(`agent_${name}`);
}
const store = {
  async insert(g) {
    await (await collection("grants")).insertOne({ _id: g.id, ...g });
  },
  async get(id) {
    return (await collection("grants")).findOne(
      { _id: id },
      { projection: { _id: 0 } },
    );
  },
  async list(userId) {
    return (await collection("grants"))
      .find({ userId }, { projection: { _id: 0 } })
      .sort({ revokedAt: 1, createdAt: -1 })
      .limit(100)
      .toArray();
  },
  async revoke(id, userId) {
    return (
      (
        await (
          await collection("grants")
        ).updateOne(
          { _id: id, userId },
          { $set: { revokedAt: new Date().toISOString() } },
        )
      ).matchedCount === 1
    );
  },
  async rotate(id, userId, digest) {
    return (
      (
        await (
          await collection("grants")
        ).updateOne(
          { _id: id, userId, revokedAt: null },
          { $set: { digest, lastUsedAt: null } },
        )
      ).matchedCount === 1
    );
  },
  async touch(id, digest) {
    await (
      await collection("grants")
    ).updateOne(
      { _id: id, digest, revokedAt: null },
      { $set: { lastUsedAt: new Date().toISOString() } },
    );
  },
  async begin(op) {
    try {
      await (
        await collection("operations")
      ).insertOne({ _id: op.id, ...op, createdAt: new Date() });
      return true;
    } catch (e) {
      if (e.code === 11000) return false;
      throw e;
    }
  },
  async finish(id, state, result) {
    await (
      await collection("operations")
    ).updateOne(
      { _id: id },
      { $set: { state, result, finishedAt: new Date() } },
    );
  },
};
function flatten(folder, prefix = "/") {
  const path = prefix;
  return [
    ...(folder.docs || []).map((d) => ({
      id: String(d._id),
      name: d.name,
      path: `${path}${d.name}`,
      type: "document",
    })),
    ...(folder.fileRefs || []).map((f) => ({
      id: String(f._id),
      name: f.name,
      path: `${path}${f.name}`,
      type: "file",
    })),
    ...(folder.folders || []).flatMap((f) => flatten(f, `${path}${f.name}/`)),
  ];
}
async function tree(projectId) {
  const project = await ProjectGetter.promises.getProject(projectId, {
    name: 1,
    rootFolder: 1,
    rootDoc_id: 1,
    compiler: 1,
    imageName: 1,
  });
  if (!project) throw new AgentError("NOT_FOUND", "项目不存在", 404);
  return {
    id: projectId,
    name: project.name,
    compiler: project.compiler,
    imageName: project.imageName ?? null,
    rootDocId: project.rootDoc_id ? String(project.rootDoc_id) : null,
    entries: (project.rootFolder || []).flatMap((f) => flatten(f)),
  };
}
async function checkDoc(projectId, docId) {
  if (
    !(await tree(projectId)).entries.some(
      (e) => e.id === docId && e.type === "document",
    )
  )
    throw new AgentError("NOT_FOUND", "文档不属于该项目", 404);
}
let compileBuildsPromise;
function compileBuilds() {
  return (compileBuildsPromise ??= collection("compile_builds")
    .then(async (db) => {
      await db.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      return db;
    })
    .catch((error) => {
      compileBuildsPromise = undefined;
      throw error;
    }));
}
const compileLogs = new CompileLogs(
  async (projectId, userId, buildId) =>
    (await compileBuilds()).findOne({
      _id: `${projectId}:${userId}:${buildId}`,
      projectId,
      userId,
      buildId,
    }),
  (build, file) =>
    ClsiManager.promises.getOutputFileStream(
      build.projectId,
      build.compileAsUser,
      // CE stores an absent CLSI shard as null; the native downloader expects undefined.
      build.clsiServerId ?? undefined,
      build.buildId,
      file,
    ),
);
const backend = {
  async user(id) {
    const u = await User.findById(id, {
      email: 1,
      first_name: 1,
      last_name: 1,
      suspended: 1,
    })
      .lean()
      .exec();
    return !u || u.suspended
      ? null
      : {
          id: String(u._id),
          email: u.email,
          name:
            [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email,
        };
  },
  async projects(userId) {
    const groups = await ProjectGetter.promises.findAllUsersProjects(userId, {
      name: 1,
    });
    return Object.values(groups)
      .flat()
      .map((p) => ({ id: String(p._id), name: p.name }));
  },
  async privilege(userId, projectId) {
    return AuthorizationManager.promises.getPrivilegeLevelForProject(
      userId,
      projectId,
      null,
      { ignoreSiteAdmin: true, ignorePublicAccess: true },
    );
  },
  tree,
  async read(projectId, docId) {
    await checkDoc(projectId, docId);
    const response = await fetch(
      `${Settings.apis.documentupdater.url}/project/${projectId}/doc/${docId}`,
      { signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok)
      throw new AgentError("UPSTREAM_ERROR", "读取文档失败", 502);
    if (response.headers.get("x-overleaf-agent-cas") !== "1")
      throw new AgentError(
        "UNSUPPORTED_SERVER",
        "文档服务缺少版本检查扩展",
        503,
      );
    const doc = await response.json();
    if (
      !Array.isArray(doc.lines) ||
      !Number.isInteger(doc.version) ||
      !["sharejs-text-ot", "history-ot"].includes(doc.type)
    )
      throw new AgentError("UNSUPPORTED_DOCUMENT", "文档格式不受支持");
    const content = doc.lines.join("\n");
    if (Buffer.byteLength(content) > 2_000_000)
      throw new AgentError("DOCUMENT_TOO_LARGE", "文档超出 2 MB 限制");
    return { content, version: doc.version, otType: doc.type };
  },
  async edit(projectId, docId, userId, expectedVersion, content, authorize) {
    const current = await backend.read(projectId, docId);
    // Upstream ShareJS sanitizes every surrogate code unit, including valid emoji pairs.
    // Refuse before submitting so a successful tool call never silently corrupts text.
    if (current.otType === "sharejs-text-ot" && /[\uD800-\uDFFF]/.test(content))
      throw new AgentError(
        "UNSUPPORTED_TEXT",
        "该项目使用 ShareJS，暂不支持写入 emoji 等非 BMP 字符；中文可正常编辑",
      );
    if (/[\uD800-\uDFFF]/u.test(content))
      throw new AgentError("INVALID_TEXT", "文本包含不完整的 Unicode 字符");
    await authorize();
    const response = await fetch(
      `${Settings.apis.documentupdater.url}/project/${projectId}/doc/${docId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lines: content.split("\n"),
          source: "agent",
          user_id: userId,
          expectedVersion,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (response.status === 409)
      throw new AgentError(
        "VERSION_CONFLICT",
        "文档已变化，请重新读取后生成修改",
        409,
      );
    if (!response.ok)
      throw new AgentError(
        "RESULT_UNKNOWN",
        "写入未确认，请重新读取文档后检查",
        502,
      );
  },
  async compileLog(projectId, userId, { buildId, file, offset, limit }) {
    const log = await compileLogs.read(projectId, userId, buildId, file);
    return logPage(buildId, file, log, offset, limit);
  },
  async compile(projectId, userId, authorize) {
    const project = await tree(projectId);
    const observedAt = new Date().toISOString();
    const observedDocumentVersions = [];
    if (project.rootDocId) {
      const root = await backend.read(projectId, project.rootDocId);
      observedDocumentVersions.push({
        docId: project.rootDocId,
        version: root.version,
      });
    }
    await authorize();
    const result = await CompileManager.promises.compile(projectId, userId, {
      draft: false,
      stopOnFirstError: false,
      incrementalCompilesEnabled: false,
      fileLineErrors: true,
    });
    await authorize();
    let status = result.status || result.message || "unknown";
    const outputFiles = (result.outputFiles || []).map(({ path, type }) => ({
      path,
      type,
    }));
    const availableLogs = outputFiles
      .filter((file) => /\.(log|blg)$/.test(file.path))
      .map((file) => file.path);
    let log = {
      available: false,
      reason: "NO_LOG_OUTPUT",
      files: availableLogs,
    };
    let diagnostics = null;
    if (result.buildId) {
      try {
        await (
          await compileBuilds()
        ).insertOne({
          _id: `${projectId}:${userId}:${result.buildId}`,
          projectId,
          userId,
          buildId: result.buildId,
          compileAsUser: Settings.disablePerUserCompiles ? undefined : userId,
          clsiServerId: result.clsiServerId,
          outputFiles,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
        const file = availableLogs.includes("output.log")
          ? "output.log"
          : availableLogs[0];
        if (file) {
          const source = await compileLogs.read(
            projectId,
            userId,
            result.buildId,
            file,
          );
          log = {
            available: true,
            file,
            files: availableLogs,
            totalCharacters: source.text.length,
            sourceTruncated: source.truncated,
          };
          diagnostics = compileDiagnostics(
            source.text,
            (text) => new LatexParser(text).parse(),
            project.entries,
          );
        }
      } catch (error) {
        log = {
          available: false,
          reason: error instanceof AgentError ? error.code : "LOG_UNAVAILABLE",
          message:
            error instanceof AgentError
              ? error.message
              : "编译已完成，但暂时无法获取日志；可重新编译后再试",
          files: availableLogs,
        };
      }
    }
    await authorize();
    const nativeStatus = status;
    if (status === "success" && diagnostics?.errorCount) status = "failure";
    const nextAction = compileNextAction(status, diagnostics, log);
    return {
      projectId,
      status,
      nativeStatus,
      buildId: result.buildId,
      compiler: project.compiler,
      rootDocId: project.rootDocId,
      imageName: project.imageName,
      diagnostics,
      log,
      nextAction,
      input: {
        mode: "live-project",
        snapshotPinned: false,
        observedAt,
        observedDocumentVersions,
        historyVersion: result.baseHistoryVersion ?? null,
      },
      validationProblems: result.validationProblems,
      outputFiles,
      editorUrl: `${publicOrigin}/project/${projectId}`,
    };
  },
};
const service = new AgentService(store, backend, publicOrigin);
const chatCollection = (kind) => collection(`chat_${kind}`);
const chatStore = {
  async get(kind, id) {
    return (await chatCollection(kind)).findOne(
      { id },
      { projection: { _id: 0 } },
    );
  },
  async insert(kind, value) {
    await (await chatCollection(kind)).insertOne({ _id: value.id, ...value });
  },
  async consumePairing(id, digest, now) {
    return (await chatCollection("pairings")).findOneAndUpdate(
      { id, digest, expiresAt: { $gt: now }, consumed: { $ne: true } },
      { $set: { consumed: true } },
      {
        returnDocument: "before",
        includeResultMetadata: false,
        projection: { _id: 0, consumed: 0 },
      },
    );
  },
  async connections(userId) {
    return (await chatCollection("connections"))
      .find({ userId }, { projection: { _id: 0 } })
      .limit(100)
      .toArray();
  },
  async sessions(userId, projectId, query = {}) {
    const filter = {
      userId,
      projectId,
      archivedAt: { $exists: Boolean(query.archived) },
      messages: { $elemMatch: { role: "user" } },
    };
    if (query.connectionId) filter.connectionId = query.connectionId;
    if (query.search)
      filter.title = {
        $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      };
    if (query.before)
      filter.$or = [
        { updatedAt: { $lt: query.before } },
        { updatedAt: query.before, id: { $lt: query.beforeId } },
      ];
    return (await chatCollection("sessions"))
      .find(filter, { projection: { _id: 0, messages: 0 } })
      .sort({ updatedAt: -1, id: -1 })
      .limit(30)
      .toArray();
  },
  async saveSession(value, revision) {
    return (
      (
        await (
          await chatCollection("sessions")
        ).replaceOne({ id: value.id, revision }, value)
      ).matchedCount === 1
    );
  },
  async revokeConnection(id) {
    await (
      await chatCollection("connections")
    ).updateOne({ id }, { $set: { revoked: true } });
  },
  async interruptedSessions(connectionId) {
    return (await chatCollection("sessions"))
      .find(
        {
          connectionId,
          $or: [{ runId: { $ne: null } }, { agentState: "preparing" }],
        },
        { projection: { _id: 0 } },
      )
      .toArray();
  },
};
const chat = new ChatService(chatStore, service);
function takeCredential(req, header) {
  const credential = req.headers[header];
  delete req.headers[header];
  req.rawHeaders = req.rawHeaders.flatMap((value, i, headers) =>
    i % 2 === 0 && value.toLowerCase() !== header
      ? [value, headers[i + 1]]
      : [],
  );
  return typeof credential === "string" ? credential : "";
}

function securePage(res) {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
  res.set("X-Content-Type-Options", "nosniff");
  res.set(
    "Content-Security-Policy",
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
}
function loggedIn(req, res, next) {
  if (!SessionManager.isUserLoggedIn(req.session))
    return req.method === "GET" &&
      req.originalUrl.split("?")[0] === "/user/agent"
      ? res.redirect(`/login?redir=${encodeURIComponent(req.originalUrl)}`)
      : res.sendStatus(401);
  securePage(res);
  next();
}
function route(fn) {
  return async (req, res) => {
    try {
      res.json(
        await fn(String(SessionManager.getLoggedInUserId(req.session)), req),
      );
    } catch (e) {
      res
        .status(
          e instanceof AgentError
            ? e.status
            : e.name === "ZodError"
              ? 400
              : 500,
        )
        .json(errorResponse(e));
    }
  };
}
export default {
  appMiddleware(app) {
    app.use("/agent-bridge", (req, res) => {
      const credential = takeCredential(req, "x-overleaf-agent-bridge-key");
      void handleBridge(req, res, chat, credential);
    });
    // nginx removes the secret path before forwarding; remove its private header before any downstream logging.
    app.use("/agent-mcp", (req, res) => {
      const credential = takeCredential(req, "x-overleaf-agent-key");
      void handleMcp(
        req,
        res,
        service,
        typeof credential === "string" ? credential : "",
      );
    });
  },
  router: {
    apply(webRouter) {
      webRouter.use("/user/agent", loggedIn);
      webRouter.get("/user/agent/connector", (_req, res) => {
        res.download(
          fileURLToPath(
            new URL("./public/overleaf-agent-connector.mjs", import.meta.url),
          ),
          "overleaf-agent-connector.mjs",
        );
      });
      webRouter.post(
        "/user/agent/chat/pairings",
        route((userId, req) => chat.createPairing(userId, req.body)),
      );
      webRouter.get(
        "/user/agent/chat/connections",
        route((userId, req) =>
          chat.connections(
            userId,
            req.query.projectId,
            req.query.includeOthers === "1",
          ),
        ),
      );
      webRouter.post(
        "/user/agent/chat/connections/:id/revoke",
        route((userId, req) => chat.revoke(userId, req.params.id)),
      );
      webRouter.get(
        "/user/agent/chat/sessions",
        route((userId, req) =>
          chat.sessions(userId, req.query.projectId, req.query),
        ),
      );
      webRouter.post(
        "/user/agent/chat/sessions",
        route((userId, req) => chat.createSession(userId, req.body)),
      );
      webRouter.get(
        "/user/agent/chat/sessions/:id",
        route((userId, req) => chat.session(userId, req.params.id)),
      );
      webRouter.post(
        "/user/agent/chat/sessions/:id/settings",
        route((userId, req) =>
          chat.updateSession(userId, req.params.id, req.body),
        ),
      );
      webRouter.post(
        "/user/agent/chat/sessions/:id/messages",
        route((userId, req) => chat.prompt(userId, req.params.id, req.body)),
      );
      webRouter.post(
        "/user/agent/chat/sessions/:id/cancel",
        route((userId, req) => chat.cancel(userId, req.params.id)),
      );
      webRouter.post(
        "/user/agent/chat/sessions/:id/permission",
        route((userId, req) =>
          chat.permission(userId, req.params.id, req.body),
        ),
      );
      webRouter.get(
        "/user/agent/chat/sessions/:id/events",
        async (req, res) => {
          const userId = String(SessionManager.getLoggedInUserId(req.session));
          let unsubscribe;
          let heartbeat;
          try {
            await chat.session(userId, req.params.id);
            startEvents(res);
            unsubscribe = chat.subscribe(req.params.id, (session) =>
              sendEvent(res, "session", session),
            );
            sendEvent(
              res,
              "session",
              await chat.session(userId, req.params.id),
            );
            let checking = false;
            heartbeat = setInterval(async () => {
              if (checking) return;
              checking = true;
              try {
                await chat.session(userId, req.params.id);
                sendEvent(res, "heartbeat", {});
              } catch {
                res.end();
              } finally {
                checking = false;
              }
            }, 10_000);
            res.on("close", () => {
              unsubscribe?.();
              clearInterval(heartbeat);
            });
          } catch (error) {
            unsubscribe?.();
            clearInterval(heartbeat);
            if (!res.headersSent)
              res
                .status(error instanceof AgentError ? error.status : 500)
                .json(errorResponse(error));
            else res.end();
          }
        },
      );
      webRouter.get("/user/agent", async (req, res, next) => {
        try {
          const user = await User.findById(
            SessionManager.getLoggedInUserId(req.session),
            { ace: 1, signUpDate: 1 },
          )
            .lean()
            .exec();
          if (!user) return res.sendStatus(401);
          const userSettings = await UserSettingsHelper.buildUserSettings(
            req,
            res,
            user,
          );
          res.render(
            fileURLToPath(new URL("./app/views/index.pug", import.meta.url)),
            {
              title: "我的 Agent",
              userSettings,
              initialTheme: UserSettingsHelper.getInitialTheme(
                userSettings.overallTheme,
              ),
            },
          );
        } catch (error) {
          next(error);
        }
      });
      webRouter.get(
        "/user/agent/state",
        route((userId) => service.state(userId)),
      );
      webRouter.post(
        "/user/agent/links",
        route((userId, req) => service.issue(userId, req.body)),
      );
      webRouter.post(
        "/user/agent/links/:id/revoke",
        route((userId, req) => service.revoke(userId, req.params.id)),
      );
      webRouter.post(
        "/user/agent/links/:id/rotate",
        route((userId, req) => service.rotate(userId, req.params.id)),
      );
    },
  },
};
