import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio MCP handshake and tools work without contaminating stdout", async (t) => {
  const id = "0123456789abcdef01234567";
  const http = createServer((req, res) => {
    if (req.url === "/login" && req.method === "POST") {
      res.setHeader("content-type", "application/json");
      res.end("{}");
    } else if (req.url === "/login" || req.url === "/user/settings")
      res.end(
        '<meta name="ol-csrfToken" content="test-token"><title>Fixture</title>',
      );
    else if (req.url === "/api/project") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ projects: [{ id, name: "fixture" }] }));
    } else if (req.url === `/project/${id}/compile`) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "success", outputFiles: [] }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  t.after(
    () => new Promise<void>((r, j) => http.close((e) => (e ? j(e) : r()))),
  );
  const dir = await mkdtemp(join(tmpdir(), "overleaf-agent-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "config.json");
  const port = (http.address() as { port: number }).port;
  await writeFile(
    file,
    JSON.stringify({
      baseUrl: `http://127.0.0.1:${port}`,
      email: "test@example.invalid",
      password: "test-password",
      allowedProjectIds: [id],
    }),
    { mode: 0o600 },
  );
  const client = new Client({ name: "fixture-client", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/server.ts"],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (x): x is [string, string] => x[1] !== undefined,
          ),
        ),
        OVERLEAF_AGENT_CONFIG: file,
      },
      stderr: "pipe",
    }),
  );
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 3);
  for (const name of ["overleaf_status", "overleaf_list_projects"]) {
    const result = await client.callTool({ name, arguments: {} });
    assert.ok(!result.isError);
  }
  const compiled = await client.callTool({
    name: "overleaf_compile",
    arguments: { projectId: id },
  });
  assert.ok(!compiled.isError);
  const rejected = await client.callTool({
    name: "overleaf_compile",
    arguments: { projectId: "aaaaaaaaaaaaaaaaaaaaaaaa" },
  });
  assert.equal(rejected.isError, true);
});
