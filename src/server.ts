import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { AdapterError, OverleafClient } from "./overleaf.js";
const client = new OverleafClient(await loadConfig());
const server = new McpServer({ name: "overleaf-agent", version: "0.1.0" });
async function result(work: () => Promise<unknown>) {
  try {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(await work()) }],
    };
  } catch (e) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            code: e instanceof AdapterError ? e.code : "INTERNAL_ERROR",
            message: e instanceof AdapterError ? e.message : "Operation failed",
          }),
        },
      ],
    };
  }
}
server.registerTool(
  "overleaf_status",
  {
    description: "Probe the configured Overleaf login page; no project data.",
    annotations: { readOnlyHint: true },
  },
  () => result(() => client.status()),
);
server.registerTool(
  "overleaf_list_projects",
  {
    description:
      "List only explicitly allowed projects visible to this account.",
    annotations: { readOnlyHint: true },
  },
  () => result(() => client.listProjects()),
);
server.registerTool(
  "overleaf_compile",
  {
    description:
      "Compile an allowed project and return the build response. Does not edit source.",
    inputSchema: { projectId: z.string().regex(/^[a-f0-9]{24}$/) },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  ({ projectId }) => result(() => client.compile(projectId)),
);
await client.login();
await server.connect(new StdioServerTransport());
