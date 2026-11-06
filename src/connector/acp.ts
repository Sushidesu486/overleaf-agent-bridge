import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  BridgeCommand,
  BridgeEvent,
  ChatPermission,
} from "../../extensions/agent-access/shared/chat.js";
type Json = Record<string, any>;
type Run = {
  command: Extract<BridgeCommand, { type: "prompt" }>;
  acpSession?: string;
  text: string;
  messageIndex: number;
  tools: Map<string, Json>;
  cancelled: boolean;
  pending: Promise<void>;
  permissions: Map<
    string,
    { rpcId: string | number; options: string[]; permission: ChatPermission }
  >;
};
export class AcpRuntime {
  private process: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private requests = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private sessions = new Map<string, string>();
  private runs = new Map<string, Run>();
  private stopped = false;
  private terminated = false;
  private turns = new Map<string, Promise<void>>();
  private cancelled = new Set<string>();
  private updates: Promise<void> = Promise.resolve();
  private ready: Promise<any>;
  constructor(
    readonly options: {
      command: string;
      args: string[];
      cwd: string;
      mcpUrl: string;
      emit: (
        sessionId: string,
        runId: string,
        event: BridgeEvent,
      ) => Promise<void>;
      onExit?: () => void;
    },
  ) {
    this.process = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: "pipe",
      detached: process.platform !== "win32",
      env: process.env,
    });
    // Runtime stderr may contain prompts or credentials. Keep it out of connector logs.
    this.process.stderr.resume();
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.method === "session/update")
          this.updates = this.updates
            .then(() => this.receive(message))
            .catch(() => this.stop());
        else void this.receive(message).catch(() => this.stop());
      } catch {
        this.stop();
      }
    });
    const fail = () => {
      this.stop();
      this.options.onExit?.();
      for (const p of this.requests.values())
        p.reject(new Error("Agent 进程退出或协议连接中断"));
      this.requests.clear();
    };
    this.process.on("error", fail);
    this.process.on("exit", fail);
    this.ready = this.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: "overleaf-agent-connector", version: "0.3.0" },
    });
    // Avoid an unhandled rejection while the connector is still pairing.
    this.ready.catch(() => {});
  }
  private write(value: unknown) {
    if (!this.stopped) this.process.stdin.write(JSON.stringify(value) + "\n");
  }
  private request(method: string, params: unknown): Promise<any> {
    if (this.stopped) return Promise.reject(new Error("Agent 已停止"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  private notify(method: string, params: unknown) {
    this.write({ jsonrpc: "2.0", method, params });
  }
  private respond(id: string | number, result: unknown) {
    this.write({ jsonrpc: "2.0", id, result });
  }
  async initialized() {
    const result = await Promise.race([
      this.ready,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Agent 初始化超时")),
          30_000,
        );
        timer.unref();
      }),
    ]);
    if (!result.agentCapabilities?.mcpCapabilities?.http)
      throw new Error(
        "这个 ACP Agent 没有声明 HTTP MCP 支持，请选择支持该能力的运行时",
      );
    return {
      name: String(result.agentInfo?.name || this.options.command).slice(0, 80),
    };
  }
  private clean(value: string) {
    return value
      .split(this.options.mcpUrl)
      .join("[MCP URL]")
      .replace(
        /\/mcp\/p\/[a-f0-9]{24}\.[A-Za-z0-9_-]{43}/g,
        "/mcp/p/[redacted]",
      );
  }
  private emit(run: Run, event: BridgeEvent) {
    const safe = JSON.parse(this.clean(JSON.stringify(event))) as BridgeEvent;
    run.pending = run.pending.then(() =>
      this.options.emit(run.command.sessionId, run.command.runId, safe),
    );
    return run.pending;
  }
  private async receive(message: Json) {
    if (message.id !== undefined && !message.method) {
      const pending = this.requests.get(message.id);
      if (!pending) return;
      this.requests.delete(message.id);
      if (message.error)
        pending.reject(
          new Error(
            this.clean(String(message.error.message || "Agent 请求失败")),
          ),
        );
      else pending.resolve(message.result);
      return;
    }
    const run = [...this.runs.values()].find(
      (r) => r.acpSession === message.params?.sessionId,
    );
    if (
      message.method === "session/request_permission" &&
      message.id !== undefined
    ) {
      if (!run || run.cancelled) {
        this.respond(message.id, { outcome: { outcome: "cancelled" } });
        return;
      }
      const permissionId = randomBytes(12).toString("hex");
      const options = (message.params.options || []).map((o: Json) => ({
        optionId: String(o.optionId),
        name: String(o.name),
        kind: String(o.kind),
      }));
      const permission = {
        id: permissionId,
        title: String(
          message.params.toolCall?.title || "Agent 请求执行操作",
        ).slice(0, 1000),
        options,
      };
      run.permissions.set(permissionId, {
        rpcId: message.id,
        options: options.map((o: Json) => o.optionId),
        permission,
      });
      if (run.permissions.size === 1)
        await this.emit(run, { type: "permission", permission });
      return;
    }
    if (message.id !== undefined && message.method) {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Client capability not advertised" },
      });
      return;
    }
    if (message.method !== "session/update" || !run) return;
    const update = message.params.update;
    if (
      update.sessionUpdate === "agent_message_chunk" &&
      update.content?.type === "text"
    ) {
      run.text = (run.text + update.content.text).slice(0, 60_000);
      // Coalesce model chunks; final text is always flushed before the turn completes.
      this.scheduleText(run);
    } else if (
      update.sessionUpdate === "tool_call" ||
      update.sessionUpdate === "tool_call_update"
    ) {
      await this.flushText(run);
      if (run.text) {
        run.text = "";
        run.messageIndex++;
      }
      const toolId = String(update.toolCallId);
      const tool = { ...run.tools.get(toolId), ...update };
      run.tools.set(toolId, tool);
      const details = (tool.content || [])
        .map((c: Json) =>
          c.type === "content" && c.content?.type === "text"
            ? c.content.text
            : c.type === "diff"
              ? `修改 ${c.path}\n${String(c.newText || "").slice(0, 1500)}`
              : "",
        )
        .filter(Boolean)
        .join("\n")
        .slice(0, 6000);
      await this.emit(run, {
        type: "message",
        id: `tool:${toolId}`,
        role: "tool",
        title: String(tool.title || "调用工具").slice(0, 500),
        state: String(tool.status || "pending"),
        text: details,
      });
    }
  }
  private timers = new Map<Run, ReturnType<typeof setTimeout>>();
  private scheduleText(run: Run) {
    if (this.timers.has(run)) return;
    this.timers.set(
      run,
      setTimeout(() => {
        this.timers.delete(run);
        void this.flushText(run).catch(() => this.stop());
      }, 150),
    );
  }
  private async flushText(run: Run) {
    clearTimeout(this.timers.get(run));
    this.timers.delete(run);
    if (run.text)
      await this.emit(run, {
        type: "message",
        id: `assistant:${run.messageIndex}`,
        role: "assistant",
        text: run.text,
      });
  }
  async command(command: BridgeCommand) {
    if (command.type === "permission") {
      const run = this.runs.get(command.sessionId);
      const permission = run?.permissions.get(command.permissionId);
      if (
        run?.command.runId === command.runId &&
        permission?.options.includes(command.optionId)
      ) {
        run.permissions.delete(command.permissionId);
        this.respond(permission.rpcId, {
          outcome: { outcome: "selected", optionId: command.optionId },
        });
        const next = run.permissions.values().next().value;
        if (next)
          await this.emit(run, {
            type: "permission",
            permission: next.permission,
          });
      }
      return;
    }
    if (command.type === "cancel") {
      const run = this.runs.get(command.sessionId);
      if (run?.command.runId === command.runId) {
        run.cancelled = true;
        for (const p of run.permissions.values())
          this.respond(p.rpcId, { outcome: { outcome: "cancelled" } });
        run.permissions.clear();
        if (run.acpSession)
          this.notify("session/cancel", { sessionId: run.acpSession });
        const timer = setTimeout(() => {
          if (this.runs.get(command.sessionId) === run) this.stop();
        }, 10_000);
        timer.unref();
      } else this.cancelled.add(command.runId);
      return;
    }
    const previous = this.turns.get(command.sessionId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.prompt(command));
    this.turns.set(command.sessionId, pending);
    try {
      await pending;
    } finally {
      if (this.turns.get(command.sessionId) === pending)
        this.turns.delete(command.sessionId);
    }
  }
  private async prompt(command: Extract<BridgeCommand, { type: "prompt" }>) {
    const run: Run = {
      command,
      text: "",
      messageIndex: 0,
      tools: new Map(),
      cancelled: this.cancelled.delete(command.runId),
      pending: Promise.resolve(),
      permissions: new Map(),
    };
    this.runs.set(command.sessionId, run);
    try {
      await this.initialized();
      let acpSession = this.sessions.get(command.sessionId);
      let restoring = false;
      if (!acpSession) {
        const cwd = join(this.options.cwd, command.projectId);
        await mkdir(cwd, { recursive: true, mode: 0o700 });
        const result = await this.request("session/new", {
          cwd,
          mcpServers: [
            {
              type: "http",
              name: "overleaf",
              url: this.options.mcpUrl,
              headers: [],
            },
          ],
        });
        acpSession = String(result.sessionId);
        this.sessions.set(command.sessionId, acpSession);
        restoring = true;
      }
      run.acpSession = acpSession;
      if (run.cancelled) {
        await this.emit(run, { type: "done", reason: "cancelled" });
        return;
      }
      const history = restoring
        ? command.context
            .map(
              (m) =>
                `${m.role}: ${m.text}${m.attachment ? "\nAttached context: " + JSON.stringify(m.attachment) : ""}`,
            )
            .join("\n\n")
            .slice(-40_000)
        : "";
      const attachment = command.attachment
        ? `\nAttached editor context (may be stale; reread before editing):\n${JSON.stringify(command.attachment)}`
        : "";
      const instructions = `You are the user's agent in Overleaf. Work only on project ${command.projectId}. Use the overleaf MCP tools for project reads, edits and compilation; local files are not the live project. Read current document versions before edits. Do not repeat an edit whose outcome is unknown: read first. Preserve concurrent human edits. Reply in the user's language.\n`;
      const result = await this.request("session/prompt", {
        sessionId: acpSession,
        prompt: [
          {
            type: "text",
            text: `${instructions}${history ? "\nPrevious conversation recovered after reconnect:\n" + history : ""}${attachment}\n\nUser message:\n${command.text}`,
          },
        ],
      });
      await this.updates;
      await this.flushText(run);
      await run.pending;
      await this.emit(run, {
        type: "done",
        reason:
          run.cancelled || result.stopReason === "cancelled"
            ? "cancelled"
            : "completed",
      });
    } catch (error) {
      await run.pending.catch(() => {});
      await this.options
        .emit(command.sessionId, command.runId, {
          type: "done",
          reason: run.cancelled ? "cancelled" : "error",
          message: this.clean(
            error instanceof Error ? error.message : "Agent 运行失败",
          ).slice(0, 2000),
        })
        .catch(() => {});
    } finally {
      clearTimeout(this.timers.get(run));
      this.timers.delete(run);
      this.runs.delete(command.sessionId);
    }
  }
  stop() {
    if (this.terminated) return;
    this.terminated = true;
    this.stopped = true;
    for (const p of this.requests.values())
      p.reject(new Error("Agent 连接已关闭"));
    this.requests.clear();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && this.process.pid)
          process.kill(-this.process.pid, signal);
        else this.process.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    kill("SIGTERM");
    setTimeout(() => kill("SIGKILL"), 2000);
  }
}
