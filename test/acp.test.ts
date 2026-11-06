import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
