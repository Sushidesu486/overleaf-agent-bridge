import { createInterface } from "node:readline";
import {
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
const root = process.argv[2];
const settings = JSON.parse(readFileSync(join(root, "settings.json")));
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  appendFileSync(join(root, "trace.jsonl"), line + "\n");
  if (m.method === "initialize") {
    send({
      id: m.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "resume-fixture", version: "1" },
        agentCapabilities: {
          mcpCapabilities: { http: true },
          loadSession: settings.mode === "load",
          sessionCapabilities: {
            systemPrompt: {},
            ...(settings.mode === "resume" ? { resume: {} } : {}),
          },
        },
      },
    });
  } else if (m.method === "session/new") {
    const sessionId = randomUUID();
    writeFileSync(join(root, sessionId + ".json"), "[]");
    send({ id: m.id, result: { sessionId } });
  } else if (m.method === "session/resume" || m.method === "session/load") {
    const code =
      settings.error ||
      (!existsSync(join(root, m.params.sessionId + ".json")) ? -32002 : 0);
    if (code)
      return send({
        id: m.id,
        error: {
          code,
          message: code === -32000 ? "Login required" : "Session setup failed",
        },
      });
    if (m.method === "session/load") {
      send({
        method: "session/update",
        params: {
          sessionId: m.params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "HISTORICAL REPLAY" },
          },
        },
      });
      send({
        id: "replayed-permission",
        method: "session/request_permission",
        params: {
          sessionId: m.params.sessionId,
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
      });
    }
    send({ id: m.id, result: {} });
  } else if (m.method === "session/prompt") {
    const file = join(root, m.params.sessionId + ".json");
    const messages = JSON.parse(readFileSync(file));
    messages.push(m.params.prompt[0].text);
    writeFileSync(file, JSON.stringify(messages));
    if (m.params.prompt[0].text === "interrupt me") return;
    send({
      method: "session/update",
      params: {
        sessionId: m.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: messages.join("|") },
        },
      },
    });
    send({ id: m.id, result: { stopReason: "end_turn" } });
  }
});
