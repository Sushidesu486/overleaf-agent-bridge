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
export type SessionQuery = {
  archived?: boolean;
  search?: string;
  before?: string;
  beforeId?: string;
  connectionId?: string;
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
  sessions(
    userId: string,
    projectId: string,
    query?: SessionQuery,
  ): Promise<ChatSession[]>;
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
  rebind: boolean;
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
      throw new AgentError("ACCESS_DENIED", "This account is unavailable", 403);
    if (parsed.projects)
      for (const projectId of parsed.projects)
        await this.projectAccess(userId, projectId);
    if (
      (await this.store.connections(userId)).filter((c) => !c.revoked).length >=
      20
    )
      throw new AgentError(
        "CONNECTION_LIMIT",
        "Disable unused connections before adding another",
      );
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
      throw new AgentError(
        "INVALID_PAIRING",
        "The pairing code is invalid or has expired",
        401,
      );
    const pairing = await this.store.consumePairing(
      parts[1],
      digest(parts[2]),
      now(),
    );
    if (!pairing)
      throw new AgentError(
        "INVALID_PAIRING",
        "The pairing code is invalid, has already been used or has expired",
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
      throw new AgentError(
        "INVALID_CONNECTION",
        "The connection is no longer valid. Please pair again.",
        401,
      );
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
      throw new AgentError(
        "INVALID_CONNECTION",
        "The connection authorization has been disabled or reset",
        401,
      );
    return grant;
  }
  private async projectAccess(userId: string, projectId: string) {
    objectId.parse(projectId);
    if (
      !(await this.agent.backend.user(userId)) ||
      !(await this.agent.backend.privilege(userId, projectId))
    )
      throw new AgentError(
        "ACCESS_DENIED",
        "You no longer have access to this project",
        403,
      );
  }
  private async ownedConnection(
    userId: string,
    connectionId: string,
    projectId?: string,
  ) {
    objectId.parse(connectionId);
    const connection = await this.store.get("connections", connectionId);
    if (!connection || connection.userId !== userId || connection.revoked)
      throw new AgentError("NOT_FOUND", "Connection not found", 404);
    const grant = await this.connectionGrant(connection);
    if (projectId && grant.projects && !grant.projects.includes(projectId))
      throw new AgentError(
        "ACCESS_DENIED",
        "This connection is not authorized for the current project",
        403,
      );
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
              canRebind: Boolean(this.live.get(c.id)?.rebind),
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
      throw new AgentError("NOT_FOUND", "Connection not found", 404);
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
    rebind = false,
  ) {
    const { connection, grant } = await this.authenticate(credential);
    const projects = (
      await this.agent.backend.projects(connection.userId)
    ).filter((p) => grant.projects === null || grant.projects.includes(p.id));
    return this.lock(`connection:${connection.id}`, async () => {
      if (this.live.has(connection.id))
        throw new AgentError(
          "ALREADY_CONNECTED",
          "This connector is already running in another process",
          409,
        );
      // A server or connector restart leaves durable turns visibly interrupted, never queued for replay.
      await this.interruptConnection(connection.id);
      const entry: LiveConnection = {
        send,
        close,
        generation: id(),
        prepare,
        rebind,
      };
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
      bindingVersion: session.bindingVersion ?? 0,
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
      await this.store.sessions(connection.userId, projectId, {
        connectionId: connection.id,
      })
    )[0];
    if (!previous) return;
    await this.lock(previous.id, async () => {
      const session = await this.session(connection.userId, previous.id, false);
      session.agentState = "preparing";
      delete session.agentError;
      delete session.recovery;
      await this.save(session);
      this.prepareSession(session);
    });
  }
  async prepared(credential: string, input: unknown) {
    const { connection } = await this.authenticate(credential);
    const data = z
      .object({
        sessionId: objectId,
        bindingVersion: z.number().int().nonnegative().default(0),
        error: z.string().max(2000).optional(),
        recovery: z
          .union([
            z.object({ mode: z.enum(["new", "resumed"]) }).strict(),
            z
              .object({
                mode: z.literal("rebuilt"),
                reason: z.enum([
                  "missing",
                  "unsupported",
                  "changed",
                  "unavailable",
                ]),
              })
              .strict(),
          ])
          .optional(),
      })
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
        (session.bindingVersion ?? 0) !== data.bindingVersion ||
        !this.live.has(connection.id)
      )
        throw new AgentError("NOT_FOUND", "Connection session not found", 404);
      session.agentState = data.error ? "error" : "ready";
      session.agentError = data.error;
      session.recovery = data.error ? undefined : data.recovery;
      await this.save(session);
      return { accepted: true };
    });
  }

  async sessions(userId: string, projectId: string, input: unknown = {}) {
    await this.projectAccess(userId, projectId);
    const query = z
      .object({
        archived: z.enum(["0", "1"]).default("0"),
        search: z.string().trim().max(100).default(""),
        before: z.iso.datetime().optional(),
        beforeId: objectId.optional(),
      })
      .refine(
        (q) => Boolean(q.before) === Boolean(q.beforeId),
        "Incomplete pagination parameters",
      )
      .parse(input);
    return (
      await this.store.sessions(userId, projectId, {
        ...query,
        archived: query.archived === "1",
      })
    ).map((s) => ({
      id: s.id,
      title: s.title,
      connectionId: s.connectionId,
      updatedAt: s.updatedAt,
      status: s.status,
      runId: s.runId,
      archivedAt: s.archivedAt,
    }));
  }
  async updateSession(userId: string, sessionId: string, input: unknown) {
    const data = z
      .object({
        revision: z.number().int().nonnegative(),
        title: z.string().trim().min(1).max(100).optional(),
        archived: z.boolean().optional(),
        connectionId: objectId.optional(),
      })
      .strict()
      .parse(input);
    return this.lock(sessionId, async () => {
      const session = await this.session(userId, sessionId, false);
      if (session.revision !== data.revision)
        throw new AgentError(
          "CONFLICT",
          "The conversation has changed. Please try again.",
          409,
        );
      if (session.runId)
        throw new AgentError(
          "BUSY",
          "Stop the current task before managing this conversation",
          409,
        );
      if (data.connectionId && data.connectionId !== session.connectionId) {
        if (session.archivedAt)
          throw new AgentError(
            "ARCHIVED",
            "Restore the archived conversation first",
            409,
          );
        const connection = await this.ownedConnection(
          userId,
          data.connectionId,
          session.projectId,
        );
        const live = this.live.get(connection.id);
        if (!live)
          throw new AgentError(
            "OFFLINE",
            "Start the agent you want to use first",
            409,
          );
        if (!live.rebind)
          throw new AgentError(
            "UPDATE_CONNECTOR",
            "Download the latest connector before switching this conversation",
            409,
          );
        const previous = await this.store.get(
          "connections",
          session.connectionId,
        );
        for (const message of session.messages) {
          if (
            (message.role === "assistant" || message.role === "tool") &&
            !message.actorName
          ) {
            message.actorName = previous?.name || "Agent";
            message.actorRuntime = previous?.runtime;
          }
        }
        session.connectionId = connection.id;
        session.bindingVersion = (session.bindingVersion ?? 0) + 1;
        session.agentState = "preparing";
        delete session.agentError;
        delete session.recovery;
        session.messages.push({
          id: id(),
          role: "status",
          text: `Switched to ${connection.name} (${connection.runtime}). Context will be restored from recent messages.`,
        });
      }
      if (data.title !== undefined) session.title = data.title;
      if (data.archived === true) session.archivedAt = now();
      if (data.archived === false) delete session.archivedAt;
      await this.save(session);
      if (data.connectionId && session.agentState === "preparing")
        this.prepareSession(session);
      return session;
    });
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
      title: "New conversation",
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
      throw new AgentError("NOT_FOUND", "Session not found", 404);
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
      throw new AgentError(
        "CONFLICT",
        "The session has changed. Refresh and try again.",
        409,
      );
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
      if (session.archivedAt)
        throw new AgentError(
          "ARCHIVED",
          "Restore the archived conversation first",
          409,
        );
      if (session.runId)
        throw new AgentError(
          "BUSY",
          "Wait for the current task to finish, or stop it first",
          409,
        );
      await this.ownedConnection(
        userId,
        session.connectionId,
        session.projectId,
      );
      const live = this.live.get(session.connectionId);
      if (!live)
        throw new AgentError(
          "OFFLINE",
          "The connector is offline. Start it on your device first.",
          409,
        );
      if (data.attachment) {
        const tree = (await this.agent.backend.tree(session.projectId)) as {
          entries: { id: string }[];
        };
        if (!tree.entries.some((e) => e.id === data.attachment!.docId))
          throw new AgentError(
            "INVALID_ATTACHMENT",
            "The attachment does not belong to this project",
          );
      }
      if (session.messages.length >= 100)
        throw new AgentError(
          "SESSION_LIMIT",
          "This session has reached its length limit. Start a new conversation.",
        );
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
      if (session.title === "New conversation")
        session.title = data.text.slice(0, 40);
      await this.save(session);
      if (
        !live.send({
          type: "prompt",
          sessionId,
          runId: session.runId,
          projectId: session.projectId,
          bindingVersion: session.bindingVersion ?? 0,
          text: data.text,
          context,
          attachment: data.attachment,
        })
      ) {
        await this.interruptSession(
          session,
          "The connection was interrupted. Check the document before sending the request again.",
        );
        throw new AgentError("OFFLINE", "The connector has disconnected", 409);
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
        throw new AgentError(
          "STALE_PERMISSION",
          "This permission request is no longer active",
          409,
        );
      const live = this.live.get(session.connectionId);
      if (!live)
        throw new AgentError("OFFLINE", "The connector is offline", 409);
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
        throw new AgentError("NOT_FOUND", "Session not found", 404);
      if (session.runId !== data.runId || !this.live.has(connection.id))
        throw new AgentError(
          "STALE_RUN",
          "The task has finished or was interrupted",
          409,
        );
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
          actorName: connection.name,
          actorRuntime: connection.runtime,
        };
        if (index >= 0) session.messages[index] = message;
        else if (session.messages.length < 120) session.messages.push(message);
        else
          throw new AgentError(
            "SESSION_LIMIT",
            "This session has reached its length limit. Start a new conversation.",
          );
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
              completed: "Task completed",
              cancelled: "Stopped. Edits already submitted are preserved.",
              error: "Agent execution failed",
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
      session.agentError =
        "Session initialization was interrupted. Send your message again after reconnecting.";
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
            "The connection was interrupted. The task was not replayed. Check the document before continuing.",
          );
      });
    }
  }
}
