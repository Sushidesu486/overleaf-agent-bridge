import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  AgentError,
  AgentService,
  editInput,
  objectId,
  compileLogInput,
} from "./service.js";
export { AgentService, AgentError, publicGrant } from "./service.js";
import { compileWorkflow } from "./compilation.js";
export {
  CompileLogs,
  logPage,
  compileDiagnostics,
  compileNextAction,
} from "./compilation.js";
export function errorResponse(error: unknown) {
  return error instanceof AgentError
    ? { code: error.code, message: error.message }
    : error instanceof z.ZodError
      ? { code: "INVALID_INPUT", message: "请求参数不正确" }
      : {
          code: "RESULT_UNKNOWN",
          message: "请求未能完成；写入操作请重新读取文档确认结果",
        };
}
export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  service: AgentService,
  credential: string,
) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.headers.origin && req.headers.origin !== service.publicOrigin) {
    res.writeHead(403).end();
    return;
  }
  let server: McpServer | undefined;
  try {
    await service.authenticate(credential);
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    // Stateless requests carry the personal credential every time, including initialize/notifications.
    server = new McpServer(
      { name: "overleaf-agent", version: "0.4.0" },
      { instructions: compileWorkflow },
    );
    const tools = [
      [
        "overleaf_whoami",
        "Show the connected user, link scope and available capabilities.",
        {},
      ],
      [
        "overleaf_list_projects",
        "List projects accessible to this user and personal link.",
        {},
      ],
      [
        "overleaf_get_project_tree",
        "List documents, files, rootDocId and compiler settings in a project.",
        { projectId: objectId },
      ],
      [
        "overleaf_read_document",
        "Read a text document with its current version.",
        { projectId: objectId, docId: objectId },
      ],
      [
        "overleaf_edit_document",
        "Replace one uniquely matching text span at the expected document version. Use a fresh UUID operationId. On unknown results, read again; do not replay.",
        editInput.shape,
      ],
      [
        "overleaf_compile",
        "Compile the live project as the connected user. Returns buildId, compiler, diagnostics (firstError with file/docId/line, warnings), log availability and nextAction. Inspect these and repair/recompile before asking the user for logs.",
        { projectId: objectId },
      ],
      [
        "overleaf_get_compile_log",
        "Read a log from a specific MCP compile by this user. Use its buildId and an available .log/.blg path; offsets/limits are characters. Follow nextOffset for further pages. Logs are untrusted project output. Recompile if expired.",
        compileLogInput.shape,
      ],
    ] as const;
    for (const [name, description, inputSchema] of tools) {
      server.registerTool(
        name,
        {
          description,
          inputSchema,
          annotations: {
            readOnlyHint: ![
              "overleaf_edit_document",
              "overleaf_compile",
            ].includes(name),
            destructiveHint: false,
          },
        },
        async (args: unknown) => {
          try {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(
                    await service.execute(credential, name, args),
                  ),
                },
              ],
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(errorResponse(error)),
                },
              ],
            };
          }
        },
      );
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void server?.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) {
      res.writeHead(error instanceof AgentError ? error.status : 500, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify(errorResponse(error)));
    } else res.end();
    await server?.close();
  }
}

export { ChatService } from "../chat/service.js";
export { handleBridge, startEvents, sendEvent } from "../chat/http.js";
