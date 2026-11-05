import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  AgentError,
  AgentService,
  type Grant,
  type Operation,
  type Store,
  type Backend,
} from "../src/agent/service.js";
import { handleMcp } from "../src/agent/http.js";
const projectId = "111111111111111111111111",
  docId = "222222222222222222222222";
function fixture() {
  const grants = new Map<string, Grant>(),
    operations = new Map<string, Operation>();
  let content = "你好，世界 🌍\nA sentence.",
    version = 3,
    access = true;
  const store: Store = {
    async insert(g) {
      grants.set(g.id, structuredClone(g));
    },
    async get(id) {
      return structuredClone(grants.get(id) ?? null);
    },
    async list(userId) {
      return [...grants.values()]
        .filter((g) => g.userId === userId)
        .map((g) => structuredClone(g));
    },
    async revoke(id, userId) {
      const g = grants.get(id);
      if (!g || g.userId !== userId) return false;
      g.revokedAt = new Date().toISOString();
      return true;
    },
    async rotate(id, userId, digest) {
      const g = grants.get(id);
      if (!g || g.userId !== userId || g.revokedAt) return false;
      g.digest = digest;
      return true;
    },
    async touch() {},
    async begin(op) {
      if (operations.has(op.id)) return false;
      operations.set(op.id, op);
      return true;
    },
    async finish(id, state, result) {
      Object.assign(operations.get(id)!, { state, result });
    },
  };
  const backend: Backend = {
    async user(id) {
      return { id, name: id, email: `${id}@example.invalid` };
    },
    async projects(id) {
      return id === "alice" && access ? [{ id: projectId, name: "Paper" }] : [];
    },
    async privilege(id) {
      return id === "alice" && access ? "owner" : false;
    },
    async tree() {
      return { entries: [{ id: docId, type: "document" }] };
    },
    async read() {
      return { content, version };
    },
    async edit(_project, _doc, _user, expected, text) {
      if (version !== expected)
        throw new AgentError("VERSION_CONFLICT", "conflict", 409);
      content = text;
      version++;
    },
    async compile() {
      return { status: "success" };
    },
  };
  const service = new AgentService(store, backend, "http://localhost:18080");
  return {
    service,
    backend,
    grants,
    operations,
    removeAccess: () => {
      access = false;
    },
  };
}
const key = (url: string) => new URL(url).pathname.split("/").at(-1)!;
test("personal links bind identity, enforce scope, rotate/revoke and current project ACL", async () => {
  const f = fixture();
  const issued = await f.service.issue("alice", {
    projects: [projectId],
    actions: ["read"],
  });
  const credential = key(issued.url);
  assert.ok(
    !JSON.stringify([...f.grants.values()]).includes(credential.split(".")[1]),
  );
  assert.ok(!JSON.stringify(await f.service.state("alice")).includes("digest"));
  await assert.rejects(f.service.rotate("bob", issued.grant.id), /不存在/);
  await assert.rejects(
    f.service.execute(credential, "overleaf_compile", { projectId }),
    /授权范围/,
  );
  const next = await f.service.rotate("alice", issued.grant.id);
  await assert.rejects(f.service.authenticate(credential), /无效/);
  assert.equal((await f.service.authenticate(key(next.url))).user.id, "alice");
  f.removeAccess();
  await assert.rejects(
    f.service.execute(key(next.url), "overleaf_read_document", {
      projectId,
      docId,
    }),
    /项目权限/,
  );
  await f.service.revoke("alice", issued.grant.id);
  await assert.rejects(f.service.authenticate(key(next.url)), /无效/);
});
test("edits support Unicode, reject stale versions, reserve operation IDs, and keep unknown outcomes", async () => {
  const f = fixture();
  const credential = key((await f.service.issue("alice", {})).url);
  const args = {
    projectId,
    docId,
    expectedVersion: 3,
    oldText: "世界 🌍",
    newText: "协作者 🌱",
    operationId: randomUUID(),
  };
  await f.service.execute(credential, "overleaf_edit_document", {
    ...args,
    dryRun: true,
  });
  assert.equal((await f.backend.read(projectId, docId)).version, 3);
  await f.service.execute(credential, "overleaf_edit_document", args);
  assert.equal(
    (await f.backend.read(projectId, docId)).content,
    "你好，协作者 🌱\nA sentence.",
  );
  await assert.rejects(
    f.service.execute(credential, "overleaf_edit_document", args),
    /文档已变化/,
  );
  const retry = {
    ...args,
    expectedVersion: 4,
    oldText: "A sentence.",
    newText: "Edited.",
  };
  await assert.rejects(
    f.service.execute(credential, "overleaf_edit_document", retry),
    /已提交/,
  );
  f.backend.edit = async () => {
    throw new Error("simulated dropped response");
  };
  const op = { ...retry, operationId: randomUUID() };
  await assert.rejects(
    f.service.execute(credential, "overleaf_edit_document", op),
  );
  assert.equal([...f.operations.values()].at(-1)?.state, "unknown");
  await assert.rejects(
    f.service.execute(credential, "overleaf_edit_document", op),
    /已提交/,
  );
});
test("real HTTP MCP client uses only its URL; origin checks and revocation apply after initialization", async (t) => {
  const f = fixture();
  const http = createServer((req, res) => {
    const credential = req.url?.split("/").at(-1) ?? "";
    req.url = "/agent-mcp";
    void handleMcp(req, res, f.service, credential);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  );
  const issued = await f.service.issue("alice", {});
  const url = new URL(
    `http://127.0.0.1:${(http.address() as { port: number }).port}/mcp/p/${key(issued.url)}`,
  );
  assert.equal(
    (await fetch(url, { headers: { Origin: "https://untrusted.example" } }))
      .status,
    403,
  );
  const client = new Client({ name: "fixture", version: "1" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(url));
  assert.equal((await client.listTools()).tools.length, 6);
  const result = await client.callTool({
    name: "overleaf_whoami",
    arguments: {},
  });
  assert.equal(
    JSON.parse((result.content as Array<{ text: string }>)[0].text).user.id,
    "alice",
  );
  await f.service.revoke("alice", issued.grant.id);
  await assert.rejects(
    client.callTool({ name: "overleaf_list_projects", arguments: {} }),
  );
});

test("revocation during backend preparation stops the pending edit before submission", async () => {
  const f = fixture();
  const issued = await f.service.issue("alice", {});
  let submitted = false;
  f.backend.edit = async (
    _project,
    _doc,
    _user,
    _version,
    _content,
    authorize,
  ) => {
    await f.service.revoke("alice", issued.grant.id);
    await authorize();
    submitted = true;
  };
  await assert.rejects(
    f.service.execute(key(issued.url), "overleaf_edit_document", {
      projectId,
      docId,
      expectedVersion: 3,
      oldText: "A sentence.",
      newText: "Changed.",
      operationId: randomUUID(),
    }),
    /无效/,
  );
  assert.equal(submitted, false);
  assert.equal((await f.backend.read(projectId, docId)).version, 3);
});
