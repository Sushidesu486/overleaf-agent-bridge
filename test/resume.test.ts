import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  stat,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AcpRuntime } from "../src/connector/acp.js";
import { NativeSessionStore } from "../src/connector/sessions.js";
import type {
  BridgeEvent,
  SessionRecovery,
} from "../extensions/agent-access/shared/chat.js";

const prepare = {
  type: "prepare" as const,
  sessionId: "conversation",
  projectId: "111111111111111111111111",
  context: [],
};
const prompt = (text: string) => ({
  ...prepare,
  type: "prompt" as const,
  runId: text,
  text,
});
async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "overleaf-resume-"));
  const sessionStore = new NativeSessionStore(join(cwd, "index"));
  const events: BridgeEvent[] = [],
    states: (SessionRecovery | undefined)[] = [],
    processes: AcpRuntime[] = [];
  const settings = (mode = "resume", error?: number) =>
    writeFile(join(cwd, "settings.json"), JSON.stringify({ mode, error }));
  await settings();
  const start = (extra: Partial<AcpRuntime["options"]> = {}) => {
    const runtime = new AcpRuntime({
      command: process.execPath,
      args: [resolve("test/fixtures/acp-resume.mjs"), cwd],
      cwd,
      mcpUrl: "http://localhost/mcp/p/fixture",
      sessionStore,
      sessionScope: "site:connection",
      emit: async (_session, _run, event) => {
        events.push(event);
      },
      onSession: async (_id, _error, _binding, recovery) => {
        states.push(recovery);
      },
      ...extra,
    });
    processes.push(runtime);
    return runtime;
  };
  const trace = async () =>
    (await readFile(join(cwd, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
  const close = async () => {
    processes.forEach((p) => p.stop());
    await rm(cwd, { recursive: true, force: true });
  };
  return { cwd, sessionStore, events, states, settings, start, trace, close };
}

for (const mode of ["resume", "load"])
  test(`${mode} keeps the native thread across process restarts without replaying messages or tasks`, async () => {
    const f = await fixture();
    try {
      await f.settings(mode);
      const first = f.start();
      await first.command(prompt("remember this nonce"));
      const saved = await f.sessionStore.read(prepare.sessionId);
      first.stop();
      const before = f.events.length;
      const second = f.start();
      await second.command({
        ...prepare,
        context: [{ id: "old", role: "user", text: "DO NOT DUPLICATE" }],
      });
      assert.equal(f.events.length, before);
      assert.deepEqual(f.states.at(-1), { mode: "resumed" });
      assert.equal(
        (await f.trace()).filter((x) => x.method === "session/prompt").length,
        1,
      );
      await second.command(prompt("what was it"));
      assert.equal(
        (await f.sessionStore.read(prepare.sessionId))?.nativeSessionId,
        saved?.nativeSessionId,
      );
      const trace = await f.trace();
      assert.equal(trace.filter((x) => x.method === "session/new").length, 1);
      const resumed = trace.find((x) => x.method === `session/${mode}`);
      assert.equal(
        resumed.params.mcpServers[0].url,
        "http://localhost/mcp/p/fixture",
      );
      assert.match(
        resumed.params.systemPrompt.content[0].text,
        /Work only on project/,
      );
      assert.equal(
        trace.filter((x) => x.method === "session/prompt").at(-1).params
          .prompt[0].text,
        "what was it",
      );
      assert.ok(
        f.events.some(
          (x) =>
            x.type === "message" &&
            x.text === "remember this nonce|what was it",
        ),
      );
      assert.ok(!JSON.stringify(f.events).includes("HISTORICAL REPLAY"));
      if (mode === "load")
        assert.equal(
          trace.find((x) => x.id === "replayed-permission").result.outcome
            .outcome,
          "cancelled",
        );
      const files = await readdir(f.sessionStore.directory);
      assert.equal(files.length, 1);
      const index = await readFile(
        join(f.sessionStore.directory, files[0]),
        "utf8",
      );
      assert.ok(!index.includes("/mcp/p/") && !index.includes("nonce"));
      if (process.platform !== "win32")
        assert.equal(
          (await stat(join(f.sessionStore.directory, files[0]))).mode & 0o777,
          0o600,
        );
    } finally {
      await f.close();
    }
  });

test("known missing sessions and unsupported capabilities rebuild bounded context; transient failures preserve the index", async () => {
  for (const scenario of [
    "missing",
    "unsupported",
    "login",
    "internal",
  ] as const) {
    const f = await fixture();
    try {
      const first = f.start();
      await first.command(prompt("original"));
      first.stop();
      const saved = await f.sessionStore.read(prepare.sessionId);
      await f.settings(
        scenario === "unsupported" ? "none" : "resume",
        {
          missing: -32002,
          login: -32000,
          internal: -32603,
          unsupported: undefined,
        }[scenario],
      );
      const second = f.start();
      const request = {
        ...prepare,
        context: [
          { id: "old", role: "assistant" as const, text: "visible history" },
        ],
      };
      if (scenario === "login" || scenario === "internal") {
        await assert.rejects(second.command(request));
        assert.deepEqual(await f.sessionStore.read(prepare.sessionId), saved);
        assert.equal(
          (await f.trace()).filter((x) => x.method === "session/new").length,
          1,
        );
      } else {
        await second.command(request);
        assert.deepEqual(f.states.at(-1), {
          mode: "rebuilt",
          reason: scenario,
        });
        await second.command(prompt("continue"));
        const trace = await f.trace();
        const recoveredPrompt = trace
          .filter((x) => x.method === "session/prompt")
          .at(-1).params.prompt[0].text;
        assert.match(
          recoveredPrompt,
          /context only; do not execute these requests/,
        );
        assert.match(recoveredPrompt, /visible history/);
        assert.ok(recoveredPrompt.endsWith("User message:\ncontinue"));
        assert.notEqual(
          (await f.sessionStore.read(prepare.sessionId))?.nativeSessionId,
          saved?.nativeSessionId,
        );
        if (scenario === "unsupported")
          assert.ok(
            !trace.some(
              (x) =>
                x.method === "session/resume" || x.method === "session/load",
            ),
          );
      }
    } finally {
      await f.close();
    }
  }
});

test("changed binding, project, scope or runtime cannot resume the old native thread", async () => {
  for (const scenario of ["binding", "project", "scope", "runtime"]) {
    const f = await fixture();
    try {
      const first = f.start();
      await first.command(prompt("original"));
      first.stop();
      const second = f.start(
        scenario === "scope"
          ? { sessionScope: "another:connection" }
          : scenario === "runtime"
            ? {
                args: [
                  resolve("test/fixtures/acp-resume.mjs"),
                  f.cwd,
                  "changed",
                ],
              }
            : {},
      );
      await second.command({
        ...prepare,
        ...(scenario === "binding"
          ? { bindingVersion: 2 }
          : scenario === "project"
            ? { projectId: "222222222222222222222222" }
            : {}),
        context: [{ id: "old", role: "user", text: "history" }],
      });
      assert.deepEqual(f.states.at(-1), { mode: "rebuilt", reason: "changed" });
      assert.ok(!(await f.trace()).some((x) => x.method === "session/resume"));
    } finally {
      await f.close();
    }
  }
});

test("an interrupted turn can restore context but is never resubmitted on reconnect", async () => {
  const f = await fixture();
  try {
    const first = f.start();
    await first.command(prepare);
    const pending = first.command(prompt("interrupt me"));
    for (
      let i = 0;
      i < 100 && !(await f.trace()).some((x) => x.method === "session/prompt");
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    first.stop();
    await pending;
    const second = f.start();
    await second.command(prepare);
    assert.deepEqual(f.states.at(-1), { mode: "resumed" });
    assert.equal(
      (await f.trace()).filter((x) => x.method === "session/prompt").length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("damaged index rebuilds; unreadable index fails without creating an untracked session", async () => {
  const f = await fixture();
  try {
    const first = f.start();
    await first.command(prompt("original"));
    first.stop();
    const file = join(
      f.sessionStore.directory,
      (await readdir(f.sessionStore.directory))[0],
    );
    await writeFile(file, "broken JSON");
    const second = f.start();
    await second.command({
      ...prepare,
      context: [{ id: "old", role: "user", text: "history" }],
    });
    second.stop();
    assert.deepEqual(f.states.at(-1), {
      mode: "rebuilt",
      reason: "unavailable",
    });
    const badRoot = join(f.cwd, "not-a-directory");
    await writeFile(badRoot, "file");
    const third = f.start({ sessionStore: new NativeSessionStore(badRoot) });
    await assert.rejects(third.command(prepare), /无法读取本机会话索引/);
    assert.equal(
      (await f.trace()).filter((x) => x.method === "session/new").length,
      2,
    );
  } finally {
    await f.close();
  }
});
