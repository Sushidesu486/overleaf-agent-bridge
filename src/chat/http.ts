import type { IncomingMessage, ServerResponse } from "node:http";
import { AgentError } from "../agent/service.js";
import { errorResponse } from "../agent/http.js";
import type { ChatService } from "./service.js";
const attempts = new Map<string, { count: number; until: number }>();
async function jsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 100_000) throw new AgentError("TOO_LARGE", "请求过大", 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AgentError("INVALID_INPUT", "请求格式错误");
  }
}
export function startEvents(res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive",
  });
  res.flushHeaders();
}
export function sendEvent(res: ServerResponse, event: string, data: unknown) {
  if (res.destroyed || res.writableEnded || res.writableLength > 2_000_000) {
    res.destroy();
    return false;
  }
  return (
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    true
  );
}
export async function handleBridge(
  req: IncomingMessage,
  res: ServerResponse,
  chat: ChatService,
  credential: string,
) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.headers.origin) {
    res.writeHead(403).end();
    return;
  }
  try {
    const path = req.url?.split("?")[0];
    if (path === "/pair" && req.method === "POST") {
      const key = req.socket.remoteAddress || "unknown";
      for (const [k, v] of attempts)
        if (v.until < Date.now()) attempts.delete(k);
      const rate = attempts.get(key) ?? {
        count: 0,
        until: Date.now() + 60_000,
      };
      if (++rate.count > 20)
        throw new AgentError("RATE_LIMITED", "请求过于频繁，请稍后再试", 429);
      attempts.set(key, rate);
      const result = await chat.pair(await jsonBody(req));
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(result));
      return;
    }
    if (path === "/session" && req.method === "POST") {
      const result = await chat.prepared(credential, await jsonBody(req));
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(result));
      return;
    }
    if (path === "/events" && req.method === "POST") {
      const result = await chat.event(credential, await jsonBody(req));
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(result));
      return;
    }
    if (path === "/connect" && req.method === "GET") {
      const connection = await chat.attach(
        credential,
        (command) => sendEvent(res, "command", command),
        () => res.end(),
        req.headers["x-overleaf-agent-prepare"] === "1",
        req.headers["x-overleaf-agent-rebind"] === "1",
      );
      startEvents(res);
      sendEvent(res, "ready", {
        connectionId: connection.id,
        projects: connection.projects,
      });
      let checking = false;
      const heartbeat = setInterval(async () => {
        if (checking) return;
        checking = true;
        try {
          await chat.authenticate(credential);
          sendEvent(res, "heartbeat", {});
        } catch {
          res.end();
        } finally {
          checking = false;
        }
      }, 10_000);
      res.on("close", () => {
        clearInterval(heartbeat);
        void connection.disconnect().catch(() => {});
      });
      if (req.headers["x-overleaf-agent-prepare"] === "1")
        await chat.prepareConnection(credential);
      return;
    }
    throw new AgentError("NOT_FOUND", "接口不存在", 404);
  } catch (error) {
    if (!res.headersSent)
      res
        .writeHead(error instanceof AgentError ? error.status : 400, {
          "Content-Type": "application/json",
        })
        .end(JSON.stringify(errorResponse(error)));
    else res.end();
  }
}
