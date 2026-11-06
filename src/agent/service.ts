import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export class AgentError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const objectId = z.string().regex(/^[a-f0-9]{24}$/);
export const compileLogInput = z
  .object({
    projectId: objectId,
    buildId: z
      .string()
      .regex(/^[a-f0-9]+-[a-f0-9]+$/)
      .max(80),
    file: z.string().max(240).default("output.log"),
    offset: z.number().int().min(0).max(2_000_000).default(0),
    limit: z.number().int().min(1).max(32_000).default(12_000),
  })
  .strict();
export const action = z.enum(["read", "edit", "compile"]);
export const grantInput = z
  .object({
    name: z.string().trim().min(1).max(60).default("我的 Agent"),
    projects: z.array(objectId).max(200).nullable().default(null),
    actions: z.array(action).min(1).default(["read", "edit", "compile"]),
  })
  .strict();
export type Grant = z.infer<typeof grantInput> & {
  id: string;
  userId: string;
  digest: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};
export type Identity = { id: string; name: string; email: string };
export type Project = { id: string; name: string };
export type Doc = { content: string; version: number };
export type Operation = {
  id: string;
  grantId: string;
  userId: string;
  projectId: string;
  docId: string;
  beforeVersion: number;
  state: string;
  result?: unknown;
};
export interface Store {
  insert(grant: Grant): Promise<void>;
  get(id: string): Promise<Grant | null>;
  list(userId: string): Promise<Grant[]>;
  revoke(id: string, userId: string): Promise<boolean>;
  rotate(id: string, userId: string, digest: string): Promise<boolean>;
  touch(id: string, digest: string): Promise<void>;
  begin(operation: Operation): Promise<boolean>;
  finish(id: string, state: string, result: unknown): Promise<void>;
}
export interface Backend {
  user(id: string): Promise<Identity | null>;
  projects(userId: string): Promise<Project[]>;
  privilege(userId: string, projectId: string): Promise<string | false>;
  tree(projectId: string): Promise<unknown>;
  read(projectId: string, docId: string): Promise<Doc>;
  edit(
    projectId: string,
    docId: string,
    userId: string,
    version: number,
    content: string,
    authorize: () => Promise<void>,
  ): Promise<void>;
  compileLog(
    projectId: string,
    userId: string,
    args: z.infer<typeof compileLogInput>,
  ): Promise<unknown>;
  compile(
    projectId: string,
    userId: string,
    authorize: () => Promise<void>,
  ): Promise<unknown>;
}
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function publicGrant(g: Grant) {
  const { digest: _digest, userId: _userId, ...result } = g;
  return result;
}
export class AgentService {
  readonly publicOrigin: string;
  constructor(
    readonly store: Store,
    readonly backend: Backend,
    origin: string,
  ) {
    const url = new URL(origin);
    if (
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw new Error(
        "Agent origin must be HTTPS, or loopback HTTP for the lab",
      );
    this.publicOrigin = url.origin;
  }
  private url(id: string, secret: string) {
    return `${this.publicOrigin}/mcp/p/${id}.${secret}`;
  }
  async issue(userId: string, input: unknown) {
    if (!(await this.backend.user(userId)))
      throw new AgentError("ACCESS_DENIED", "账号不可用", 403);
    const data = grantInput.parse(input);
    if (!data.actions.includes("read")) data.actions.unshift("read");
    const existing = await this.store.list(userId);
    if (existing.filter((g) => !g.revokedAt).length >= 20)
      throw new AgentError("LINK_LIMIT", "最多保留 20 条有效链接");
    if (data.projects !== null) {
      if (!data.projects.length)
        throw new AgentError("EMPTY_PROJECTS", "请至少选择一个项目");
      for (const id of data.projects)
        await this.checkPrivilege(userId, id, "read");
    }
    const secret = randomBytes(32).toString("base64url");
    const grant: Grant = {
      ...data,
      id: randomBytes(12).toString("hex"),
      userId,
      digest: digest(secret),
      createdAt: new Date().toISOString(),
      revokedAt: null,
      lastUsedAt: null,
    };
    await this.store.insert(grant);
    return { grant: publicGrant(grant), url: this.url(grant.id, secret) };
  }
  async rotate(userId: string, id: string) {
    objectId.parse(id);
    const secret = randomBytes(32).toString("base64url");
    if (!(await this.store.rotate(id, userId, digest(secret))))
      throw new AgentError("NOT_FOUND", "有效链接不存在", 404);
    return { url: this.url(id, secret) };
  }
  async revoke(userId: string, id: string) {
    objectId.parse(id);
    if (!(await this.store.revoke(id, userId)))
      throw new AgentError("NOT_FOUND", "链接不存在", 404);
    return { revoked: true };
  }
  async authenticate(credential: string) {
    const match = /^([a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/.exec(credential);
    if (!match)
      throw new AgentError("INVALID_LINK", "MCP 链接无效或已停用", 401);
    const grant = await this.store.get(match[1]);
    if (
      !grant ||
      grant.revokedAt ||
      !timingSafeEqual(
        Buffer.from(grant.digest, "hex"),
        Buffer.from(digest(match[2]), "hex"),
      )
    )
      throw new AgentError("INVALID_LINK", "MCP 链接无效或已停用", 401);
    const user = await this.backend.user(grant.userId);
    if (!user) throw new AgentError("ACCESS_DENIED", "账号不可用", 403);
    await this.store.touch(grant.id, grant.digest);
    return { grant, user };
  }
  async state(userId: string) {
    const user = await this.backend.user(userId);
    if (!user) throw new AgentError("ACCESS_DENIED", "账号不可用", 403);
    return {
      user,
      grants: (await this.store.list(userId)).map(publicGrant),
      projects: await this.backend.projects(userId),
    };
  }
  private async checkPrivilege(
    userId: string,
    projectId: string,
    required: string,
  ) {
    const level = await this.backend.privilege(userId, projectId);
    if (
      !level ||
      (required === "edit" && level !== "owner" && level !== "readAndWrite")
    )
      throw new AgentError("ACCESS_DENIED", "当前账号没有对应项目权限", 403);
  }
  async execute(credential: string, name: string, input: unknown) {
    const { grant, user } = await this.authenticate(credential);
    if (name === "overleaf_whoami")
      return {
        user,
        connectionLabel: `${user.name} 的 Agent`,
        grant: publicGrant(grant),
        capabilities: { editing: true, presenceLabel: false },
      };
    if (name === "overleaf_list_projects") {
      const projects = await this.backend.projects(user.id);
      return projects.filter(
        (p) => grant.projects === null || grant.projects.includes(p.id),
      );
    }
    const { projectId } = z.object({ projectId: objectId }).parse(input);
    const required =
      name === "overleaf_edit_document"
        ? "edit"
        : name === "overleaf_compile"
          ? "compile"
          : "read";
    if (
      !grant.actions.includes(required) ||
      (grant.projects !== null && !grant.projects.includes(projectId))
    )
      throw new AgentError("OUTSIDE_GRANT", "操作超出此链接的授权范围", 403);
    await this.checkPrivilege(user.id, projectId, required);
    if (name === "overleaf_get_project_tree")
      return this.backend.tree(projectId);
    if (name === "overleaf_compile")
      return this.backend.compile(projectId, user.id, async () => {
        await this.authenticate(credential);
        await this.checkPrivilege(user.id, projectId, "compile");
      });
    if (name === "overleaf_get_compile_log") {
      const args = compileLogInput.parse(input);
      const result = await this.backend.compileLog(projectId, user.id, args);
      await this.authenticate(credential);
      await this.checkPrivilege(user.id, projectId, "read");
      return result;
    }
    const { docId } = z.object({ docId: objectId }).parse(input);
    const doc = await this.backend.read(projectId, docId);
    if (name === "overleaf_read_document") return { projectId, docId, ...doc };
    if (name !== "overleaf_edit_document")
      throw new AgentError("UNKNOWN_TOOL", "Unknown tool");
    const args = editInput.parse(input);
    if (args.expectedVersion !== doc.version)
      throw new AgentError(
        "VERSION_CONFLICT",
        "文档已变化，请重新读取后生成修改",
        409,
      );
    const index = doc.content.indexOf(args.oldText);
    if (index < 0 || doc.content.indexOf(args.oldText, index + 1) !== -1)
      throw new AgentError("TEXT_CONFLICT", "旧文本需要在文档中唯一匹配", 409);
    const content =
      doc.content.slice(0, index) +
      args.newText +
      doc.content.slice(index + args.oldText.length);
    if (Buffer.byteLength(content) > 2_000_000)
      throw new AgentError("DOCUMENT_TOO_LARGE", "文档超出 2 MB 限制");
    if (args.dryRun)
      return {
        dryRun: true,
        version: doc.version,
        oldText: args.oldText,
        newText: args.newText,
      };
    // Reserve before submitting. An interrupted attempt is never replayed automatically.
    const operationId = `${grant.id}:${args.operationId}`;
    if (
      !(await this.store.begin({
        id: operationId,
        grantId: grant.id,
        userId: user.id,
        projectId,
        docId,
        beforeVersion: doc.version,
        state: "pending",
      }))
    )
      throw new AgentError(
        "OPERATION_ALREADY_SUBMITTED",
        "此操作已提交，请重新读取文档确认结果",
        409,
      );
    try {
      // The backend invokes this guard after preparation, immediately before submission.
      await this.backend.edit(
        projectId,
        docId,
        user.id,
        doc.version,
        content,
        async () => {
          await this.authenticate(credential);
          await this.checkPrivilege(user.id, projectId, "edit");
        },
      );
      const result = {
        submitted: true,
        operationId: args.operationId,
        baseVersion: doc.version,
        expectedVersion: doc.version + (content === doc.content ? 0 : 1),
      };
      await this.store.finish(operationId, "submitted", result);
      return result;
    } catch (error) {
      const code = error instanceof AgentError ? error.code : "RESULT_UNKNOWN";
      await this.store.finish(
        operationId,
        code === "RESULT_UNKNOWN" ? "unknown" : "rejected",
        { code },
      );
      throw error;
    }
  }
}
export const editInput = z
  .object({
    projectId: objectId,
    docId: objectId,
    expectedVersion: z.number().int().nonnegative(),
    oldText: z.string().min(1).max(100_000),
    newText: z.string().max(100_000),
    operationId: z.string().uuid(),
    dryRun: z.boolean().default(false),
  })
  .strict();
