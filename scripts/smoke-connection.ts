import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Browser, origin } from "./lab-browser.js";
import type {
  ChatSession,
  PublicConnection,
} from "../extensions/agent-access/shared/chat.js";
const browser = new Browser();
await browser.login(
  JSON.parse(await readFile(".local/lab-users.json", "utf8"))[0],
);
const { projectId } = JSON.parse(
  await readFile(".local/compile-project.json", "utf8"),
);
const { projects } = await browser.json("/user/agent/state");
const projectName = projects.find(
  (p: { id: string }) => p.id === projectId,
).name;
const otherProject = projects.find(
  (p: { id: string }) => p.id !== projectId,
).id;
const directory = resolve(".local/connection-smoke");
await mkdir(directory, { recursive: true, mode: 0o700 });
const pairing = await browser.json("/user/agent/chat/pairings", {
  name: "Connection lifecycle smoke",
  projects: [projectId],
  actions: ["read"],
});
await writeFile(`${directory}/pair-code`, pairing.code, { mode: 0o600 });
const download = await browser.request("/user/agent/connector");
assert.equal(download.status, 200);
await writeFile(`${directory}/connector.mjs`, await download.text(), {
  mode: 0o600,
});
let child: ChildProcess | undefined,
  output = "",
  connectionId: string | undefined;
async function until<T>(
  get: () => Promise<T | false | undefined>,
  message: string,
): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await get();
    if (value) return value;
    await delay(200);
  }
  throw new Error(message);
}
function start(pair: boolean) {
  output = "";
  child = spawn(
    process.execPath,
    [
      `${directory}/connector.mjs`,
      "--config",
      `${directory}/config.json`,
      ...(pair
        ? [
            "--server",
            origin,
            "--pair",
            "--pair-code-file",
            `${directory}/pair-code`,
            "--agent",
            process.execPath,
            "--agent-arg",
            resolve("test/fixtures/acp-agent.mjs"),
          ]
        : []),
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout?.on("data", (chunk) => {
    output = (output + chunk).slice(-50_000);
  });
  // Diagnostics can contain runtime data; don't print them in the smoke output.
  child.stderr?.resume();
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const current = child;
  const exited = new Promise<void>((done) =>
    current.once("exit", () => done()),
  );
  current.kill("SIGTERM");
  const timer = setTimeout(() => current.kill("SIGKILL"), 8000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
    child = undefined;
  }
}
async function connections(project = projectId): Promise<PublicConnection[]> {
  return browser.json(
    `/user/agent/chat/connections?projectId=${project}&includeOthers=1`,
  );
}
async function ready(create = false): Promise<ChatSession> {
  await until(
    async () =>
      (await connections()).find((c) => c.id === connectionId)?.online,
    "connector did not become online",
  );
  let createdId: string | undefined;
  if (create) {
    const before = await browser.json(
      `/user/agent/chat/sessions?projectId=${projectId}`,
    );
    assert.ok(
      !before.some(
        (s: { connectionId: string }) => s.connectionId === connectionId,
      ),
      "pairing must not create visible empty conversations",
    );
    createdId = (
      await browser.json("/user/agent/chat/sessions", {
        projectId,
        connectionId,
      })
    ).id;
  }
  return until(async () => {
    const list = await browser.json(
      `/user/agent/chat/sessions?projectId=${projectId}`,
    );
    const entry = list.find(
      (s: { connectionId: string }) => s.connectionId === connectionId,
    );
    if (!entry && !createdId) return;
    const session = await browser.json(
      `/user/agent/chat/sessions/${createdId || entry.id}`,
    );
    return session.agentState === "ready" && session;
  }, "project session did not become ready");
}
async function prompt(sessionId: string, text: string) {
  await browser.json(`/user/agent/chat/sessions/${sessionId}/messages`, {
    text,
  });
  return until(async () => {
    const session = await browser.json(
      `/user/agent/chat/sessions/${sessionId}`,
    );
    return session.runId === null && session.status === "idle" && session;
  }, "prompt did not finish");
}
try {
  start(true);
  connectionId = await until(async () => {
    try {
      const id = JSON.parse(
        await readFile(`${directory}/config.json`, "utf8"),
      ).connectionId;
      return (
        (await connections()).some(
          (c) => c.id === id && c.pairingId === pairing.code.split(".")[0],
        ) && id
      );
    } catch {
      return false;
    }
  }, "pairing profile was not saved");
  const first = await ready(true);
  assert.ok(output.includes("连接已确认"));
  assert.ok(output.includes(projectName));
  assert.ok(output.includes(`${origin}/project/${projectId}`));
  const publicConnection = (await connections()).find(
    (c) => c.id === connectionId,
  )!;
  assert.equal(publicConnection.pairingId, pairing.code.split(".")[0]);
  const other = (await connections(otherProject)).find(
    (c) => c.id === connectionId,
  )!;
  assert.equal(other.online, true);
  assert.equal(other.availableInProject, false);
  const legacy = await browser.json(
    `/user/agent/chat/connections?projectId=${otherProject}`,
  );
  assert.ok(!legacy.some((c: PublicConnection) => c.id === connectionId));
  const answered = await prompt(first.id, "connection-smoke-one");
  assert.equal(
    answered.messages.filter((m: { role: string }) => m.role === "user").length,
    1,
  );
  await stop();
  await until(
    async () =>
      !(await connections()).find((c) => c.id === connectionId)?.online,
    "server kept a stopped connector online",
  );
  start(false);
  const recovered = await ready();
  assert.equal(recovered.id, first.id);
  assert.equal(
    recovered.messages.filter((m) => m.role === "user").length,
    1,
    "reconnect must not replay the prompt",
  );
  const second = await prompt(recovered.id, "connection-smoke-two");
  assert.equal(
    second.messages.filter((m: { role: string }) => m.role === "user").length,
    2,
  );
  const renamed = await browser.json(
    `/user/agent/chat/sessions/${second.id}/settings`,
    {
      revision: second.revision,
      title: "Conversation [smoke]",
    },
  );
  const searched = await browser.json(
    `/user/agent/chat/sessions?projectId=${projectId}&search=${encodeURIComponent("[smoke]")}`,
  );
  assert.ok(searched.some((s: ChatSession) => s.id === second.id));
  const after = await browser.json(
    `/user/agent/chat/sessions?projectId=${projectId}&before=${encodeURIComponent(renamed.updatedAt)}&beforeId=${renamed.id}`,
  );
  assert.ok(!after.some((s: ChatSession) => s.id === second.id));
  const archived = await browser.json(
    `/user/agent/chat/sessions/${second.id}/settings`,
    {
      revision: renamed.revision,
      archived: true,
    },
  );
  assert.equal(
    (
      await browser.request(`/user/agent/chat/sessions/${second.id}/messages`, {
        text: "must not run",
      })
    ).status,
    409,
  );
  const activeHistory = await browser.json(
    `/user/agent/chat/sessions?projectId=${projectId}`,
  );
  assert.ok(!activeHistory.some((s: ChatSession) => s.id === second.id));
  const archivedHistory = await browser.json(
    `/user/agent/chat/sessions?projectId=${projectId}&archived=1`,
  );
  assert.ok(archivedHistory.some((s: ChatSession) => s.id === second.id));
  const restored = await browser.json(
    `/user/agent/chat/sessions/${second.id}/settings`,
    {
      revision: archived.revision,
      archived: false,
    },
  );
  assert.deepEqual(restored.messages, second.messages);
  const config = JSON.parse(await readFile(`${directory}/config.json`, "utf8"));
  for (const secret of [pairing.code, config.credential, config.mcpUrl])
    assert.ok(!output.includes(secret));
  console.log(
    JSON.stringify({
      passed: true,
      projectId,
      online: true,
      sessionReady: true,
      projectScopeVisible: true,
      stoppedOffline: true,
      reconnect: true,
      replayed: false,
      prompts: 2,
      downloadedConnector: true,
      conversationManagement: true,
    }),
  );
} finally {
  await stop();
  const created = (await connections()).find(
    (c) => c.pairingId === pairing.code.split(".")[0],
  );
  if (created)
    await browser.json(`/user/agent/chat/connections/${created.id}/revoke`, {});
  await rm(`${directory}/config.json`, { force: true });
  await rm(`${directory}/pair-code`, { force: true });
}
