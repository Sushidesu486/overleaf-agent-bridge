import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OverleafClient } from "../src/overleaf.js";
import { Browser, origin } from "./lab-browser.js";

const users = JSON.parse(await readFile(".local/lab-users.json", "utf8"));
const browser = new Browser();
await browser.login(users[0]);
let projectId: string;
try {
  projectId = JSON.parse(
    await readFile(".local/compile-project.json", "utf8"),
  ).projectId;
} catch {
  const native = new OverleafClient({
    baseUrl: origin,
    ...users[0],
    allowedProjectIds: [],
  });
  await native.login();
  projectId = await native.createProject("MCP compile diagnostics fixture");
  await writeFile(
    ".local/compile-project.json",
    JSON.stringify({ projectId }),
    { mode: 0o600 },
  );
}
const link = await browser.json("/user/agent/links", {
  name: "Smoke: compile diagnostics",
  projects: [projectId],
});
const client = new Client({ name: "compile-smoke", version: "1.0" });
const injected =
  "\\overleafAgentUndefinedProbe\n\\input{overleaf-agent-missing-file}\n";
const chinese = "中文编译诊断测试\n";
const anchor = "\\end{document}";
let docId: string | undefined;
async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool(
    { name, arguments: { projectId, ...args } },
    undefined,
    { timeout: 120_000 },
  );
  const value = JSON.parse(
    (response.content as Array<{ text: string }>)[0].text,
  );
  assert.ok(!response.isError, `${name}: ${value.code} ${value.message}`);
  return value;
}
async function edit(oldText: string, newText: string) {
  const doc = await call("overleaf_read_document", { docId });
  await call("overleaf_edit_document", {
    docId,
    oldText,
    newText,
    expectedVersion: doc.version,
    operationId: randomUUID(),
  });
}
async function compile() {
  const result = await call("overleaf_compile");
  if (result.status !== "too-recently-compiled") return result;
  await delay(1100);
  return call("overleaf_compile");
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(link.url)));
  const tree = await call("overleaf_get_project_tree");
  docId = tree.rootDocId;
  // This dedicated fixture can recover its own marker after an interrupted run.
  let original = await call("overleaf_read_document", { docId });
  for (const marker of [injected, chinese]) {
    if (original.content.includes(marker)) {
      await edit(marker, "");
      original = await call("overleaf_read_document", { docId });
    }
  }
  const line = original.content
    .slice(0, original.content.indexOf(anchor))
    .split("\n").length;
  await edit(anchor, injected + anchor);
  const failed = await compile();
  assert.equal(failed.status, "failure");
  assert.match(
    failed.diagnostics?.firstError?.message || "",
    /Undefined control sequence/,
    JSON.stringify({
      log: failed.log,
      diagnostics: failed.diagnostics,
      outputFiles: failed.outputFiles,
    }),
  );
  assert.equal(failed.diagnostics.firstError.docId, docId);
  assert.equal(failed.diagnostics.firstError.line, line);
  assert.equal(failed.compiler, tree.compiler);
  assert.equal(failed.nextAction.type, "repair");
  assert.equal(failed.log.available, true);
  const first = await call("overleaf_get_compile_log", {
    buildId: failed.buildId,
    limit: 120,
  });
  assert.equal(first.nextOffset, 120);
  const rest = await call("overleaf_get_compile_log", {
    buildId: failed.buildId,
    offset: first.nextOffset,
    limit: 32_000,
  });
  assert.match(first.text + rest.text, /overleafAgentUndefinedProbe/);
  const wrongBuild = await client.callTool({
    name: "overleaf_get_compile_log",
    arguments: { projectId, buildId: "dead-beef" },
  });
  assert.equal(wrongBuild.isError, true);
  await edit(injected, "");
  const success = await compile();
  assert.equal(success.status, "success");
  assert.equal(success.diagnostics.firstError, null);
  assert.equal(success.log.available, true);
  assert.notEqual(success.buildId, failed.buildId);
  const oldLog = await call("overleaf_get_compile_log", {
    buildId: failed.buildId,
    limit: 32_000,
  });
  assert.match(oldLog.text, /overleafAgentUndefinedProbe/);
  const newLog = await call("overleaf_get_compile_log", {
    buildId: success.buildId,
    limit: 32_000,
  });
  assert.ok(!newLog.text.includes("overleafAgentUndefinedProbe"));
  assert.equal(
    (await call("overleaf_read_document", { docId })).content,
    original.content,
  );
  let unicodeError: string | null = null;
  if (tree.compiler === "pdflatex") {
    await edit(anchor, chinese + anchor);
    const unicode = await compile();
    assert.equal(unicode.status, "failure");
    assert.match(unicode.diagnostics.firstError.message, /Unicode character/);
    assert.equal(unicode.diagnostics.firstError.docId, docId);
    unicodeError = unicode.diagnostics.firstError.message;
    await edit(chinese, "");
    assert.equal((await compile()).status, "success");
  }
  console.log(
    JSON.stringify({
      status: "passed",
      projectId,
      compiler: tree.compiler,
      firstError: failed.diagnostics.firstError,
      repaired: success.status,
      unicodeError,
      paginatedLog: true,
      distinctBuildLogs: true,
    }),
  );
} finally {
  try {
    if (docId) {
      for (const marker of [injected, chinese]) {
        const doc = await call("overleaf_read_document", { docId });
        if (doc.content.includes(marker)) await edit(marker, "");
      }
    }
  } finally {
    await browser.json(`/user/agent/links/${link.grant.id}/revoke`, {});
    await client.close();
  }
}
