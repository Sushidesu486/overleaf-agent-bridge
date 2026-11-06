/** Versions verified together with the connector; no model credentials live here. */
export const runtimes = {
  codex: {
    label: "Codex",
    package: "@agentclientprotocol/codex-acp@2.5.0",
    login: "先在本机运行 codex login，或使用已有的 Codex 模型配置。",
  },
  claude: {
    label: "Claude Code",
    package: "@agentclientprotocol/claude-agent-acp@0.101.0",
    login:
      "先在本机运行 claude 并完成 /login，或使用已有的 Claude Code 模型配置。",
  },
  opencode: {
    label: "OpenCode",
    package: "",
    login: "先在本机配置好 OpenCode 的模型账号。",
  },
} as const;
export type RuntimeId = keyof typeof runtimes;
