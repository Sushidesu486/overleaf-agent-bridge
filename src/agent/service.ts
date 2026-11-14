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
export const maxFileBytes = 50_000_000;
export const maxTextFileBytes = 2_000_000;
// Base64 adds roughly one third to the attachment size, plus the JSON envelope.
export const maxMcpRequestBytes = 72 * 1024 * 1024;
export const createFileInput = z
  .object({
    projectId: objectId,
    folderId: objectId.nullable().default(null),
    name: z
      .string()
      .min(1)
      .max(149)
      .refine(
        (name) =>
          !/[\/\\*\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/.test(name) &&
          name.trim() === name &&
          ![".", "..", "prototype"].includes(name) &&
          !Object.prototype.hasOwnProperty.call(Object.prototype, name),
        "Use a single valid filename",
      ),
    content: z
      .string()
      .max(Math.ceil(maxFileBytes / 3) * 4)
      .default(""),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
    operationId: z.string().uuid(),
    dryRun: z.boolean().default(false),
  })
  .strict();
export const deleteFileInput = z
  .object({
    projectId: objectId,
    fileId: objectId,
    expectedPath: z.string().min(2).max(1024).startsWith("/"),
    operationId: z.string().uuid(),
    dryRun: z.boolean().default(false),
  })
  .strict();
export type CreateFileInput = z.infer<typeof createFileInput>;
export type DeleteFileInput = z.infer<typeof deleteFileInput>;

function prepareCreateFile(args: CreateFileInput) {
  let bytes: Buffer;
  if (args.encoding === "base64") {
    if (Buffer.byteLength(args.content, "base64") > maxFileBytes)
      throw new AgentError(
        "FILE_TOO_LARGE",
        "The attachment exceeds the 50 MB limit",
      );
    bytes = Buffer.from(args.content, "base64");
    if (bytes.toString("base64") !== args.content)
      throw new AgentError(
        "INVALID_BASE64",
        "Use canonical Base64 without whitespace or a data URL prefix",
      );
  } else {
    args.content = args.content.replace(/\r\n?/g, "\n");
    if (Buffer.byteLength(args.content, "utf8") > maxTextFileBytes)
      throw new AgentError(
        "FILE_TOO_LARGE",
        "Editable text exceeds the 2 MB limit. Upload images (including SVG) as Base64 attachments, up to 50 MB.",
      );
    if (/[\u0000\uD800-\uDFFF]/u.test(args.content))
      throw new AgentError(
        "INVALID_TEXT",
        "Text must not contain NUL or incomplete Unicode characters",
      );
    bytes = Buffer.from(args.content, "utf8");
  }
  return {
    folderId: args.folderId,
    name: args.name,
    encoding: args.encoding,
    contentDigest: createHash("sha256").update(bytes).digest("hex"),
  };
}
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
    name: z.string().trim().min(1).max(60).default("My Agent"),
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
  kind?: "edit_document" | "create_file" | "delete_file";
  docId?: string;
  beforeVersion?: number;
  fileId?: string;
  folderId?: string | null;
  name?: string;
  expectedPath?: string;
  encoding?: string;
  contentDigest?: string;
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
  createFile(
    projectId: string,
    userId: string,
    args: CreateFileInput,
    authorize: () => Promise<void>,
  ): Promise<unknown>;
  deleteFile(
    projectId: string,
    userId: string,
    args: DeleteFileInput,
    authorize: () => Promise<void>,
  ): Promise<unknown>;
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
      throw new AgentError("ACCESS_DENIED", "This account is unavailable", 403);
    const data = grantInput.parse(input);
    if (!data.actions.includes("read")) data.actions.unshift("read");
    const existing = await this.store.list(userId);
    if (existing.filter((g) => !g.revokedAt).length >= 20)
      throw new AgentError("LINK_LIMIT", "You can keep up to 20 active links");
    if (data.projects !== null) {
      if (!data.projects.length)
        throw new AgentError("EMPTY_PROJECTS", "Select at least one project");
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
      throw new AgentError("NOT_FOUND", "Active link not found", 404);
    return { url: this.url(id, secret) };
  }
  async revoke(userId: string, id: string) {
    objectId.parse(id);
    if (!(await this.store.revoke(id, userId)))
      throw new AgentError("NOT_FOUND", "Link not found", 404);
    return { revoked: true };
  }
  async authenticate(credential: string) {
    const match = /^([a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/.exec(credential);
    if (!match)
      throw new AgentError(
        "INVALID_LINK",
        "This MCP link is invalid or has been disabled",
        401,
      );
    const grant = await this.store.get(match[1]);
    if (
      !grant ||
      grant.revokedAt ||
      !timingSafeEqual(
        Buffer.from(grant.digest, "hex"),
        Buffer.from(digest(match[2]), "hex"),
      )
    )
      throw new AgentError(
        "INVALID_LINK",
        "This MCP link is invalid or has been disabled",
        401,
      );
    const user = await this.backend.user(grant.userId);
    if (!user)
      throw new AgentError("ACCESS_DENIED", "This account is unavailable", 403);
    await this.store.touch(grant.id, grant.digest);
    return { grant, user };
  }
  async state(userId: string) {
    const user = await this.backend.user(userId);
    if (!user)
      throw new AgentError("ACCESS_DENIED", "This account is unavailable", 403);
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
      throw new AgentError(
        "ACCESS_DENIED",
        "Your account does not have access to this project",
        403,
      );
  }
  async execute(credential: string, name: string, input: unknown) {
    const { grant, user } = await this.authenticate(credential);
    if (name === "overleaf_whoami")
      return {
        user,
        connectionLabel: `${user.name}'s agent`,
        grant: publicGrant(grant),
        capabilities: {
          editing: true,
          fileCreation: true,
          fileDeletion: true,
          maxFileBytes,
          maxTextFileBytes,
          presenceLabel: false,
        },
      };
    if (name === "overleaf_list_projects") {
      const projects = await this.backend.projects(user.id);
      return projects.filter(
        (p) => grant.projects === null || grant.projects.includes(p.id),
      );
    }
    const { projectId } = z.object({ projectId: objectId }).parse(input);
    const required = [
      "overleaf_edit_document",
      "overleaf_create_file",
      "overleaf_delete_file",
    ].includes(name)
      ? "edit"
      : name === "overleaf_compile"
        ? "compile"
        : "read";
    if (
      !grant.actions.includes(required) ||
      (grant.projects !== null && !grant.projects.includes(projectId))
    )
      throw new AgentError(
        "OUTSIDE_GRANT",
        "This action is outside the scope of this link",
        403,
      );
    await this.checkPrivilege(user.id, projectId, required);
    if (name === "overleaf_create_file" || name === "overleaf_delete_file") {
      const authorize = async () => {
        await this.authenticate(credential);
        await this.checkPrivilege(user.id, projectId, "edit");
      };
      const creating = name === "overleaf_create_file";
      const args = creating
        ? createFileInput.parse(input)
        : deleteFileInput.parse(input);
      const details =
        "name" in args
          ? prepareCreateFile(args)
          : { fileId: args.fileId, expectedPath: args.expectedPath };
      const perform = () =>
        "name" in args
          ? this.backend.createFile(projectId, user.id, args, authorize)
          : this.backend.deleteFile(projectId, user.id, args, authorize);
      if (args.dryRun)
        return { dryRun: true, projectId, result: await perform() };
      const operationId = `${grant.id}:${args.operationId}`;
      if (
        !(await this.store.begin({
          id: operationId,
          grantId: grant.id,
          userId: user.id,
          projectId,
          kind: creating ? "create_file" : "delete_file",
          ...details,
          state: "pending",
        }))
      )
        throw new AgentError(
          "OPERATION_ALREADY_SUBMITTED",
          "This operation has already been submitted. Refresh the project tree to confirm the result.",
          409,
        );
      try {
        const result = {
          submitted: true,
          projectId,
          operationId: args.operationId,
          result: await perform(),
        };
        await this.store.finish(operationId, "submitted", result);
        return result;
      } catch (error) {
        const code =
          error instanceof AgentError ? error.code : "RESULT_UNKNOWN";
        await this.store.finish(
          operationId,
          code === "RESULT_UNKNOWN" ? "unknown" : "rejected",
          { code },
        );
        throw error;
      }
    }
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
        "The document has changed. Read it again before preparing an edit.",
        409,
      );
    const index = doc.content.indexOf(args.oldText);
    if (index < 0 || doc.content.indexOf(args.oldText, index + 1) !== -1)
      throw new AgentError(
        "TEXT_CONFLICT",
        "The original text must match exactly one location in the document",
        409,
      );
    const content =
      doc.content.slice(0, index) +
      args.newText +
      doc.content.slice(index + args.oldText.length);
    if (Buffer.byteLength(content) > maxTextFileBytes)
      throw new AgentError(
        "DOCUMENT_TOO_LARGE",
        "The document exceeds the 2 MB limit",
      );
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
        kind: "edit_document",
        beforeVersion: doc.version,
        state: "pending",
      }))
    )
      throw new AgentError(
        "OPERATION_ALREADY_SUBMITTED",
        "This operation has already been submitted. Read the document again to confirm the result.",
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
