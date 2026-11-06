import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  AgentError,
  AgentService,
  digest,
  grantInput,
  objectId,
  type Grant,
} from "../agent/service.js";
import type {
  Attachment,
  BridgeCommand,
  BridgeEvent,
  ChatSession,
  PublicConnection,
} from "../../extensions/agent-access/shared/chat.js";
export type Pairing = {
  id: string;
  digest: string;
  userId: string;
  input: z.infer<typeof grantInput>;
  expiresAt: string;
};
export type Connection = {
  id: string;
  digest: string;
  userId: string;
  grantId: string;
  grantDigest: string;
  pairingId?: string;
  name: string;
  runtime: string;
  revoked: boolean;
};
type Records = {
  pairings: Pairing;
  connections: Connection;
  sessions: ChatSession;
};
export interface ChatStore {
  get<K extends keyof Records>(kind: K, id: string): Promise<Records[K] | null>;
  insert<K extends keyof Records>(kind: K, value: Records[K]): Promise<void>;
  consumePairing(
    id: string,
    hash: string,
    now: string,
  ): Promise<Pairing | null>;
  connections(userId: string): Promise<Connection[]>;
  sessions(userId: string, projectId: string): Promise<ChatSession[]>;
  saveSession(value: ChatSession, previousRevision: number): Promise<boolean>;
  revokeConnection(id: string): Promise<void>;
  interruptedSessions(connectionId: string): Promise<ChatSession[]>;
}
const id = () => randomBytes(12).toString("hex");
const secret = () => randomBytes(32).toString("base64url");
const now = () => new Date().toISOString();
const tokenParts = (token: string) =>
  /^([a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/.exec(token);
const text = z.string().max(60_000);
const eventSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("message"),
      id: z.string().max(160),
      role: z.enum(["assistant", "tool"]),
      text,
      title: z.string().max(500).optional(),
      state: z.string().max(80).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("permission"),
      permission: z
        .object({
          id: z.string().max(160),
          title: z.string().max(1000),
          options: z
            .array(
              z
                .object({
                  optionId: z.string().max(160),
                  name: z.string().max(200),
                  kind: z.enum([
                    "allow_once",
                    "allow_always",
                    "reject_once",
                    "reject_always",
                  ]),
                })
                .strict(),
            )
            .min(1)
            .max(10),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("done"),
      reason: z.enum(["completed", "cancelled", "error"]),
      message: z.string().max(2000).optional(),
    })
    .strict(),
]);
const promptSchema = z
  .object({
    text: z.string().trim().min(1).max(20_000),
    attachment: z
      .object({
        docId: objectId,
        name: z.string().max(500),
        text: z.string().max(20_000).optional(),
        from: z.number().int().nonnegative().optional(),
        to: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
type LiveConnection = {
  send: (command: BridgeCommand) => boolean;
  close: () => void;
  generation: string;
  prepare: boolean;
};

/** One Web worker owns live connections. Durable sessions use revision CAS; interrupted turns are never replayed. */
export class ChatService {
  private live = new Map<string, LiveConnection>();
  private locks = new Map<string, Promise<unknown>>();
  private listeners = new Map<string, Set<(session: ChatSession) => void>>();
  constructor(
    readonly store: ChatStore,
    readonly agent: AgentService,
  ) {}
  private async lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(fn);
    this.locks.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.locks.get(key) === pending) this.locks.delete(key);
    }
  }
  async createPairing(userId: string, input: unknown) {
    const parsed = grantInput.parse(input);
    if (!(await this.agent.backend.user(userId)))
      throw new AgentError("ACCESS_DENIED", "账号不可用", 403);
    if (parsed.projects)
      for (const projectId of parsed.projects)
        await this.projectAccess(userId, projectId);
    if (
      (await this.store.connections(userId)).filter((c) => !c.revoked).length >=
      20
    )
      throw new AgentError("CONNECTION_LIMIT", "请先停用不再使用的连接");
    const value = secret();
    const pairing: Pairing = {
      id: id(),
      digest: digest(value),
      userId,
      input: parsed,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    };
    await this.store.insert("pairings", pairing);
    return {
      code: `${pairing.id}.${value}`,
      expiresAt: pairing.expiresAt,
      server: this.agent.publicOrigin,
    };
  }
  async pair(input: unknown) {
    const data = z
      .object({
        code: z.string().max(100),
        runtime: z.string().trim().min(1).max(80),
      })
      .strict()
      .parse(input);
    const parts = tokenParts(data.code);
    if (!parts)
      throw new AgentError("INVALID_PAIRING", "配对码无效或已过期", 401);
    const pairing = await this.store.consumePairing(
      parts[1],
      digest(parts[2]),
      now(),
    );
    if (!pairing)
      throw new AgentError(
        "INVALID_PAIRING",
        "配对码无效、已使用或已过期",
        401,
      );
    const issued = await this.agent.issue(pairing.userId, pairing.input);
    const grant = (await this.agent.store.get(issued.grant.id))!;
    const value = secret();
    const connection: Connection = {
      id: id(),
      digest: digest(value),
      userId: pairing.userId,
      grantId: grant.id,
      grantDigest: grant.digest,
      pairingId: pairing.id,
      name: pairing.input.name,
      runtime: data.runtime,
      revoked: false,
    };
    try {
      await this.store.insert("connections", connection);
    } catch (error) {
      await this.agent.revoke(pairing.userId, grant.id);
      throw error;
    }
    return {
      connectionId: connection.id,
      credential: `${connection.id}.${value}`,
      mcpUrl: issued.url,
      name: connection.name,
    };
  }
  async authenticate(credential: string) {
    const parts = tokenParts(credential);
    const connection = parts
      ? await this.store.get("connections", parts[1])
      : null;
    if (
      !connection ||
      connection.revoked ||
      !parts ||
      !timingSafeEqual(
        Buffer.from(connection.digest, "hex"),
        Buffer.from(digest(parts[2]), "hex"),
      )
    )
      throw new AgentError("INVALID_CONNECTION", "连接已失效，请重新配对", 401);
    const grant = await this.connectionGrant(connection);
    return { connection, grant };
  }
  private async connectionGrant(connection: Connection) {
    const grant = await this.agent.store.get(connection.grantId);
    if (
      !grant ||
      grant.revokedAt ||
      grant.digest !== connection.grantDigest ||
      !(await this.agent.backend.user(connection.userId))
    )
      throw new AgentError("INVALID_CONNECTION", "连接授权已停用或重置", 401);
    return grant;
  }
  private async projectAccess(userId: string, projectId: string) {
    objectId.parse(projectId);
    if (
      !(await this.agent.backend.user(userId)) ||
      !(await this.agent.backend.privilege(userId, projectId))
    )
      throw new AgentError("ACCESS_DENIED", "你已失去此项目的访问权限", 403);
  }
  private async ownedConnection(
    userId: string,
    connectionId: string,
    projectId?: string,
  ) {
    objectId.parse(connectionId);
    const connection = await this.store.get("connections", connectionId);
    if (!connection || connection.userId !== userId || connection.revoked)
      throw new AgentError("NOT_FOUND", "连接不存在", 404);
    const grant = await this.connectionGrant(connection);
    if (projectId && grant.projects && !grant.projects.includes(projectId))
      throw new AgentError("ACCESS_DENIED", "该连接未授权当前项目", 403);
    return connection;
  }
  async connections(
    userId: string,
    projectId: string,
    includeOthers = false,
  ): Promise<PublicConnection[]> {
    await this.projectAccess(userId, projectId);
    const projects = includeOthers
      ? await this.agent.backend.projects(userId)
      : [];
    return (
      await Promise.all(
        (await this.store.connections(userId)).map(
          async (c): Promise<PublicConnection | null> => {
            let grant: Grant | null = null;
            try {
              grant = await this.connectionGrant(c);
            } catch {}
            const availableInProject =
              !grant?.projects || grant.projects.includes(projectId);
            if (!availableInProject && !includeOthers) return null;
            return {
              id: c.id,
              name: c.name,
              runtime: c.runtime,
              projects: grant ? grant.projects : [],
              online: Boolean(grant && this.live.has(c.id)),
              revoked: c.revoked || !grant,
              pairingId: c.pairingId,
              availableInProject,
              projectNames: grant
                ? projects
                    .filter(
                      (p) =>
                        grant.projects === null ||
                        grant.projects.includes(p.id),
                    )
                    .map((p) => p.name)
                : [],
            };
          },
        ),
      )
    ).filter((c): c is PublicConnection => c !== null);
  }
  async revoke(userId: string, connectionId: string) {
    const c = await this.store.get("connections", objectId.parse(connectionId));
    if (!c || c.userId !== userId)
      throw new AgentError("NOT_FOUND", "连接不存在", 404);
    await this.store.revokeConnection(c.id);
    await this.agent.revoke(userId, c.grantId);
    const live = this.live.get(c.id);
    if (live) {
      this.live.delete(c.id);
      live.close();
    }
    await this.interruptConnection(c.id);
    return { revoked: true };
  }
  async attach(
    credential: string,
    send: LiveConnection["send"],
    close: LiveConnection["close"],
    prepare = false,
  ) {
    const { connection, grant } = await this.authenticate(credential);
    const projects = (
      await this.agent.backend.projects(connection.userId)
    ).filter((p) => grant.projects === null || grant.projects.includes(p.id));
    return this.lock(`connection:${connection.id}`, async () => {
      if (this.live.has(connection.id))
        throw new AgentError(
          "ALREADY_CONNECTED",
          "该连接器已在另一进程中运行",
          409,
        );
      // A server or connector restart leaves durable turns visibly interrupted, never queued for replay.
      await this.interruptConnection(connection.id);
      const entry: LiveConnection = { send, close, generation: id(), prepare };
      this.live.set(connection.id, entry);
      return {
        id: connection.id,
        projects,
        disconnect: async () => {
          if (this.live.get(connection.id) !== entry) return;
          this.live.delete(connection.id);
          await this.interruptConnection(connection.id);
        },
      };
    });
  }

  private prepareSession(session: ChatSession) {
    this.live.get(session.connectionId)?.send({
      type: "prepare",
      sessionId: session.id,
      projectId: session.projectId,
      context: session.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-20),
    });
  }
  async prepareConnection(credential: string) {
    const { connection, grant } = await this.authenticate(credential);
    if (grant.projects?.length !== 1) return;
    const projectId = grant.projects[0];
    await this.projectAccess(connection.userId, projectId);
    const previous = (
      await this.store.sessions(connection.userId, projectId)
    ).find((s) => s.connectionId === connection.id);
    if (!previous) {
      await this.createSession(connection.userId, {
        projectId,
        connectionId: connection.id,
      });
      return;
    }
    await this.lock(previous.id, async () => {
      const session = await this.session(connection.userId, previous.id, false);
      session.agentState = "preparing";
      delete session.agentError;
      await this.save(session);
      this.prepareSession(session);
    });
  }
  async prepared(credential: string, input: unknown) {
    const { connection } = await this.authenticate(credential);
    const data = z
      .object({ sessionId: objectId, error: z.string().max(2000).optional() })
      .strict()
      .parse(input);
    return this.lock(data.sessionId, async () => {
      const session = await this.session(
        connection.userId,
        data.sessionId,
        false,
      );
      if (
        session.connectionId !== connection.id ||
        !this.live.has(connection.id)
      )
        throw new AgentError("NOT_FOUND", "连接会话不存在", 404);
      session.agentState = data.error ? "error" : "ready";
      session.agentError = data.error;
      await this.save(session);
      return { accepted: true };
    });
  }

  async sessions(userId: string, projectId: string) {
    await this.projectAccess(userId, projectId);
    return (await this.store.sessions(userId, projectId)).map((s) => ({
      id: s.id,
      title: s.title,
      connectionId: s.connectionId,
      updatedAt: s.updatedAt,
    }));
  }
  async createSession(userId: string, input: unknown) {
    const data = z
      .object({ projectId: objectId, connectionId: objectId })
      .strict()
      .parse(input);
    await this.projectAccess(userId, data.projectId);
    await this.ownedConnection(userId, data.connectionId, data.projectId);
    const session: ChatSession = {
      id: id(),
      userId,
      ...data,
      title: "新对话",
      messages: [],
      status: "idle",
      runId: null,
      permission: null,
      revision: 0,
      createdAt: now(),
      updatedAt: now(),
    };
    const prepare = this.live.get(session.connectionId)?.prepare;
    if (prepare) session.agentState = "preparing";
    await this.store.insert("sessions", session);
    if (prepare) this.prepareSession(session);
    return session;
  }
  async session(userId: string, sessionId: string, recover = true) {
    const session = await this.store.get("sessions", objectId.parse(sessionId));
    if (!session || session.userId !== userId)
      throw new AgentError("NOT_FOUND", "会话不存在", 404);
    await this.projectAccess(userId, session.projectId);
    if (
      recover &&
      (session.runId || session.agentState === "preparing") &&
      !this.live.has(session.connectionId)
    ) {
      await this.interruptConnection(session.connectionId);
      return (await this.store.get("sessions", sessionId))!;
    }
    return session;
  }
  private async save(session: ChatSession) {
    const revision = session.revision;
    session.revision++;
    session.updatedAt = now();
    if (!(await this.store.saveSession(session, revision)))
      throw new AgentError("CONFLICT", "会话已更新，请刷新后重试", 409);
    for (const listener of this.listeners.get(session.id) ?? [])
      listener(session);
  }
  subscribe(sessionId: string, listener: (session: ChatSession) => void) {
    const set = this.listeners.get(sessionId) ?? new Set();
    set.add(listener);
    this.listeners.set(sessionId, set);
    return () => {
      set.delete(listener);
      if (!set.size) this.listeners.delete(sessionId);
    };
  }
  async prompt(userId: string, sessionId: string, input: unknown) {
    const data = promptSchema.parse(input);
    return this.lock(sessionId, async () => {
      const session = await this.session(userId, sessionId, false);
      if (session.runId)
        throw new AgentError("BUSY", "请等待当前任务结束或先停止任务", 409);
      await this.ownedConnection(
        userId,
        session.connectionId,
        session.projectId,
      );
      const live = this.live.get(session.connectionId);
      if (!live)
        throw new AgentError(
          "OFFLINE",
          "连接器离线，请先在自己的设备上启动",
          409,
        );
      if (data.attachment) {
        const tree = (await this.agent.backend.tree(session.projectId)) as {
          entries: { id: string }[];
        };
        if (!tree.entries.some((e) => e.id === data.attachment!.docId))
          throw new AgentError("INVALID_ATTACHMENT", "附件不属于当前项目");
      }
      if (session.messages.length >= 100)
        throw new AgentError("SESSION_LIMIT", "此会话已达长度限制，请新建对话");
      const context = session.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .slice(-20);
      session.runId = id();
      session.status = "running";
      session.permission = null;
      session.messages.push({
        id: id(),
        role: "user",
        text: data.text,
        attachment: data.attachment,
      });
      if (session.title === "新对话") session.title = data.text.slice(0, 40);
      await this.save(session);
      if (
        !live.send({
          type: "prompt",
          sessionId,
          runId: session.runId,
          projectId: session.projectId,
          text: data.text,
          context,
          attachment: data.attachment,
        })
      ) {
        await this.interruptSession(
          session,
          "连接已中断；请检查文档后重新发送。",
        );
        throw new AgentError("OFFLINE", "连接器已断开", 409);
      }
      return session;
    });
  }
  async cancel(userId: string, sessionId: string) {
    return this.lock(sessionId, async () => {
      const session = await this.session(userId, sessionId, false);
      if (!session.runId) return session;
      session.status = "cancelling";
      session.permission = null;
      await this.save(session);
      this.live
        .get(session.connectionId)
        ?.send({ type: "cancel", sessionId, runId: session.runId });
      return session;
    });
  }
  async permission(userId: string, sessionId: string, input: unknown) {
    const data = z
      .object({ permissionId: z.string(), optionId: z.string() })
      .strict()
      .parse(input);
    return this.lock(sessionId, async () => {
      const session = await this.session(userId, sessionId, false);
      if (
        !session.runId ||
        session.permission?.id !== data.permissionId ||
        !session.permission.options.some((o) => o.optionId === data.optionId)
      )
        throw new AgentError("STALE_PERMISSION", "这个操作询问已失效", 409);
      const live = this.live.get(session.connectionId);
      if (!live) throw new AgentError("OFFLINE", "连接器离线", 409);
      live.send({
        type: "permission",
        sessionId,
        runId: session.runId,
        ...data,
      });
      session.permission = null;
      session.status = "running";
      await this.save(session);
      return session;
    });
  }
  async event(credential: string, input: unknown) {
    const { connection } = await this.authenticate(credential);
    const data = z
      .object({ sessionId: objectId, runId: objectId, event: eventSchema })
      .strict()
      .parse(input);
    return this.lock(data.sessionId, async () => {
      const session = await this.store.get("sessions", data.sessionId);
      if (
        !session ||
        session.userId !== connection.userId ||
        session.connectionId !== connection.id
      )
        throw new AgentError("NOT_FOUND", "会话不存在", 404);
      if (session.runId !== data.runId || !this.live.has(connection.id))
        throw new AgentError("STALE_RUN", "任务已结束或中断", 409);
      await this.projectAccess(connection.userId, session.projectId);
      const event: BridgeEvent = data.event;
      if (event.type === "message") {
        const messageId = `${data.runId}:${event.id}`;
        const index = session.messages.findIndex((m) => m.id === messageId);
        const message = {
          id: messageId,
          role: event.role,
          text: event.text,
          title: event.title,
          state: event.state,
        };
        if (index >= 0) session.messages[index] = message;
        else if (session.messages.length < 120) session.messages.push(message);
        else
          throw new AgentError("SESSION_LIMIT", "会话已达长度限制，请新建对话");
      } else if (event.type === "permission") {
        if (session.status === "cancelling") return { accepted: false };
        session.permission = event.permission;
        session.status = "waiting_permission";
      } else {
        session.messages.push({
          id: id(),
          role: "status",
          text:
            event.message ||
            {
              completed: "任务完成",
              cancelled: "已停止；已提交的编辑会保留",
              error: "Agent 执行失败",
            }[event.reason],
        });
        session.status = event.reason === "error" ? "interrupted" : "idle";
        session.runId = null;
        session.permission = null;
      }
      await this.save(session);
      return { accepted: true };
    });
  }
  private async interruptSession(session: ChatSession, message: string) {
    if (session.agentState === "preparing") {
      session.agentState = "error";
      session.agentError = "会话初始化中断，连接恢复后可重新发送消息。";
    }
    session.status = "interrupted";
    session.runId = null;
    session.permission = null;
    session.messages.push({ id: id(), role: "status", text: message });
    await this.save(session);
  }
  private async interruptConnection(connectionId: string) {
    for (const value of await this.store.interruptedSessions(connectionId)) {
      await this.lock(value.id, async () => {
        const session = await this.store.get("sessions", value.id);
        if (session && (session.runId || session.agentState === "preparing"))
          await this.interruptSession(
            session,
            "连接中断，任务未自动重放。请检查文档后继续。",
          );
      });
    }
  }
}
