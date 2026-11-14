// Real Java/JGit transport against an isolated in-memory implementation of the
// agreed Snapshot API. Native CE compatibility is exercised by smoke-git.ts.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { createGitAccess } from "../extensions/git-access/access.mjs";
import { createGitApi } from "../extensions/git-access/http.mjs";

const jar = resolve(
  process.env.GIT_BRIDGE_JAR ??
    ".local/git-upstream/git-bridge/target/writelatex-git-bridge-1.0-SNAPSHOT-jar-with-dependencies.jar",
);
const directory = await mkdtemp(join(tmpdir(), "git-bridge-contract-"));
const projectId = "a".repeat(24),
  userId = "b".repeat(24);
const secret = randomBytes(32).toString("hex"),
  grants = new Map();
const access = createGitAccess({
  users: {
    async get() {
      return { name: "Test", email: "test@example.invalid" };
    },
    async role() {
      return "readAndWrite";
    },
  },
  store: {
    async getLink() {
      return { enabled: true };
    },
    async putGrant(g) {
      grants.set(g.id, g);
    },
    async getGrant(id) {
      return grants.get(id);
    },
    async touch() {},
    async revoke(id) {
      grants.get(id).revokedAt = new Date().toISOString();
    },
  },
});
const issued = await access.issue(userId, projectId, {
  name: "Git client",
  mode: "read",
  actor: "human",
});
const binary = randomBytes(
  Number(process.env.GIT_SMOKE_ATTACHMENT_BYTES ?? 50_000_000),
);
const versions = new Map([
  [1, [Buffer.from("中文 Git integration\n"), binary]],
  [2, [Buffer.from("中文 Git integration: live edit\n"), binary]],
]);
let version = 1,
  handler,
  java;
const api = createServer((req, res) => handler(req, res));
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${api.address().port}`;
const descriptors = (v) =>
  versions.get(v).map((data, index) => ({
    index,
    path: index ? "image.bin" : "main.tex",
    bytes: data.length,
  }));
handler = createGitApi({
  access,
  secret,
  internalUrl: apiUrl,
  snapshots: {
    async latest() {
      return {
        version,
        timestamp: "2026-01-01T00:00:00Z",
        author: null,
        files: descriptors(version),
      };
    },
    async read(_, v) {
      return { version: v, files: descriptors(v) };
    },
    async file(_, v, index) {
      const buffer = versions.get(v)[index];
      return { bytes: buffer.length, stream: Readable.from([buffer]) };
    },
  },
  onError(error) {
    if (error.status >= 500) console.error({ adapterError: error.name });
  },
});
const portProbe = createServer();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const port = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const bridgeUrl = `http://127.0.0.1:${port}`;
const config = {
  ...JSON.parse(await readFile("services/git-bridge/config.json", "utf8")),
  port,
  bindIp: "127.0.0.1",
  rootGitDirectory: join(directory, "repos"),
  apiBaseUrl: `${apiUrl}/api/v0`,
  oauth2Server: apiUrl,
  postbackBaseUrl: bridgeUrl,
  serviceName: "Test",
};
const configPath = join(directory, "config.json"),
  logPath = join(directory, "bridge.log"),
  askpass = join(directory, "askpass.sh");
await writeFile(configPath, JSON.stringify(config));
await writeFile(
  askpass,
  '#!/bin/sh\ncase "$1" in *Username*) printf "%s" git ;; *) printf "%s" "$OVERLEAF_TEST_GIT_TOKEN" ;; esac\n',
  { mode: 0o700 },
);
const log = await open(logPath, "w", 0o600);
const execute = promisify(execFile);
const git = (args, cwd = directory) =>
  execute("git", ["-c", "credential.helper=", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_ASKPASS: askpass,
      GIT_TERMINAL_PROMPT: "0",
      OVERLEAF_TEST_GIT_TOKEN: issued.token,
    },
    timeout: 120_000,
  });
try {
  java = spawn("java", ["-Xmx768m", "-jar", jar, configPath], {
    stdio: ["ignore", log.fd, log.fd],
    env: {
      ...process.env,
      GIT_BRIDGE_SERVICE_SECRET: secret,
      LOG_LEVEL: "INFO",
    },
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (java.exitCode !== null)
      throw new Error("Java bridge exited before listening");
    try {
      ready =
        (
          await fetch(
            `${bridgeUrl}/${projectId}/info/refs?service=git-upload-pack`,
          )
        ).status === 401;
    } catch {}
    if (ready) break;
    await setTimeout(200);
  }
  assert.ok(ready, "Java bridge did not start");
  await git([
    "clone",
    "--origin",
    "overleaf",
    `${bridgeUrl}/${projectId}`,
    "paper",
  ]);
  const paper = join(directory, "paper");
  assert.equal(
    await readFile(join(paper, "main.tex"), "utf8"),
    "中文 Git integration\n",
  );
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(paper, "image.bin")))
      .digest("hex"),
    createHash("sha256").update(binary).digest("hex"),
  );
  const head = (await git(["rev-parse", "HEAD"], paper)).stdout;
  await git(["fetch", "overleaf"], paper);
  assert.equal((await git(["rev-parse", "overleaf/main"], paper)).stdout, head);
  version = 2;
  await git(["pull", "--ff-only", "overleaf", "main"], paper);
  assert.equal(
    await readFile(join(paper, "main.tex"), "utf8"),
    "中文 Git integration: live edit\n",
  );
  await assert.rejects(git(["push", "overleaf", "HEAD:main"], paper));
  await assert.rejects(git(["ls-remote", `${bridgeUrl}/${"c".repeat(24)}`]));
  await access.revoke(userId, projectId, issued.id);
  await assert.rejects(git(["fetch", "overleaf"], paper));
  console.log(
    JSON.stringify({
      javaGitTransport: "passed",
      binaryBytes: binary.length,
      clone: true,
      repeatedFetch: true,
      pull: true,
      readOnlyPush: "denied",
      projectScope: "denied",
      revocation: "denied",
    }),
  );
} catch (error) {
  // Keep diagnostics private; bridge error messages can contain signed URLs.
  await writeFile(
    ".local/git-upstream/contract-failure.log",
    String(error) + "\n" + (await readFile(logPath, "utf8")),
    { mode: 0o600 },
  );
  throw new Error(
    "Git transport contract test failed; inspect the private contract-failure.log",
  );
} finally {
  java?.kill();
  if (java?.exitCode === null)
    await new Promise((resolve) => java.once("exit", resolve));
  await log.close();
  await new Promise((resolve) => api.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
