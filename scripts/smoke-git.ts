import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Browser } from "./lab-browser.js";

const origin = process.env.OVERLEAF_LAB_ORIGIN ?? "http://localhost:18084";
const accountPath =
  process.env.OVERLEAF_LAB_ACCOUNT ?? ".local/git-check/account.json";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
assert.equal((await stat(accountPath)).mode & 0o077, 0);
const account = JSON.parse(await readFile(accountPath, "utf8"));
assert.ok(account.email.endsWith("@example.invalid"));
const browser = new Browser(origin);
await browser.login(account);
const { project_id: projectId } = await browser.json("/project/new", {
  projectName: `Git integration ${new Date().toISOString()}`,
  template: "example",
});
const base = `/user/git/projects/${projectId}`;
const grants: string[] = [];
const temp = await mkdtemp(join(tmpdir(), "overleaf-git-smoke-"));
const execute = promisify(execFile);
const askpass = join(temp, "askpass.sh");
await writeFile(
  askpass,
  '#!/bin/sh\ncase "$1" in *Username*) printf "%s" git ;; *) printf "%s" "$OVERLEAF_TEST_GIT_TOKEN" ;; esac\n',
  { mode: 0o700 },
);
const link = await browser.json("/user/agent/links", {
  name: "Git smoke",
  projects: [projectId],
  actions: ["read", "edit", "compile"],
});
const client = new Client({ name: "git-smoke", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(link.url)));
async function mcp(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool(
    { name, arguments: { projectId, ...args } },
    undefined,
    { timeout: 180_000 },
  );
  const data = JSON.parse((result.content as Array<{ text: string }>)[0].text);
  assert.ok(!result.isError, `${name}: ${data.code ?? "failed"}`);
  return data;
}
let token = "";
async function git(args: string[], cwd = temp) {
  return execute("git", ["-c", "credential.helper=", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_ASKPASS: askpass,
      GIT_TERMINAL_PROMPT: "0",
      OVERLEAF_TEST_GIT_TOKEN: token,
    },
    timeout: 180_000,
    maxBuffer: 1_000_000,
  });
}
try {
  await browser.json(`${base}/enabled`, { enabled: true });
  const issued = await browser.json(`${base}/tokens`, {
    name: "Clone/pull test",
    mode: "read",
    actor: "agent",
  });
  token = issued.token;
  grants.push(issued.id);
  const bytes = Number(process.env.GIT_SMOKE_ATTACHMENT_BYTES ?? "50000000");
  const image = randomBytes(bytes);
  await mcp("overleaf_create_file", {
    name: "figure.bin",
    encoding: "base64",
    content: image.toString("base64"),
    operationId: randomUUID(),
  });
  const content =
    "% 中文 Git 协作\n\\section{Local agents}\nGit transfers files; MCP compiles the project.\n";
  const created = await mcp("overleaf_create_file", {
    name: "git-notes.tex",
    content,
    operationId: randomUUID(),
  });
  const remote = `${origin}/git/${projectId}`;
  await git([
    "clone",
    "--origin",
    "overleaf",
    "-c",
    "credential.useHttpPath=true",
    remote,
    "paper",
  ]);
  const paper = join(temp, "paper");
  assert.equal(await readFile(join(paper, "git-notes.tex"), "utf8"), content);
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(paper, "figure.bin")))
      .digest("hex"),
    createHash("sha256").update(image).digest("hex"),
  );
  const head = (await git(["rev-parse", "HEAD"], paper)).stdout.trim();
  await git(["fetch", "overleaf"], paper);
  assert.equal(
    (await git(["rev-parse", "overleaf/main"], paper)).stdout.trim(),
    head,
  );
  const doc = await mcp("overleaf_read_document", { docId: created.result.id });
  await mcp("overleaf_edit_document", {
    docId: created.result.id,
    expectedVersion: doc.version,
    oldText: "Local agents",
    newText: "Local agents and live collaboration",
    operationId: randomUUID(),
  });
  await git(["pull", "--ff-only", "overleaf", "main"], paper);
  assert.match(
    await readFile(join(paper, "git-notes.tex"), "utf8"),
    /Local agents and live collaboration/,
  );
  await writeFile(
    join(paper, "attempt.tex"),
    "Read-only tokens cannot push.\n",
  );
  await git(["add", "attempt.tex"], paper);
  await git(
    [
      "-c",
      "user.name=Git test",
      "-c",
      "user.email=git-test@example.invalid",
      "commit",
      "-m",
      "Read-only denial",
    ],
    paper,
  );
  await assert.rejects(git(["push", "overleaf", "HEAD:main"], paper));
  await assert.rejects(git(["ls-remote", `${origin}/git/${"a".repeat(24)}`]));
  await browser.json(`${base}/tokens/${issued.id}/revoke`, {});
  await assert.rejects(git(["fetch", "overleaf"], paper));
  console.log(
    JSON.stringify({
      projectId,
      clone: true,
      unchangedFetch: true,
      liveEditPull: true,
      attachmentBytes: bytes,
      attachmentHash: "matched",
      readOnlyPush: "denied",
      revokedToken: "denied",
    }),
  );
} finally {
  for (const id of grants)
    await browser.json(`${base}/tokens/${id}/revoke`, {}).catch(() => {});
  await browser
    .json(`/user/agent/links/${link.grant.id}/revoke`, {})
    .catch(() => {});
  await client.close().catch(() => {});
  await rm(temp, { recursive: true, force: true });
}
