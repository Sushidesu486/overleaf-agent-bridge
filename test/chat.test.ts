import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AgentService,
  type Grant,
  type Store,
  type Backend,
} from "../src/agent/service.js";
import {
  ChatService,
  type ChatStore,
  type Connection,
  type Pairing,
} from "../src/chat/service.js";
import type {
  BridgeCommand,
  ChatSession,
} from "../extensions/agent-access/shared/chat.js";
const project = "111111111111111111111111";
function fixture() {
  const grants = new Map<string, Grant>();
  let allowed = true;
  const agentStore: Store = {
    async insert(g) {
      grants.set(g.id, structuredClone(g));
    },
    async get(id) {
      return structuredClone(grants.get(id) || null);
    },
    async list(user) {
      return [...grants.values()].filter((g) => g.userId === user);
    },
    async revoke(id, user) {
      const g = grants.get(id);
      if (!g || g.userId !== user) return false;
      g.revokedAt = "now";
      return true;
    },
    async rotate(id, user, digest) {
      const g = grants.get(id);
      if (!g || g.userId !== user) return false;
      g.digest = digest;
      return true;
    },
    async touch() {},
    async begin() {
      return true;
    },
    async finish() {},
  };
  const backend: Backend = {
    async user(id) {
      return { id, name: id, email: id + "@example.invalid" };
    },
    async projects() {
      return [{ id: project, name: "Test" }];
    },
    async privilege(user) {
      return user === "alice" && allowed ? "owner" : false;
    },
    async tree() {
      return { entries: [] };
    },
    async read() {
      return { content: "", version: 0 };
    },
    async edit() {},
    async compile() {
      return {};
    },
  };
  const data = {
    pairings: new Map<string, Pairing>(),
    connections: new Map<string, Connection>(),
    sessions: new Map<string, ChatSession>(),
  };
  const store: ChatStore = {
    async get(kind, id) {
      return structuredClone(data[kind].get(id) || null) as never;
    },
    async insert(kind, value) {
      (data[kind] as Map<string, any>).set(value.id, structuredClone(value));
    },
    async consumePairing(id, digest, now) {
      const p = data.pairings.get(id);
      if (!p || p.digest !== digest || p.expiresAt <= now) return null;
      data.pairings.delete(id);
      return p;
    },
    async connections(user) {
      return [...data.connections.values()]
        .filter((c) => c.userId === user)
        .map((c) => structuredClone(c));
    },
    async sessions(user, projectId) {
      return [...data.sessions.values()]
        .filter((s) => s.userId === user && s.projectId === projectId)
        .map((s) => structuredClone(s));
    },
    async saveSession(value, revision) {
      if (data.sessions.get(value.id)?.revision !== revision) return false;
      data.sessions.set(value.id, structuredClone(value));
      return true;
    },
    async revokeConnection(id) {
      data.connections.get(id)!.revoked = true;
    },
    async interruptedSessions(connectionId) {
      return [...data.sessions.values()]
        .filter(
          (s) =>
            s.connectionId === connectionId &&
            (s.runId || s.agentState === "preparing"),
        )
        .map((s) => structuredClone(s));
    },
  };
  const agent = new AgentService(agentStore, backend, "http://localhost:18080"),
    chat = new ChatService(store, agent);
  async function paired() {
    const p = await chat.createPairing("alice", { projects: [project] });
    return {
      code: p.code,
      ...(await chat.pair({ code: p.code, runtime: "fixture" })),
    };
  }
  return {
    chat,
    agent,
    store,
    data,
    grants,
    paired,
    removeAccess() {
      allowed = false;
    },
  };
}
test("pairing is one-time, project scoped; rotation invalidates both channels", async () => {
  const f = fixture(),
    c = await f.paired();
  await assert.rejects(
    f.chat.pair({ code: c.code, runtime: "again" }),
    /配对码/,
  );
  await assert.rejects(
    f.chat.createSession("bob", {
      connectionId: c.connectionId,
      projectId: project,
    }),
  );
  await assert.rejects(
    f.chat.createSession("alice", {
      connectionId: c.connectionId,
      projectId: "222222222222222222222222",
    }),
    /未授权/,
  );
  const { connection } = await f.chat.authenticate(c.credential);
  await f.agent.rotate("alice", connection.grantId);
  await assert.rejects(f.chat.authenticate(c.credential), /重置/);
});
test("sessions isolate users, serialize prompts, preserve events and do not replay after reconnect", async () => {
  const f = fixture(),
    c = await f.paired(),
    commands: BridgeCommand[] = [];
  const live = await f.chat.attach(
    c.credential,
    (x) => {
      commands.push(x);
      return true;
    },
    () => {},
  );
  const s = await f.chat.createSession("alice", {
    connectionId: c.connectionId,
    projectId: project,
  });
  await assert.rejects(f.chat.session("bob", s.id), /不存在/);
  await f.chat.prompt("alice", s.id, { text: "edit" });
  const run = (commands[0] as Extract<BridgeCommand, { type: "prompt" }>).runId;
  await assert.rejects(
    f.chat.prompt("alice", s.id, { text: "duplicate" }),
    /当前任务/,
  );
  await f.chat.event(c.credential, {
    sessionId: s.id,
    runId: run,
    event: { type: "message", id: "m", role: "assistant", text: "hello" },
  });
  await f.chat.event(c.credential, {
    sessionId: s.id,
    runId: run,
    event: { type: "message", id: "m", role: "assistant", text: "hello world" },
  });
  assert.equal(
    (await f.chat.session("alice", s.id)).messages.filter(
      (m) => m.role === "assistant",
    ).length,
    1,
  );
  await live.disconnect();
  assert.equal((await f.chat.session("alice", s.id)).status, "interrupted");
  await f.chat.attach(
    c.credential,
    (x) => {
      commands.push(x);
      return true;
    },
    () => {},
  );
  assert.equal(commands.length, 1);
  await assert.rejects(
    f.chat.event(c.credential, {
      sessionId: s.id,
      runId: run,
      event: { type: "done", reason: "completed" },
    }),
    /中断/,
  );
  assert.equal(
    (await f.chat.session("alice", s.id)).messages.find(
      (m) => m.role === "assistant",
    )?.text,
    "hello world",
  );
});
test("permission replies and cancellation bind the active run; revocation and ACL loss take effect", async () => {
  const f = fixture(),
    c = await f.paired(),
    commands: BridgeCommand[] = [];
  await f.chat.attach(
    c.credential,
    (x) => {
      commands.push(x);
      return true;
    },
    () => {},
  );
  const s = await f.chat.createSession("alice", {
    connectionId: c.connectionId,
    projectId: project,
  });
  const run = (await f.chat.prompt("alice", s.id, { text: "compile" })).runId!;
  await f.chat.event(c.credential, {
    sessionId: s.id,
    runId: run,
    event: {
      type: "permission",
      permission: {
        id: "p",
        title: "compile?",
        options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }],
      },
    },
  });
  await assert.rejects(
    f.chat.permission("alice", s.id, { permissionId: "p", optionId: "forged" }),
    /失效/,
  );
  await f.chat.permission("alice", s.id, {
    permissionId: "p",
    optionId: "yes",
  });
  assert.equal(commands.at(-1)?.type, "permission");
  await f.chat.cancel("alice", s.id);
  assert.equal(commands.at(-1)?.type, "cancel");
  await f.chat.event(c.credential, {
    sessionId: s.id,
    runId: run,
    event: { type: "done", reason: "cancelled" },
  });
  assert.equal((await f.chat.session("alice", s.id)).runId, null);
  f.removeAccess();
  await assert.rejects(f.chat.session("alice", s.id), /访问权限/);
  await f.chat.revoke("alice", c.connectionId);
  await assert.rejects(f.chat.authenticate(c.credential));
  await assert.rejects(
    f.agent.authenticate(new URL(c.mcpUrl).pathname.split("/").at(-1)!),
  );
});

test("connection prepares a scoped conversation and readiness is isolated by connection", async () => {
  const f = fixture(),
    c = await f.paired(),
    commands: BridgeCommand[] = [];
  const attached = await f.chat.attach(
    c.credential,
    (x) => {
      commands.push(x);
      return true;
    },
    () => {},
    true,
  );
  await f.chat.prepareConnection(c.credential);
  const [session] = await f.chat.sessions("alice", project);
  assert.equal(commands[0].type, "prepare");
  assert.equal(
    (await f.chat.session("alice", session.id)).agentState,
    "preparing",
  );
  const other = await f.paired();
  await f.chat.attach(
    other.credential,
    () => true,
    () => {},
    true,
  );
  await assert.rejects(
    f.chat.prepared(other.credential, { sessionId: session.id }),
    /会话不存在/,
  );
  await f.chat.prepared(c.credential, { sessionId: session.id });
  assert.equal((await f.chat.session("alice", session.id)).agentState, "ready");
  await attached.disconnect();
  await f.chat.attach(
    c.credential,
    (x) => {
      commands.push(x);
      return true;
    },
    () => {},
    true,
  );
  await f.chat.prepareConnection(c.credential);
  assert.equal((await f.chat.sessions("alice", project)).length, 1);
  assert.equal(commands[1].type, "prepare");
  await f.chat.prepared(c.credential, {
    sessionId: session.id,
    error: "Please log in locally",
  });
  assert.equal((await f.chat.session("alice", session.id)).agentState, "error");
});

test("preparation interrupted before any prompt becomes retryable, including server restart", async () => {
  const f = fixture(),
    c = await f.paired();
  const live = await f.chat.attach(
    c.credential,
    () => true,
    () => {},
    true,
  );
  const first = await f.chat.createSession("alice", {
    connectionId: c.connectionId,
    projectId: project,
  });
  const second = await f.chat.createSession("alice", {
    connectionId: c.connectionId,
    projectId: project,
  });
  await live.disconnect();
  for (const s of [first, second])
    assert.equal((await f.chat.session("alice", s.id)).agentState, "error");
  await f.chat.attach(
    c.credential,
    () => true,
    () => {},
    true,
  );
  const third = await f.chat.createSession("alice", {
    connectionId: c.connectionId,
    projectId: project,
  });
  const restarted = new ChatService(f.store, f.agent);
  assert.equal(
    (await restarted.session("alice", third.id)).agentState,
    "error",
  );
});
