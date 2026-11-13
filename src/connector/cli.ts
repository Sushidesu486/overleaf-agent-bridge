import { Writable } from "node:stream";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { NativeSessionStore } from "./sessions.js";
import { recoveryMessage } from "../../extensions/agent-access/shared/chat.js";
import { AcpRuntime } from "./acp.js";
import { resolveRuntime, type RuntimeConfig } from "./runtime.js";
import { runtimes } from "../../extensions/agent-access/shared/runtimes.js";
import type { BridgeCommand } from "../../extensions/agent-access/shared/chat.js";
export async function* events(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      if (buffer.length > 2_000_000)
        throw new Error("The event exceeds the size limit");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        const event =
          frame
            .split("\n")
            .find((l) => l.startsWith("event:"))
            ?.slice(6)
            .trim() || "message";
        if (data) yield { event, data: JSON.parse(data) };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
type Config = RuntimeConfig & {
  origin: string;
  credential: string;
  mcpUrl: string;
  connectionId: string;
  name: string;
};
function origin(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error(
      "The server URL must use HTTPS. Local development can use http://localhost:18080.",
    );
  return url.origin;
}
async function main() {
  const { values } = parseArgs({
    options: {
      server: { type: "string" },
      config: { type: "string" },
      pair: { type: "boolean" },
      "pair-code-file": { type: "string" },
      runtime: { type: "string" },
      agent: { type: "string" },
      "agent-arg": { type: "string", multiple: true },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node overleaf-agent-connector.mjs --server http://localhost:18080 [--pair] [--runtime codex|claude|opencode]\nOn first launch, paste the one-time pairing code from the connection dialog. Codex and Claude Code require Node.js 22+. The pinned ACP adapter is downloaded on first use. Keep the connector running to chat in the web sidebar.\nUse --config PATH for a separate connection. Credentials are stored locally in a file with mode 0600.",
    );
    return;
  }
  const path = resolve(
    values.config || join(homedir(), ".config/overleaf-agent/connector.json"),
  );
  let config: Config | undefined;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Unable to read the connection configuration");
  }
  const selected = resolveRuntime(
    { runtime: values.runtime, agent: values.agent, args: values["agent-arg"] },
    config,
  );
  if (selected.runtime) console.log(runtimes[selected.runtime].login);
  if (
    config &&
    !values.pair &&
    values.runtime &&
    values.runtime !== config.runtime
  )
    throw new Error(
      "To change agents, use --pair with a new pairing code. Use --config to keep separate connections.",
    );
  if (!config || values.pair) {
    const server = origin(
      values.server || config?.origin || "http://localhost:18080",
    );
    let code: string;
    if (values["pair-code-file"])
      code = (await readFile(values["pair-code-file"], "utf8")).trim();
    else {
      const readline = createInterface({
        input: process.stdin,
        output: new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
        terminal: Boolean(process.stdin.isTTY),
      });
      process.stdout.write(
        "Paste the one-time pairing code (input is hidden): ",
      );
      try {
        code = (await readline.question("")).trim();
      } finally {
        readline.close();
        process.stdout.write("\n");
      }
    }
    const response = await fetch(server + "/agent-bridge/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        runtime: selected.runtime
          ? runtimes[selected.runtime].label
          : selected.agent.split("/").at(-1),
      }),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        `Pairing failed (HTTP ${response.status}). Generate a new pairing code.`,
      );
    config = {
      ...((await response.json()) as Omit<Config, "origin" | "agent" | "args">),
      origin: server,
      ...selected,
    };
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
    await chmod(path, 0o600);
  }
  config.origin = origin(config.origin);
  if (values.server && origin(values.server) !== config.origin)
    throw new Error(
      "The server does not match the saved connection. Use a different --config or pair again with --pair.",
    );
  const mcp = new URL(config.mcpUrl);
  if (
    mcp.origin !== config.origin ||
    !/^\/mcp\/p\/[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/.test(mcp.pathname)
  )
    throw new Error("The connection configuration contains an invalid MCP URL");
  const { agent, args } = selected;
  const cwd = join(dirname(path), "workspaces", config.connectionId);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  const sessionStore = new NativeSessionStore(
    join(dirname(path), "sessions", config.connectionId),
  );
  let stopping = false,
    active: AbortController | undefined;
  const stop = () => {
    stopping = true;
    active?.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const headers = {
    "X-Overleaf-Agent-Bridge-Key": config.credential,
    "X-Overleaf-Agent-Prepare": "1",
    "X-Overleaf-Agent-Rebind": "1",
  };
  console.log(
    `Connecting ${config.name}; agent: ${agent}. Press Ctrl+C to stop.`,
  );
  while (!stopping) {
    active = new AbortController();
    const controller = active;
    const runtime = new AcpRuntime({
      command: agent,
      args,
      cwd,
      mcpUrl: config.mcpUrl,
      sessionStore,
      sessionScope: `${config.origin}:${config.connectionId}`,
      onExit: () => controller.abort(),
      loginHint: selected.runtime
        ? runtimes[selected.runtime].login
        : undefined,
      onSession: async (sessionId, error, bindingVersion, recovery) => {
        const response = await fetch(config!.origin + "/agent-bridge/session", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, error, bindingVersion, recovery }),
          signal: AbortSignal.timeout(20_000),
          redirect: "error",
        });
        // A conversation may have moved to another connector while this one was preparing.
        if (response.status === 404) return;
        if (!response.ok)
          throw new Error(
            `Unable to report session initialization (HTTP ${response.status})`,
          );
        if (!error)
          console.log(
            `${recovery ? recoveryMessage(recovery) : "Project session ready"}. You can send messages in the project agent sidebar.`,
          );
      },
      emit: async (sessionId, runId, event) => {
        const response = await fetch(config!.origin + "/agent-bridge/events", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, runId, event }),
          signal: AbortSignal.timeout(20_000),
          redirect: "error",
        });
        if (!response.ok) {
          controller.abort();
          throw new Error(
            `Unable to report session updates (HTTP ${response.status})`,
          );
        }
      },
    });
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    try {
      console.log("Starting the local agent…");
      await runtime.initialized();
      const response = await fetch(config.origin + "/agent-bridge/connect", {
        headers,
        signal: controller.signal,
        redirect: "error",
      });
      if (response.status === 401 || response.status === 409) {
        stopping = true;
        throw new Error(
          response.status === 409
            ? "The connector is already running in another process"
            : "The connection has been disabled or reset. Pair again from the web interface.",
        );
      }
      if (!response.ok || !response.body)
        throw new Error(`Connection failed (HTTP ${response.status})`);
      console.log("Connected to Overleaf. Waiting for confirmation…");
      for await (const event of events(response.body)) {
        clearTimeout(heartbeat);
        heartbeat = setTimeout(() => controller.abort(), 35_000);
        if (event.event === "ready") {
          if (event.data.connectionId !== config.connectionId)
            throw new Error(
              "The server returned a mismatched connection identity. Please reconnect.",
            );
          console.log(
            "Connection confirmed. This connection can access these projects:",
          );
          if (Array.isArray(event.data.projects)) {
            for (const project of event.data.projects) {
              if (
                /^[a-f0-9]{24}$/.test(project.id) &&
                typeof project.name === "string"
              )
                console.log(
                  `  ${project.name.replace(/[\r\n\x1b]/g, " ")} — ${config.origin}/project/${project.id}`,
                );
            }
          } else
            console.log(
              "  View authorized projects in the web connection settings.",
            );
          console.log(
            "Start or continue a conversation on the web. New conversations are created when you send the first message.",
          );
        }
        if (event.event === "command")
          void runtime.command(event.data as BridgeCommand).catch((error) => {
            if (event.data.type === "prepare")
              console.error(
                error instanceof Error
                  ? error.message
                  : "Session initialization failed",
              );
            else controller.abort();
          });
      }
    } catch (error) {
      if (!stopping)
        console.error(
          error instanceof Error &&
            !error.message.includes(config.credential) &&
            !error.message.includes(config.mcpUrl)
            ? error.message
            : "Connection interrupted",
        );
    } finally {
      clearTimeout(heartbeat);
      controller.abort();
      runtime.stop();
    }
    if (!stopping) {
      console.log(
        "Reconnecting in 3 seconds. Interrupted tasks will not be replayed automatically.",
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
)
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Unable to start the connector",
    );
    process.exitCode = 1;
  });
