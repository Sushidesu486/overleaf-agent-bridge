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
    async compileLog() {
      return { text: "log" };
    },
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
    async sessions(user, projectId, query = {}) {
      return [...data.sessions.values()]
        .filter(
          (s) =>
            s.userId === user &&
            s.projectId === projectId &&
            Boolean(s.archivedAt) === Boolean(query.archived) &&
            s.messages.some((m) => m.role === "user") &&
            (!query.connectionId || s.connectionId === query.connectionId) &&
            (!query.search ||
              s.title.toLowerCase().includes(query.search.toLowerCase())) &&
            (!query.before ||
              s.updatedAt < query.before ||
              (s.updatedAt === query.before && s.id < query.beforeId!)),
        )
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
        )
        .slice(0, 30)
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
  async function paired(name = "Fixture Agent") {
    const p = await chat.createPairing("alice", { projects: [project], name });
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
  assert.equal(
    f.data.sessions.size,
    0,
    "connecting alone must not create empty conversations",
  );
  const session = await f.chat.createSession("alice", {
    projectId: project,
    connectionId: c.connectionId,
  });
  assert.equal(commands[0].type, "prepare");
  assert.equal((await f.chat.sessions("alice", project)).length, 0);
  const stored = f.data.sessions.get(session.id)!;
  stored.messages.push({
    id: "first",
    role: "user",
    text: "Existing conversation",
  });
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

test("connection status distinguishes other project scopes without granting access, and correlates the pairing", async () => {
  const f = fixture(),
    c = await f.paired();
  const live = await f.chat.attach(
    c.credential,
    () => true,
    () => {},
  );
  try {
    assert.deepEqual(live.projects, [{ id: project, name: "Test" }]);
    const current = await f.chat.connections("alice", project, true);
    assert.equal(current[0].online, true);
    assert.equal(current[0].availableInProject, true);
    assert.equal(current[0].pairingId, c.code.split(".")[0]);
    const other = "222222222222222222222222";
    assert.equal((await f.chat.connections("alice", other)).length, 0);
    const elsewhere = await f.chat.connections("alice", other, true);
    assert.equal(elsewhere[0].availableInProject, false);
    assert.deepEqual(elsewhere[0].projectNames, ["Test"]);
    await assert.rejects(
      f.chat.createSession("alice", {
        projectId: other,
        connectionId: c.connectionId,
      }),
      /未授权/,
    );
  } finally {
    await live.disconnect();
  }
});

test("conversation management keeps history, enforces ownership and archives without deletion", async () => {
  const f = fixture(),
    c = await f.paired();
  await f.chat.attach(
    c.credential,
    () => true,
    () => {},
  );
  const initial = await f.chat.createSession("alice", {
    projectId: project,
    connectionId: c.connectionId,
  });
  await f.chat.prompt("alice", initial.id, { text: "Review equations" });
  let session = await f.chat.session("alice", initial.id);
  await assert.rejects(
    f.chat.updateSession("alice", session.id, {
      revision: session.revision,
      archived: true,
    }),
    /停止当前任务/,
  );
  await f.chat.event(c.credential, {
    sessionId: session.id,
    runId: session.runId,
    event: { type: "done", reason: "completed" },
  });
  session = await f.chat.session("alice", initial.id);
  await assert.rejects(
    f.chat.updateSession("bob", session.id, {
      revision: session.revision,
      title: "stolen",
    }),
    /不存在/,
  );
  await assert.rejects(
    f.chat.updateSession("alice", session.id, { revision: 0, title: "stale" }),
    /已更新/,
  );
  await assert.rejects(
    f.chat.updateSession("alice", session.id, {
      revision: session.revision,
      title: "   ",
    }),
  );
  const renamed = await f.chat.updateSession("alice", session.id, {
    revision: session.revision,
    title: "  Equation review  ",
  });
  assert.equal(renamed.title, "Equation review");
  const archived = await f.chat.updateSession("alice", session.id, {
    revision: renamed.revision,
    archived: true,
  });
  assert.deepEqual(archived.messages, session.messages);
  assert.equal((await f.chat.sessions("alice", project)).length, 0);
  assert.equal(
    (
      await f.chat.sessions("alice", project, {
        archived: "1",
        search: "review",
      })
    )[0].id,
    session.id,
  );
  await assert.rejects(
    f.chat.prompt("alice", session.id, { text: "continue" }),
    /归档/,
  );
  await f.chat.updateSession("alice", session.id, {
    revision: archived.revision,
    archived: false,
  });
  assert.equal((await f.chat.sessions("alice", project))[0].id, session.id);
  f.removeAccess();
  await assert.rejects(
    f.chat.updateSession("alice", session.id, {
      revision: archived.revision + 1,
      title: "no",
    }),
    /访问权限/,
  );
});

test("a conversation can change authorized connectors without accepting old readiness or replaying a task", async () => {
  const f = fixture(),
    a = await f.paired("Agent A"),
    b = await f.paired("Agent B"),
    legacy = await f.paired();
  const commands: BridgeCommand[] = [];
  await f.chat.attach(
    a.credential,
    (x) => (commands.push(x), true),
    () => {},
    true,
    true,
  );
  await f.chat.attach(
    b.credential,
    (x) => (commands.push(x), true),
    () => {},
    true,
    true,
  );
  await f.chat.attach(
    legacy.credential,
    () => true,
    () => {},
    true,
  );
  const initial = await f.chat.createSession("alice", {
    projectId: project,
    connectionId: a.connectionId,
  });
  f.data.sessions
    .get(initial.id)!
    .messages.push({ id: "m", role: "user", text: "Keep this history" });
  f.data.sessions
    .get(initial.id)!
    .messages.push({ id: "reply", role: "assistant", text: "Original answer" });
  await assert.rejects(
    f.chat.updateSession("alice", initial.id, {
      revision: 0,
      connectionId: legacy.connectionId,
    }),
    /新版连接器/,
  );
  const moved = await f.chat.updateSession("alice", initial.id, {
    revision: 0,
    connectionId: b.connectionId,
  });
  assert.equal(moved.id, initial.id);
  assert.equal(moved.messages[0].text, "Keep this history");
  assert.equal(moved.bindingVersion, 1);
  assert.equal(
    moved.messages.find((m) => m.id === "reply")?.actorName,
    "Agent A",
  );
  assert.equal(commands.at(-1)?.type, "prepare");
  assert.equal(commands.filter((c) => c.type === "prompt").length, 0);
  await assert.rejects(
    f.chat.prepared(a.credential, { sessionId: initial.id }),
    /不存在/,
  );
  await f.chat.prepared(b.credential, {
    sessionId: initial.id,
    bindingVersion: 1,
  });
  const ready = await f.chat.session("alice", initial.id);
  const returned = await f.chat.updateSession("alice", initial.id, {
    revision: ready.revision,
    connectionId: a.connectionId,
  });
  assert.equal(returned.bindingVersion, 2);
  await assert.rejects(
    f.chat.prepared(a.credential, { sessionId: initial.id, bindingVersion: 0 }),
    /不存在/,
  );
  await f.chat.prepared(a.credential, {
    sessionId: initial.id,
    bindingVersion: 2,
  });
  await f.chat.prompt("alice", initial.id, { text: "continue" });
  const running = await f.chat.session("alice", initial.id);
  await assert.rejects(
    f.chat.updateSession("alice", initial.id, {
      revision: running.revision,
      connectionId: b.connectionId,
    }),
    /停止当前任务/,
  );
  await assert.rejects(
    f.chat.event(b.credential, {
      sessionId: initial.id,
      runId: running.runId,
      event: { type: "done", reason: "completed" },
    }),
    /不存在/,
  );
  assert.equal(
    (commands.at(-1) as Extract<BridgeCommand, { type: "prompt" }>)
      .bindingVersion,
    2,
  );
});
