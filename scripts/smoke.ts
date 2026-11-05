import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadConfig } from "../src/config.js";
import { OverleafClient } from "../src/overleaf.js";
const config = await loadConfig();
const client = new Client({ name: "overleaf-agent-smoke", version: "0.1.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/server.ts"],
  stderr: "inherit",
});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === "overleaf_list_projects"));
  const projects = await client.callTool({
    name: "overleaf_list_projects",
    arguments: {},
  });
  assert.ok(!projects.isError);
  const text = (projects.content as Array<{ text: string }>)[0].text;
  const listed = JSON.parse(text);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, config.allowedProjectIds[0]);
  const compiled = await client.callTool(
    { name: "overleaf_compile", arguments: { projectId: listed[0].id } },
    undefined,
    { timeout: 120_000 },
  );
  assert.ok(!compiled.isError);
  const build = JSON.parse(
    (compiled.content as Array<{ text: string }>)[0].text,
  );
  assert.equal(build.status, "success", JSON.stringify(build));
  const pdf = build.outputFiles.find(
    (f: { path: string }) => f.path === "output.pdf",
  );
  assert.ok(pdf);
  const http = new OverleafClient(config);
  await http.login();
  const bytes = await http.artifact(listed[0].id, pdf.url);
  assert.equal(Buffer.from(bytes).subarray(0, 5).toString(), "%PDF-");
  const denied = await client.callTool({
    name: "overleaf_compile",
    arguments: { projectId: "aaaaaaaaaaaaaaaaaaaaaaaa" },
  });
  assert.ok(denied.isError);
  console.log(
    JSON.stringify(
      {
        tools: tools.tools.map((t) => t.name),
        projects: listed.length,
        compile: build.status,
        pdfBytes: bytes.length,
        unauthorizedProject: "denied",
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
