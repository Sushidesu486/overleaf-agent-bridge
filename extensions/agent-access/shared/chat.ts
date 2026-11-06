export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "status";
  text: string;
  attachment?: Attachment;
  title?: string;
  state?: string;
};
export type ChatPermission = {
  id: string;
  title: string;
  options: { optionId: string; name: string; kind: string }[];
};
export type ChatSession = {
  id: string;
  userId: string;
  projectId: string;
  connectionId: string;
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
};
export type Attachment = {
  docId: string;
  name: string;
  text?: string;
  from?: number;
  to?: number;
};
export type BridgeCommand =
  | {
      type: "prompt";
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
