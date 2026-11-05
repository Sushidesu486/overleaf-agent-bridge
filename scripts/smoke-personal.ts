import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { CookieJar } from "tough-cookie";
import { load } from "cheerio";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OverleafClient } from "../src/overleaf.js";
const origin = "http://localhost:18080";
class Browser {
  jar = new CookieJar();
  csrf = "";
  async request(path: string, body?: unknown, csrf = this.csrf) {
    const response = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      headers: {
        Accept: "application/json",
        Cookie: await this.jar.getCookieString(origin),
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie())
      await this.jar.setCookie(cookie, origin);
    return response;
  }
  async login(user: { email: string; password: string }) {
    this.csrf = load(await (await this.request("/login")).text())(
      'meta[name="ol-csrfToken"]',
    ).attr("content")!;
    assert.equal((await this.request("/login", user)).status, 200);
    const page = await this.request("/user/agent");
    assert.equal(page.status, 200);
    this.csrf = load(await page.text())('meta[name="csrf-token"]').attr(
      "content",
    )!;
    assert.ok(this.csrf);
  }
  async json(path: string, body?: unknown) {
    const response = await this.request(path, body);
    assert.equal(response.status, 200, `HTTP request failed at ${path}`);
    return response.json();
  }
}
const users = JSON.parse(await readFile(".local/lab-users.json", "utf8"));
const human = new Browser(),
  outsider = new Browser();
await human.login(users[0]);
await outsider.login(users[2]);
assert.equal((await new Browser().request("/user/agent/state")).status, 401);
assert.equal(
  (await human.request("/user/agent/links", {}, "wrong-csrf-token")).status,
  403,
);
let projectId: string;
try {
  projectId = JSON.parse(
    await readFile(".local/human-project.json", "utf8"),
  ).projectId;
} catch {
  const client = new OverleafClient({
    baseUrl: origin,
    ...users[0],
    allowedProjectIds: [],
  });
  await client.login();
  projectId = await client.createProject("Personal Agent collaboration lab");
  await writeFile(".local/human-project.json", JSON.stringify({ projectId }), {
    mode: 0o600,
  });
}
const issued: Array<{ browser: Browser; id: string }> = [],
  clients: Client[] = [],
  secrets: string[] = [];
async function issue(browser: Browser, body: unknown) {
  const link = await browser.json("/user/agent/links", body);
  issued.push({ browser, id: link.grant.id });
  secrets.push(new URL(link.url).pathname.split(".").at(-1)!);
  assert.ok(!JSON.stringify(link.grant).includes("digest"));
  return link;
}
async function connect(url: string) {
  const client = new Client({ name: "personal-url-smoke", version: "1.0" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: 120_000,
  });
  const value = JSON.parse((result.content as Array<{ text: string }>)[0].text);
  if (result.isError)
    throw new Error(`Tool ${name}: ${value.code} ${value.message}`);
  return value;
}
try {
  const link = await issue(human, {
    name: "Smoke: personal link",
    projects: [projectId],
  });
  const client = await connect(link.url);
  assert.equal((await client.listTools()).tools.length, 6);
  const who = await call(client, "overleaf_whoami");
  assert.equal(who.user.email, users[0].email);
  assert.deepEqual(
    (await call(client, "overleaf_list_projects")).map(
      (p: { id: string }) => p.id,
    ),
    [projectId],
  );
  const tree = await call(client, "overleaf_get_project_tree", { projectId });
  const docId = tree.rootDocId;
  let before = await call(client, "overleaf_read_document", {
    projectId,
    docId,
  });
  // Remove only comments created by interrupted runs of this isolated fixture.
  for (const oldText of before.content.match(
    /^% Agent smoke [0-9a-f-]{36} 你好[^\n]*\n/gm,
  ) || []) {
    await call(client, "overleaf_edit_document", {
      projectId,
      docId,
      expectedVersion: before.version,
      oldText,
      newText: "",
      operationId: randomUUID(),
    });
    before = await call(client, "overleaf_read_document", { projectId, docId });
  }
  const anchor = "\\end{document}";
  assert.equal(before.content.split(anchor).length, 2);
  const replacement = `% Agent smoke ${randomUUID()} 你好\n${anchor}`;
  const args = {
    projectId,
    docId,
    expectedVersion: before.version,
    oldText: anchor,
    newText: replacement,
    operationId: randomUUID(),
  };
  await call(client, "overleaf_edit_document", { ...args, dryRun: true });
  assert.equal(
    (await call(client, "overleaf_read_document", { projectId, docId }))
      .version,
    before.version,
  );
  if (before.otType === "sharejs-text-ot") {
    const emoji = await client.callTool({
      name: "overleaf_edit_document",
      arguments: { ...args, newText: `🌱${anchor}`, operationId: randomUUID() },
    });
    assert.ok(emoji.isError);
    assert.equal(
      JSON.parse((emoji.content as Array<{ text: string }>)[0].text).code,
      "UNSUPPORTED_TEXT",
    );
    assert.equal(
      (await call(client, "overleaf_read_document", { projectId, docId }))
        .version,
      before.version,
    );
  }
  await call(client, "overleaf_edit_document", args);
  const after = await call(client, "overleaf_read_document", {
    projectId,
    docId,
  });
  assert.ok(after.content.includes(replacement));
  assert.ok(after.version > before.version);
  const stale = await client.callTool({
    name: "overleaf_edit_document",
    arguments: { ...args, operationId: randomUUID() },
  });
  assert.ok(stale.isError);
  // Directly exercise the document lock's stale-version guard, beyond the MCP pre-read check.
  const casScript = `const r=await fetch('http://127.0.0.1:3003/project/${projectId}/doc/${docId}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({lines:['must never replace the document'],source:'agent',user_id:'${who.user.id}',expectedVersion:${before.version}})});console.log(r.status)`;
  const cas = execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "overleaf",
      "node",
      "--input-type=module",
      "-e",
      casScript,
    ],
    { encoding: "utf8" },
  ).trim();
  assert.equal(cas, "409");
  assert.equal(
    (await call(client, "overleaf_read_document", { projectId, docId }))
      .content,
    after.content,
  );
  const compiled = await call(client, "overleaf_compile", { projectId });
  assert.equal(compiled.status, "success");
  assert.equal(compiled.input.snapshotPinned, false);
  assert.equal(compiled.input.observedDocumentVersions[0].docId, docId);
  assert.ok(
    compiled.outputFiles.some((f: { path: string }) => f.path === "output.pdf"),
  );
  // Resolve the same human author differently for delegated History entries.
  const historyResponse = await human.request(`/project/${projectId}/updates`);
  assert.equal(historyResponse.status, 200);
  assert.equal(
    historyResponse.headers.get("cache-control"),
    "private, no-store",
  );
  const history = await historyResponse.json();
  const agentUpdate = history.updates.find(
    (update: { meta: { origin?: { kind: string } } }) =>
      update.meta.origin?.kind === "agent",
  );
  assert.ok(agentUpdate, "MCP edit missing from History");
  assert.equal(agentUpdate.meta.users[0].displayName, "Your agent");
  assert.equal(agentUpdate.meta.users[0].id, `agent:${who.user.id}`);
  assert.equal(agentUpdate.meta.users[0].userId, who.user.id);
  const diff = await human.json(
    `/project/${projectId}/diff?${new URLSearchParams({
      from: String(agentUpdate.fromV),
      to: String(agentUpdate.toV),
      pathname: "main.tex",
    })}`,
  );
  let agentParts = 0;
  for (const part of diff.diff) {
    if (part.meta?.origin?.kind !== "agent") continue;
    agentParts++;
    assert.equal(part.meta.users[0].name, "Your agent");
    assert.equal(part.meta.users[0].userId, who.user.id);
  }
  assert.ok(agentParts, "Agent attribution missing from History diff");
  // Restore only our unique inserted span at the latest version.
  await call(client, "overleaf_edit_document", {
    projectId,
    docId,
    expectedVersion: after.version,
    oldText: replacement,
    newText: anchor,
    operationId: randomUUID(),
  });
  const readonly = await issue(human, {
    name: "Smoke: read only",
    projects: [projectId],
    actions: ["read"],
  });
  const reader = await connect(readonly.url);
  assert.ok(
    (
      await reader.callTool({
        name: "overleaf_compile",
        arguments: { projectId },
      })
    ).isError,
  );
  assert.ok(
    (await reader.callTool({ name: "overleaf_edit_document", arguments: args }))
      .isError,
  );
  const other = await issue(outsider, { name: "Smoke: outsider" });
  const stranger = await connect(other.url);
  assert.deepEqual(await call(stranger, "overleaf_list_projects"), []);
  assert.ok(
    (
      await stranger.callTool({
        name: "overleaf_get_project_tree",
        arguments: { projectId },
      })
    ).isError,
  );
  assert.equal(
    (await outsider.request(`/user/agent/links/${link.grant.id}/rotate`, {}))
      .status,
    404,
  );
  const rotated = await human.json(
    `/user/agent/links/${link.grant.id}/rotate`,
    {},
  );
  secrets.push(new URL(rotated.url).pathname.split(".").at(-1)!);
  assert.equal((await fetch(link.url, { method: "POST" })).status, 401);
  const renewed = await connect(rotated.url);
  assert.equal((await call(renewed, "overleaf_whoami")).user.id, who.user.id);
  await human.json(`/user/agent/links/${link.grant.id}/revoke`, {});
  assert.equal((await fetch(rotated.url, { method: "POST" })).status, 401);
  assert.equal(
    (
      await fetch(other.url, {
        method: "POST",
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  const state = await human.json("/user/agent/state");
  assert.ok(!JSON.stringify(state).includes("digest"));
  const logs = execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "overleaf",
      "sh",
      "-c",
      "cat /var/log/nginx/access.log /var/log/nginx/error.log /var/log/overleaf/web.log /var/log/overleaf/web-api.log",
    ],
    { maxBuffer: 50_000_000, encoding: "utf8" },
  );
  for (const secret of secrets)
    assert.ok(!logs.includes(secret), "A credential leaked to logs");
  console.log(
    JSON.stringify(
      {
        user: who.user.email,
        projectId,
        tools: 6,
        editing:
          "Chinese replacement, unsupported-emoji rejection, stale-version rejection and restoration passed",
        documentLockCAS: "passed",
        historyAttribution: "owner badge and diff tooltip metadata passed",
        compile: compiled.status,
        isolation: "passed",
        csrf: "passed",
        rotateAndRevoke: "passed",
        credentialLogScan: "passed",
      },
      null,
      2,
    ),
  );
} finally {
  for (const { browser, id } of issued)
    await browser.json(`/user/agent/links/${id}/revoke`, {}).catch(() => {});
  for (const client of clients) await client.close().catch(() => {});
}
