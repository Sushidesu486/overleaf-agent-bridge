import { Writable } from "node:stream";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
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
      if (buffer.length > 2_000_000) throw new Error("事件超出大小限制");
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
      "站点地址必须为 HTTPS；本机实验可使用 http://localhost:18080",
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
      "用法: node overleaf-agent-connector.mjs --server http://localhost:18080 [--pair] [--runtime codex|claude|opencode]\n首次启动时粘贴弹窗中的一次性配对码。Codex / Claude Code 需要 Node.js 22+，首次启动会下载固定版本的 ACP 适配器。连接器运行期间可在网页侧栏聊天。\n可用 --config PATH 保存独立连接；凭据仅保存在本机权限 0600 的文件中。",
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
      throw new Error("连接配置无法读取");
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
      "切换 Agent 请使用 --pair 和新的配对码；可用 --config 保存不同的连接",
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
      process.stdout.write("粘贴一次性配对码（输入不回显）: ");
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
      throw new Error(`配对失败（HTTP ${response.status}），请重新生成配对码`);
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
      "站点与已保存的连接不一致，请使用另一个 --config 或重新 --pair",
    );
  const mcp = new URL(config.mcpUrl);
  if (
    mcp.origin !== config.origin ||
    !/^\/mcp\/p\/[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/.test(mcp.pathname)
  )
    throw new Error("连接配置中的 MCP 地址无效");
  const { agent, args } = selected;
  const cwd = join(dirname(path), "workspaces", config.connectionId);
  await mkdir(cwd, { recursive: true, mode: 0o700 });
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
  };
  console.log(`连接 ${config.name}；Agent: ${agent}。按 Ctrl+C 停止。`);
  while (!stopping) {
    active = new AbortController();
    const controller = active;
    const runtime = new AcpRuntime({
      command: agent,
      args,
      cwd,
      mcpUrl: config.mcpUrl,
      onExit: () => controller.abort(),
      loginHint: selected.runtime
        ? runtimes[selected.runtime].login
        : undefined,
      onSession: async (sessionId, error) => {
        const response = await fetch(config!.origin + "/agent-bridge/session", {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, error }),
          signal: AbortSignal.timeout(20_000),
          redirect: "error",
        });
        if (!response.ok)
          throw new Error(`会话初始化回传失败（HTTP ${response.status}）`);
        if (!error)
          console.log("项目会话已就绪，可以在对应项目的 Agent 侧栏发送消息。");
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
          throw new Error(`会话回传失败（HTTP ${response.status}）`);
        }
      },
    });
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    try {
      console.log("正在启动本地 Agent…");
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
            ? "连接器已在另一进程运行"
            : "连接已停用或重置，请在网页重新配对",
        );
      }
      if (!response.ok || !response.body)
        throw new Error(`连接失败（HTTP ${response.status}）`);
      console.log("已连到 Overleaf，等待连接确认和项目会话…");
      for await (const event of events(response.body)) {
        clearTimeout(heartbeat);
        heartbeat = setTimeout(() => controller.abort(), 35_000);
        if (event.event === "ready") {
          if (event.data.connectionId !== config.connectionId)
            throw new Error("服务端返回的连接身份不匹配，请重新连接");
          console.log("连接已确认。当前连接可用于这些项目：");
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
          } else console.log("  请在网页连接设置中查看授权项目。");
        }
        if (event.event === "command")
          void runtime.command(event.data as BridgeCommand).catch((error) => {
            if (event.data.type === "prepare")
              console.error(
                error instanceof Error ? error.message : "会话初始化失败",
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
            : "连接中断",
        );
    } finally {
      clearTimeout(heartbeat);
      controller.abort();
      runtime.stop();
    }
    if (!stopping) {
      console.log("3 秒后重连；中断的任务不会自动重放。");
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}
if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "连接器启动失败");
    process.exitCode = 1;
  });
