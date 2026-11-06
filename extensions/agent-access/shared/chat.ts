export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "status";
  text: string;
  attachment?: Attachment;
  title?: string;
  state?: string;
  actorName?: string;
  actorRuntime?: string;
};
export type ChatPermission = {
  id: string;
  title: string;
  options: { optionId: string; name: string; kind: string }[];
};
export type SessionRecovery =
  | { mode: "new" | "resumed" }
  | {
      mode: "rebuilt";
      reason: "missing" | "unsupported" | "changed" | "unavailable";
    };
export function recoveryMessage(recovery: SessionRecovery): string {
  if (recovery.mode !== "rebuilt")
    return recovery.mode === "new" ? "新会话已就绪" : "已恢复本机 Agent 原会话";
  const reason = {
    missing: "本机原会话已不存在",
    unsupported: "当前 Agent 不支持恢复会话",
    changed: "Agent 或对话绑定已变更",
    unavailable: "此设备没有可恢复的会话索引",
  }[recovery.reason];
  return `${reason}，将用最近消息继续对话`;
}
export type ChatSession = {
  id: string;
  userId: string;
  projectId: string;
  connectionId: string;
  bindingVersion?: number;
  archivedAt?: string;
  title: string;
  messages: ChatMessage[];
  status:
    | "idle"
    | "running"
    | "waiting_permission"
    | "cancelling"
    | "interrupted";
  runId: string | null;
  permission: ChatPermission | null;
  agentState?: "preparing" | "ready" | "error";
  agentError?: string;
  recovery?: SessionRecovery;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type PublicConnection = {
  id: string;
  name: string;
  runtime: string;
  projects: string[] | null;
  online: boolean;
  revoked: boolean;
  pairingId?: string;
  availableInProject?: boolean;
  projectNames?: string[];
  canRebind?: boolean;
};
export type SessionSummary = Pick<
  ChatSession,
  | "id"
  | "title"
  | "connectionId"
  | "updatedAt"
  | "status"
  | "runId"
  | "archivedAt"
>;
export type Attachment = {
  docId: string;
  name: string;
  text?: string;
  from?: number;
  to?: number;
};
export type BridgeCommand =
  | {
      type: "prepare";
      bindingVersion?: number;
      sessionId: string;
      projectId: string;
      context: ChatMessage[];
    }
  | {
      type: "prompt";
      bindingVersion?: number;
      sessionId: string;
      runId: string;
      projectId: string;
      text: string;
      context: ChatMessage[];
      attachment?: Attachment;
    }
  | { type: "cancel"; sessionId: string; runId: string }
  | {
      type: "permission";
      sessionId: string;
      runId: string;
      permissionId: string;
      optionId: string;
    };
export type BridgeEvent =
  | {
      type: "message";
      id: string;
      role: "assistant" | "tool";
      text: string;
      title?: string;
      state?: string;
    }
  | { type: "permission"; permission: ChatPermission }
  | {
      type: "done";
      reason: "completed" | "cancelled" | "error";
      message?: string;
    };
