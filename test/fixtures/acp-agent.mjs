import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const sessions = new Map(),
  pending = new Map(),
  waiting = new Map();
let next = 1000;
const send = (value) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const update = (sessionId, update) =>
  send({ method: "session/update", params: { sessionId, update } });
const request = (method, params) =>
  new Promise((resolve) => {
    const id = next++;
    pending.set(id, resolve);
    send({ id, method, params });
  });
async function handle(m) {
  if (process.env.ACP_FIXTURE_TRACE && m.method)
    appendFileSync(process.env.ACP_FIXTURE_TRACE, JSON.stringify(m) + "\n");
  if (!m.method) {
    pending.get(m.id)?.(m.result);
    pending.delete(m.id);
    return;
  }
  if (m.method === "initialize") {
    send({
      id: m.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          mcpCapabilities: { http: true },
          sessionCapabilities: { systemPrompt: {} },
        },
        agentInfo: { name: "ACP test fixture", version: "1" },
      },
    });
    return;
  }
  if (m.method === "session/new") {
    const id = randomUUID();
    sessions.set(id, {
      url: m.params.mcpServers[0]?.url,
      instructions:
        m.params.systemPrompt?.content.map((c) => c.text).join("\n") || "",
    });
    send({ id: m.id, result: { sessionId: id } });
    return;
  }
  if (m.method === "session/cancel") {
    const id = waiting.get(m.params.sessionId);
    if (id) {
      waiting.delete(m.params.sessionId);
      send({ id, result: { stopReason: "cancelled" } });
    }
    return;
  }
  if (m.method !== "session/prompt") return;
  const sessionId = m.params.sessionId,
    text = m.params.prompt.map((c) => c.text || "").join(""),
    user = text.split("User message:\n").at(-1);
  if (user.includes("wait")) {
    waiting.set(sessionId, m.id);
    update(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "等待停止测试" },
    });
    return;
  }
  if (user.includes("permissions")) {
    await Promise.all(
      [1, 2].map((i) =>
        request("session/request_permission", {
          sessionId,
          toolCall: { title: `权限测试 ${i}`, toolCallId: `p${i}` },
          options: [
            { optionId: "yes", name: `允许 ${i}`, kind: "allow_once" },
            { optionId: "no", name: `拒绝 ${i}`, kind: "reject_once" },
          ],
        }),
      ),
    );
  }
  if (user.includes("edit and compile")) {
    const projectId = /project ([a-f0-9]{24})/.exec(
      sessions.get(sessionId).instructions + text,
    )[1];
    const client = new Client({
      name: "sidebar-integration-fixture",
      version: "1",
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(sessions.get(sessionId).url)),
    );
    async function call(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const data = JSON.parse(result.content[0].text);
      if (result.isError) throw new Error(data.message);
      return data;
    }
    try {
      const tree = await call("overleaf_get_project_tree", { projectId }),
        docId = tree.rootDocId;
      const original = await call("overleaf_read_document", {
        projectId,
        docId,
      });
      update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "edit",
        title: "修改 LaTeX 测试注释",
        status: "in_progress",
      });
      const marker = "% Agent sidebar integration verified\n";
      const edited = await call("overleaf_edit_document", {
        projectId,
        docId,
        expectedVersion: original.version,
        oldText: "\\end{document}",
        newText: marker + "\\end{document}",
        operationId: randomUUID(),
      });
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "edit",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "已通过当前用户的 MCP 更新文档" },
          },
        ],
      });
      update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: "compile",
        title: "编译项目",
        status: "in_progress",
      });
      const compile = await call("overleaf_compile", { projectId });
      update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: "compile",
        status: "completed",
        content: [
          {
            type: "content",
            content: { type: "text", text: "编译结果：" + compile.status },
          },
        ],
      });
      const latest = await call("overleaf_read_document", { projectId, docId });
      await call("overleaf_edit_document", {
        projectId,
        docId,
        expectedVersion: latest.version,
        oldText: marker,
        newText: "",
        operationId: randomUUID(),
      });
    } finally {
      await client.close();
    }
  }
  update(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "已完成：" + user },
  });
  send({ id: m.id, result: { stopReason: "end_turn" } });
}
createInterface({ input: process.stdin }).on("line", (line) => {
  void handle(JSON.parse(line)).catch(() => {
    const m = JSON.parse(line);
    send({
      id: m.id,
      error: { code: -32603, message: "Fixture operation failed" },
    });
  });
});
