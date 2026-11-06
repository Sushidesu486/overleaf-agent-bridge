import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRuntime } from "../src/connector/runtime.js";
test("runtime presets keep existing configurations and select pinned adapters without stale arguments", () => {
  const existing = { agent: "opencode", args: ["acp"] };
  assert.deepEqual(resolveRuntime({}, existing), existing);
  const savedWithSecrets = {
    ...existing,
    credential: "old-bridge-key",
    mcpUrl: "old-url",
    connectionId: "old-id",
  };
  assert.deepEqual(resolveRuntime({}, savedWithSecrets), existing);
  assert.deepEqual(resolveRuntime({ runtime: "opencode" }), {
    ...existing,
    runtime: "opencode",
  });
  if (Number(process.versions.node.split(".")[0]) >= 22) {
    assert.deepEqual(resolveRuntime({ runtime: "codex" }, existing), {
      runtime: "codex",
      agent: "npx",
      args: ["--yes", "@agentclientprotocol/codex-acp@2.5.0"],
    });
    assert.deepEqual(resolveRuntime({ runtime: "claude" }, existing), {
      runtime: "claude",
      agent: "npx",
      args: ["--yes", "@agentclientprotocol/claude-agent-acp@0.101.0"],
    });
  }
  assert.deepEqual(resolveRuntime({ agent: "custom-acp" }, existing), {
    agent: "custom-acp",
    args: [],
  });
  assert.throws(() => resolveRuntime({ runtime: "typo" }));
  assert.throws(() => resolveRuntime({ runtime: "codex", agent: "custom" }));
  assert.throws(() => resolveRuntime({ args: ["acp"] }));
});
