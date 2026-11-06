import { fileURLToPath } from "node:url";
import mongoose from "../../app/src/infrastructure/Mongoose.mjs";
import { User } from "../../app/src/models/User.mjs";
import SessionManager from "../../app/src/Features/Authentication/SessionManager.mjs";
import ProjectGetter from "../../app/src/Features/Project/ProjectGetter.mjs";
import UserSettingsHelper from "../../app/src/Features/Project/UserSettingsHelper.mjs";
import AuthorizationManager from "../../app/src/Features/Authorization/AuthorizationManager.mjs";
import CompileManager from "../../app/src/Features/Compile/CompileManager.mjs";
import Settings from "@overleaf/settings";
import bundled from "./mcp.cjs";
const { AgentService, AgentError, handleMcp, errorResponse } = bundled;
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
  });
  if (!project) throw new AgentError("NOT_FOUND", "项目不存在", 404);
  return {
    id: projectId,
    name: project.name,
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
    });
    return {
      status: result.status,
      buildId: result.buildId,
      input: {
        mode: "live-project",
        snapshotPinned: false,
        observedAt,
        observedDocumentVersions,
        historyVersion: result.baseHistoryVersion ?? null,
      },
      validationProblems: result.validationProblems,
      outputFiles: result.outputFiles?.map((f) => ({
        path: f.path,
        type: f.type,
      })),
      editorUrl: `${publicOrigin}/project/${projectId}`,
    };
  },
};
const service = new AgentService(store, backend, publicOrigin);
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
    // nginx removes the secret path before forwarding; remove its private header before any downstream logging.
    app.use("/agent-mcp", (req, res) => {
      const credential = req.headers["x-overleaf-agent-key"];
      delete req.headers["x-overleaf-agent-key"];
      req.rawHeaders = req.rawHeaders.flatMap((value, i, headers) =>
        i % 2 === 0 && value.toLowerCase() !== "x-overleaf-agent-key"
          ? [value, headers[i + 1]]
          : [],
      );
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
