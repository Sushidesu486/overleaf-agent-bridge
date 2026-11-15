// Real Java/JGit transport against an isolated in-memory implementation of the
// agreed Snapshot API. Native CE compatibility is exercised by smoke-git.ts.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  open,
  mkdir,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { createGitAccess } from "../extensions/git-access/access.mjs";
import { createGitApi } from "../extensions/git-access/http.mjs";
import { createPushStaging } from "../extensions/git-access/push-staging.mjs";

const jar = resolve(
  process.env.GIT_BRIDGE_JAR ??
    ".local/git-upstream/git-bridge/target/writelatex-git-bridge-1.0-SNAPSHOT-jar-with-dependencies.jar",
);
// Jetty rejects resource aliases; macOS temp paths may resolve through /var.
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "git-bridge-contract-")),
);
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
  [
    1,
    new Map([
      ["main.tex", Buffer.from("中文 Git integration\n")],
      ["image.bin", binary],
      ["delete.tex", Buffer.from("Delete this file.\n")],
    ]),
  ],
  [
    2,
    new Map([
      ["main.tex", Buffer.from("中文 Git integration: live edit\n")],
      ["image.bin", binary],
      ["delete.tex", Buffer.from("Delete this file.\n")],
    ]),
  ],
]);
let version = 1,
  handler,
  java;
const api = createServer((req, res) => handler(req, res));
await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
const apiUrl = `http://127.0.0.1:${api.address().port}`;
const descriptors = (v) =>
  [...versions.get(v)].map(([path, data], index) => ({
    index,
    path,
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.length,
  }));
const snapshots = {
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
    const buffer = [...versions.get(v).values()][index];
    return { bytes: buffer.length, stream: Readable.from([buffer]) };
  },
};
let allowPush = false;
let stagedPush;
let callbackStatus;
handler = createGitApi({
  access,
  secret,
  internalUrl: apiUrl,
  snapshots,
  async push(ctx, body, reauthorize) {
    assert.ok(allowPush);
    if (body.latestVerId !== version) return { code: "outOfDate" };
    const staging = createPushStaging({
      root: join(directory, "staged"),
      bridgeUrl,
      snapshots,
    });
    const operationId = randomUUID();
    stagedPush = await staging.stage(ctx.projectId, operationId, body);
    await reauthorize();
    const next = new Map();
    for (const file of stagedPush.files)
      next.set(
        file.path,
        await readFile(
          staging.filePath(ctx.projectId, operationId, file.index),
        ),
      );
    // This fixture models the Snapshot API only. It deliberately does not
    // exercise native CE writes, browser coordination or crash recovery.
    versions.set(++version, next);
    const callback = await fetch(body.postbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "upToDate", latestVerId: version }),
    });
    callbackStatus = callback.status;
    await staging.discard(ctx.projectId, operationId);
    return { code: "accepted" };
  },
  onError(error) {
    if (error.status >= 500)
      console.error({ adapterError: error.name, code: error.code });
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
await mkdir(join(config.rootGitDirectory, ".wlgb/atts"), { recursive: true });
await writeFile(configPath, JSON.stringify(config));
await writeFile(
  askpass,
  '#!/bin/sh\ncase "$1" in *Username*) printf "%s" git ;; *) printf "%s" "$OVERLEAF_TEST_GIT_TOKEN" ;; esac\n',
  { mode: 0o700 },
);
const log = await open(logPath, "w", 0o600);
const execute = promisify(execFile);
let gitToken = issued.token;
const git = (args, cwd = directory) =>
  execute("git", ["-c", "credential.helper=", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_ASKPASS: askpass,
      GIT_TERMINAL_PROMPT: "0",
      OVERLEAF_TEST_GIT_TOKEN: gitToken,
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
  const writeGrant = await access.issue(userId, projectId, {
    name: "Push contract",
    mode: "write",
    actor: "agent",
  });
  gitToken = writeGrant.token;
  allowPush = true;
  await writeFile(join(paper, "main.tex"), "中文 Git push\n");
  await mkdir(join(paper, "chapters"));
  await writeFile(join(paper, "chapters/中文.tex"), "Nested Chinese file.\n");
  const newBinary = randomBytes(binary.length);
  await writeFile(join(paper, "new-image.bin"), newBinary);
  await rm(join(paper, "delete.tex"));
  await git(["add", "-A"], paper);
  await git(
    [
      "-c",
      "user.name=Git test",
      "-c",
      "user.email=git@example.invalid",
      "commit",
      "-m",
      "Apply complete candidate tree",
    ],
    paper,
  );
  const pushedHead = (await git(["rev-parse", "HEAD"], paper)).stdout;
  await git(["push", "overleaf", "HEAD:main"], paper);
  assert.equal(callbackStatus, 200);
  assert.deepEqual(stagedPush.deleted, ["delete.tex"]);
  assert.equal(
    stagedPush.files.find((f) => f.path === "image.bin").changed,
    false,
  );
  assert.equal(
    stagedPush.files.find((f) => f.path === "new-image.bin").bytes,
    newBinary.length,
  );
  await git(["clone", `${bridgeUrl}/${projectId}`, "round-trip"]);
  const cloned = join(directory, "round-trip");
  assert.equal((await git(["rev-parse", "HEAD"], cloned)).stdout, pushedHead);
  assert.equal(
    await readFile(join(cloned, "main.tex"), "utf8"),
    "中文 Git push\n",
  );
  assert.equal(
    await readFile(join(cloned, "chapters/中文.tex"), "utf8"),
    "Nested Chinese file.\n",
  );
  assert.deepEqual(await readFile(join(cloned, "new-image.bin")), newBinary);
  assert.deepEqual(await readFile(join(cloned, "image.bin")), binary);
  await assert.rejects(readFile(join(cloned, "delete.tex")), {
    code: "ENOENT",
  });
  await access.revoke(userId, projectId, writeGrant.id);
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
      pushSnapshotApiFixture: "passed",
      pushBytes: newBinary.length,
      commitId: "preserved",
      nativePush: "not tested by this fixture",
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
