import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AcpRuntime } from "../src/connector/acp.js";
import type {
  BridgeCommand,
  BridgeEvent,
} from "../extensions/agent-access/shared/chat.js";
const command = (
  runId: string,
  text: string,
): Extract<BridgeCommand, { type: "prompt" }> => ({
  type: "prompt",
  sessionId: "s",
  runId,
  projectId: "111111111111111111111111",
  text,
  context: [],
});
test("ACP queues consecutive turns, serializes concurrent permissions and emits one cancelled terminal event", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "overleaf-acp-")),
    events: { run: string; event: BridgeEvent }[] = [];
  let next: Promise<void> | undefined, runtime: AcpRuntime;
  runtime = new AcpRuntime({
    command: process.execPath,
    args: [resolve("test/fixtures/acp-agent.mjs")],
    cwd,
    mcpUrl: "http://localhost/mcp/p/test",
    emit: async (_session, run, event) => {
      events.push({ run, event });
      if (event.type === "permission")
        setTimeout(() => {
          void runtime.command({
            type: "permission",
            sessionId: "s",
            runId: run,
            permissionId: event.permission.id,
            optionId: "yes",
          });
        }, 20);
      // Deliver a new prompt before the preceding done POST has returned.
      if (event.type === "done" && run === "first")
        next = runtime.command(command("second", "permissions"));
    },
  });
  try {
    await runtime.command(command("first", "hello"));
    await next;
    assert.equal(
      events.filter((e) => e.run === "second" && e.event.type === "permission")
        .length,
      2,
    );
    assert.equal(
      events.filter((e) => e.run === "second" && e.event.type === "done")
        .length,
      1,
    );
    const pending = runtime.command(command("third", "wait"));
    for (let i = 0; i < 100 && !events.some((e) => e.run === "third"); i++)
      await new Promise((r) => setTimeout(r, 10));
    await runtime.command({ type: "cancel", sessionId: "s", runId: "third" });
    await pending;
    assert.equal(
      events.filter((e) => e.run === "third" && e.event.type === "done").length,
      1,
    );
    await runtime.command(command("fourth", "still connected"));
    assert.equal(
      events.filter((e) => e.run === "fourth" && e.event.type === "done")
        .length,
      1,
    );
  } finally {
    runtime.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("connection preparation creates one session with fixed tools/instructions and sends only subsequent prompts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "overleaf-session-"));
  const trace = join(cwd, "trace.jsonl");
  const oldTrace = process.env.ACP_FIXTURE_TRACE;
  process.env.ACP_FIXTURE_TRACE = trace;
  const prepared: string[] = [];
  const runtime = new AcpRuntime({
    command: process.execPath,
    args: [resolve("test/fixtures/acp-agent.mjs")],
    cwd,
    mcpUrl: "http://localhost/mcp/p/test",
    emit: async () => {},
    onSession: async (id) => {
      prepared.push(id);
    },
  });
  if (oldTrace === undefined) delete process.env.ACP_FIXTURE_TRACE;
  else process.env.ACP_FIXTURE_TRACE = oldTrace;
  try {
    const prepare = {
      type: "prepare" as const,
      sessionId: "s",
      projectId: "111111111111111111111111",
      context: [],
    };
    await Promise.all([runtime.command(prepare), runtime.command(prepare)]);
    const before = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    assert.equal(before.filter((x) => x.method === "session/new").length, 1);
    assert.equal(before.filter((x) => x.method === "session/prompt").length, 0);
    assert.deepEqual(prepared, ["s"]);
    await runtime.command(command("one", "first message"));
    await runtime.command(command("two", "second message"));
    const requests = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    const session = requests.find((x) => x.method === "session/new").params;
    assert.match(
      session.systemPrompt.content[0].text,
      /project 111111111111111111111111/,
    );
    assert.equal(session.systemPrompt.mode, "append");
    assert.ok(!JSON.stringify(session.systemPrompt).includes("/mcp/p/"));
    assert.equal(session.mcpServers[0].url, "http://localhost/mcp/p/test");
    const prompts = requests
      .filter((x) => x.method === "session/prompt")
      .map((x) => x.params);
    assert.equal(prompts[0].sessionId, prompts[1].sessionId);
    assert.deepEqual(
      prompts.map((x) => x.prompt[0].text),
      ["first message", "second message"],
    );
    await assert.rejects(
      runtime.prepare({ ...prepare, projectId: "222222222222222222222222" }),
      /项目不一致/,
    );
    await runtime.command({
      ...command("rebound", "continue after handoff"),
      bindingVersion: 2,
      context: [{ id: "old", role: "user", text: "Preserved history" }],
    });
    const rebound = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    assert.equal(
      rebound.filter((x) => x.method === "session/new").length,
      2,
      "returning to a connector must not reuse its stale runtime session",
    );
    assert.match(
      rebound.filter((x) => x.method === "session/prompt").at(-1).params
        .prompt[0].text,
      /Preserved history/,
    );
  } finally {
    runtime.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
