/** Versions verified together with the connector; no model credentials live here. */
export const runtimes = {
  codex: {
    label: "Codex",
    package: "@agentclientprotocol/codex-acp@2.5.0",
    login:
      "Run codex login on your device, or use your existing Codex model configuration.",
  },
  claude: {
    label: "Claude Code",
    package: "@agentclientprotocol/claude-agent-acp@0.101.0",
    login:
      "Run claude and complete /login on your device, or use your existing Claude Code model configuration.",
  },
  opencode: {
    label: "OpenCode",
    package: "",
    login: "Configure your model account in OpenCode on your device first.",
  },
} as const;
export type RuntimeId = keyof typeof runtimes;
