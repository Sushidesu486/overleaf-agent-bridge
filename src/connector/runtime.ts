import {
  runtimes,
  type RuntimeId,
} from "../../extensions/agent-access/shared/runtimes.js";
export type RuntimeConfig = {
  agent: string;
  args: string[];
  runtime?: RuntimeId;
};

export function resolveRuntime(
  input: { runtime?: string; agent?: string; args?: string[] },
  saved?: RuntimeConfig,
): RuntimeConfig {
  if (input.runtime && (input.agent || input.args))
    throw new Error("--runtime 与 --agent/--agent-arg 请择一使用");
  if (input.runtime && !Object.hasOwn(runtimes, input.runtime))
    throw new Error("--runtime 可选 codex、claude、opencode");
  if (input.agent)
    return {
      agent: input.agent,
      args: input.args || (input.agent === "opencode" ? ["acp"] : []),
    };
  if (input.args) {
    if (!saved) throw new Error("--agent-arg 需要同时指定 --agent");
    return { agent: saved.agent, args: input.args };
  }
  if (!input.runtime && saved) {
    validateNodeVersion(saved.runtime);
    return {
      agent: saved.agent,
      args: saved.args,
      ...(saved.runtime ? { runtime: saved.runtime } : {}),
    };
  }
  const runtime = (input.runtime || "codex") as RuntimeId;
  if (runtime === "opencode")
    return { runtime, agent: "opencode", args: ["acp"] };
  validateNodeVersion(runtime);
  return { runtime, agent: "npx", args: ["--yes", runtimes[runtime].package] };
}

function validateNodeVersion(runtime?: RuntimeId) {
  if (
    (runtime === "codex" || runtime === "claude") &&
    Number(process.versions.node.split(".")[0]) < 22
  )
    throw new Error("Codex / Claude Code 适配器需要 Node.js 22 或更新版本");
}
