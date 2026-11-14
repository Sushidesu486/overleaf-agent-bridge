import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  AgentError,
  maxFileBytes,
  maxTextFileBytes,
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
    async createFile() {
      return {};
    },
    async deleteFile() {
      return {};
    },
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
    async compileLog() {
      return { text: "log" };
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
  await assert.rejects(f.service.rotate("bob", issued.grant.id), /not found/);
  await assert.rejects(
    f.service.execute(credential, "overleaf_compile", { projectId }),
    /outside the scope/,
  );
  const next = await f.service.rotate("alice", issued.grant.id);
  await assert.rejects(f.service.authenticate(credential), /invalid/);
  assert.equal((await f.service.authenticate(key(next.url))).user.id, "alice");
  f.removeAccess();
  await assert.rejects(
    f.service.execute(key(next.url), "overleaf_read_document", {
      projectId,
      docId,
    }),
    /does not have access/,
  );
  await f.service.revoke("alice", issued.grant.id);
  await assert.rejects(f.service.authenticate(key(next.url)), /invalid/);
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
    /document has changed/,
  );
  const retry = {
    ...args,
    expectedVersion: 4,
    oldText: "A sentence.",
    newText: "Edited.",
  };
  await assert.rejects(
    f.service.execute(credential, "overleaf_edit_document", retry),
    /already been submitted/,
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
    /already been submitted/,
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
  assert.equal((await client.listTools()).tools.length, 9);
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
    /invalid/,
  );
  assert.equal(submitted, false);
  assert.equal((await f.backend.read(projectId, docId)).version, 3);
});

test("compile-log reads require current project access, bind identity, and recheck revocation after fetching", async () => {
  const f = fixture();
  const link = await f.service.issue("alice", {
    projects: [projectId],
    actions: ["read"],
  });
  const args = { projectId, buildId: "abc-def" };
  f.backend.compileLog = async (project, user, input) => {
    assert.equal(project, projectId);
    assert.equal(user, "alice");
    assert.equal(input.file, "output.log");
    return { text: "build log" };
  };
  assert.deepEqual(
    await f.service.execute(key(link.url), "overleaf_get_compile_log", args),
    { text: "build log" },
  );
  await assert.rejects(
    f.service.execute(key(link.url), "overleaf_get_compile_log", {
      ...args,
      userId: "bob",
    }),
  );
  await assert.rejects(
    f.service.execute(key(link.url), "overleaf_get_compile_log", {
      ...args,
      projectId: "333333333333333333333333",
    }),
    /outside the scope/,
  );
  f.backend.compileLog = async () => {
    await f.service.revoke("alice", link.grant.id);
    return { text: "must not be returned" };
  };
  await assert.rejects(
    f.service.execute(key(link.url), "overleaf_get_compile_log", args),
    /invalid/,
  );
});

test("file tools enforce edit grants, project scope and current write permission", async () => {
  const f = fixture();
  const readOnly = await f.service.issue("alice", {
    projects: [projectId],
    actions: ["read"],
  });
  const editor = await f.service.issue("alice", { projects: [projectId] });
  for (const [tool, args] of [
    ["overleaf_create_file", { name: "part.tex", content: "text" }],
    ["overleaf_delete_file", { fileId: docId, expectedPath: "/main.tex" }],
  ] as const) {
    const input = { projectId, ...args, operationId: randomUUID() };
    await assert.rejects(
      f.service.execute(key(readOnly.url), tool, input),
      /outside the scope/,
    );
    await assert.rejects(
      f.service.execute(key(editor.url), tool, {
        ...input,
        projectId: "333333333333333333333333",
      }),
      /outside the scope/,
    );
    f.backend.privilege = async () => "readOnly";
    await assert.rejects(
      f.service.execute(key(editor.url), tool, input),
      /does not have access/,
    );
  }
  assert.equal(f.operations.size, 0);
});

test("file creation validates text, binary, size and filenames before reserving a write", async () => {
  const f = fixture();
  const credential = key((await f.service.issue("alice", {})).url);
  const create = (extra: Record<string, unknown>) =>
    f.service.execute(credential, "overleaf_create_file", {
      projectId,
      name: "part.tex",
      operationId: randomUUID(),
      ...extra,
    });
  let received: unknown;
  f.backend.createFile = async (_project, user, args, authorize) => {
    assert.equal(user, "alice");
    await authorize();
    received = args.content;
    return { id: docId, path: "/part.tex" };
  };
  await create({ content: "中文\r\nsecond\rthird", dryRun: true });
  assert.equal(received, "中文\nsecond\nthird");
  assert.equal(f.operations.size, 0);
  await create({
    content: Buffer.from([0, 1, 255]).toString("base64"),
    encoding: "base64",
  });
  assert.equal([...f.operations.values()][0].kind, "create_file");
  assert.ok(!("content" in [...f.operations.values()][0]));
  for (const extra of [
    { content: "bad*base64", encoding: "base64" },
    { content: "YQ", encoding: "base64" },
    { content: "a\u0000b" },
    { content: "\ud800" },
    { content: "中".repeat(666_667) },
    {
      content: Buffer.alloc(maxFileBytes + 1).toString("base64"),
      encoding: "base64",
    },
    ...[
      "../a.tex",
      "nested/a.tex",
      "a\\b.tex",
      "constructor",
      "__proto__",
      "a ",
      "🌱.tex",
    ].map((name) => ({ name })),
  ])
    await assert.rejects(create(extra));
  assert.equal(f.operations.size, 1);
});

test("attachments accept the 50 MB boundary while editable text stays at 2 MB", async () => {
  const f = fixture();
  const credential = key((await f.service.issue("alice", {})).url);
  const identity = (await f.service.execute(
    credential,
    "overleaf_whoami",
    {},
  )) as { capabilities: { maxFileBytes: number; maxTextFileBytes: number } };
  assert.equal(identity.capabilities.maxFileBytes, 50_000_000);
  assert.equal(identity.capabilities.maxTextFileBytes, 2_000_000);
  let submitted = 0;
  f.backend.createFile = async (_project, _user, args, authorize) => {
    await authorize();
    assert.equal(
      Buffer.byteLength(
        args.content,
        args.encoding === "base64" ? "base64" : "utf8",
      ),
      args.encoding === "base64" ? maxFileBytes : maxTextFileBytes,
    );
    submitted++;
    return {};
  };
  await f.service.execute(credential, "overleaf_create_file", {
    projectId,
    name: "large.svg",
    encoding: "base64",
    content: Buffer.alloc(maxFileBytes).toString("base64"),
    operationId: randomUUID(),
  });
  await f.service.execute(credential, "overleaf_create_file", {
    projectId,
    name: "large.tex",
    content: "a".repeat(maxTextFileBytes),
    operationId: randomUUID(),
  });
  await assert.rejects(
    f.service.execute(credential, "overleaf_create_file", {
      projectId,
      name: "large.svg",
      content: "a".repeat(maxTextFileBytes + 1),
      operationId: randomUUID(),
    }),
    { code: "FILE_TOO_LARGE" },
  );
  assert.equal(submitted, 2);
});

test("file operations preserve uncertain outcomes and block replays across tools", async () => {
  const f = fixture();
  const credential = key((await f.service.issue("alice", {})).url);
  const operationId = randomUUID();
  let submissions = 0;
  f.backend.createFile = async () => {
    submissions++;
    throw new Error("connection lost after submission");
  };
  await assert.rejects(
    f.service.execute(credential, "overleaf_create_file", {
      projectId,
      name: "part.tex",
      operationId,
    }),
  );
  assert.equal([...f.operations.values()][0].state, "unknown");
  await assert.rejects(
    f.service.execute(credential, "overleaf_delete_file", {
      projectId,
      fileId: docId,
      expectedPath: "/part.tex",
      operationId,
    }),
    /already been submitted/,
  );
  assert.equal(submissions, 1);
});

test("file creation and deletion reauthorize after backend preparation", async () => {
  for (const mutation of ["createFile", "deleteFile"] as const) {
    const f = fixture();
    const issued = await f.service.issue("alice", {});
    let written = false;
    f.backend[mutation] = async (_project, _user, _args, authorize) => {
      await f.service.revoke("alice", issued.grant.id);
      await authorize();
      written = true;
    };
    await assert.rejects(
      f.service.execute(
        key(issued.url),
        mutation === "createFile"
          ? "overleaf_create_file"
          : "overleaf_delete_file",
        {
          projectId,
          operationId: randomUUID(),
          ...(mutation === "createFile"
            ? { name: "part.tex" }
            : { fileId: docId, expectedPath: "/part.tex" }),
        },
      ),
      /invalid/,
    );
    assert.equal(written, false);
    assert.equal([...f.operations.values()][0].state, "rejected");
  }
});
