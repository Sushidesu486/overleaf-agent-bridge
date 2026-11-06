import { useCallback, useContext, useEffect, useRef, useState } from "react";
import RailPanelHeader from "@/features/ide-react/components/rail/rail-panel-header";
import { useProjectContext } from "@/shared/context/project-context";
import { EditorOpenDocContext } from "@/features/ide-react/context/editor-open-doc-context";
import { EditorSelectionContext } from "@/shared/context/editor-selection-context";
import OLButton from "@/shared/components/ol/ol-button";
import OLIconButton from "@/shared/components/ol/ol-icon-button";
import OLFormControl from "@/shared/components/ol/ol-form-control";
import OLFormSelect from "@/shared/components/ol/ol-form-select";
import Notification from "@/shared/components/notification";
import {
  getJSON,
  postJSON,
  getUserFacingMessage,
} from "@/infrastructure/fetch-json";
import AgentConnectionModal from "./agent-connection-modal";
import type {
  Attachment,
  ChatSession,
  PublicConnection,
} from "../../../shared/chat";
type SessionSummary = Pick<
  ChatSession,
  "id" | "title" | "connectionId" | "updatedAt"
>;
export default function AgentChat() {
  const { projectId, name } = useProjectContext();
  const editor = useContext(EditorOpenDocContext),
    selection = useContext(EditorSelectionContext);
  const [modal, setModal] = useState(false),
    [connections, setConnections] = useState<PublicConnection[]>([]);
  const [connectionId, setConnectionId] = useState(""),
    [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState(""),
    [session, setSession] = useState<ChatSession | null>(null);
  const [text, setText] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | undefined>();
  const [streaming, setStreaming] = useState(true);
  const bottom = useRef<HTMLDivElement>(null);
  const selectedSession = useRef("");
  const autoSelect = useRef(true);
  const selectSession = useCallback((id: string) => {
    selectedSession.current = id;
    setSessionId(id);
    setSession(null);
  }, []);
  const acceptSession = useCallback((value: ChatSession) => {
    if (selectedSession.current !== value.id) return;
    setConnectionId(value.connectionId);
    setSession((previous) =>
      previous?.id === value.id && previous.revision > value.revision
        ? previous
        : value,
    );
  }, []);
  const active = connections.find(
    (c) => c.id === (session?.connectionId || connectionId),
  );
  const running = Boolean(session?.runId);
  const storageKey = `overleaf-agent-session:${projectId}`;
  const report = (e: unknown) =>
    setError(
      getUserFacingMessage(
        e instanceof Error ? e : new Error("操作失败，请重试"),
      ) || "操作失败，请重试",
    );
  const refresh = useCallback(async () => {
    const data = await getJSON<PublicConnection[]>(
      `/user/agent/chat/connections?projectId=${projectId}`,
    );
    setConnections(data);
    setConnectionId(
      (current) =>
        current ||
        data.find((c) => c.online && !c.revoked)?.id ||
        data.find((c) => !c.revoked)?.id ||
        "",
    );
  }, [projectId]);
  const refreshSessions = useCallback(async () => {
    const data = await getJSON<SessionSummary[]>(
      `/user/agent/chat/sessions?projectId=${projectId}`,
    );
    setSessions(data);
    return data;
  }, [projectId]);
  useEffect(() => {
    let disposed = false;
    void refresh().catch(report);
    void refreshSessions()
      .then((data) => {
        if (!disposed) {
          const saved = localStorage.getItem(storageKey);
          selectSession(
            data.find((s) => s.id === saved)?.id || data[0]?.id || "",
          );
        }
      })
      .catch(report);
    const timer = setInterval(() => {
      void refresh().catch(() => {});
      void refreshSessions().catch(() => {});
    }, 4000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [refresh, refreshSessions, storageKey, selectSession]);
  useEffect(() => {
    if (!autoSelect.current || selectedSession.current || !connectionId) return;
    const prepared = sessions.find((s) => s.connectionId === connectionId);
    if (prepared) selectSession(prepared.id);
  }, [sessions, connectionId, selectSession]);
  useEffect(() => {
    setSession(null);
    setStreaming(!sessionId);
    if (!sessionId) {
      localStorage.removeItem(storageKey);
      return;
    }
    localStorage.setItem(storageKey, sessionId);
    const source = new EventSource(
      `/user/agent/chat/sessions/${sessionId}/events`,
    );
    source.addEventListener("session", (event) => {
      const value: ChatSession = JSON.parse((event as MessageEvent).data);
      acceptSession(value);
      setStreaming(true);
    });
    source.onopen = () => setStreaming(true);
    source.onerror = () => setStreaming(false);
    return () => source.close();
  }, [sessionId, storageKey, acceptSession]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [session?.revision]);
  function attach(selected: boolean) {
    if (!editor?.currentDocumentId) return;
    const value: Attachment = {
      docId: editor.currentDocumentId,
      name: editor.openDocName || "当前文件",
    };
    if (selected) {
      const range = selection?.editorSelection?.main,
        snapshot = editor.currentDocument?.getSnapshot();
      if (!range || range.empty || typeof snapshot !== "string") {
        setError("请先在源代码编辑器选中一段文本。");
        return;
      }
      if (range.to - range.from > 20_000) {
        setError("选区过长，请缩小到 20,000 字符以内。");
        return;
      }
      value.text = snapshot.slice(range.from, range.to);
      value.from = range.from;
      value.to = range.to;
    }
    setAttachment(value);
    setError("");
  }
  async function send() {
    if (!text.trim() || busy || running) return;
    setBusy(true);
    setError("");
    try {
      let id = sessionId;
      if (!id) {
        const created = await postJSON<ChatSession>(
          "/user/agent/chat/sessions",
          { body: { projectId, connectionId } },
        );
        id = created.id;
        selectSession(id);
      }
      const updated = await postJSON<ChatSession>(
        `/user/agent/chat/sessions/${id}/messages`,
        { body: { text, ...(attachment ? { attachment } : {}) } },
      );
      acceptSession(updated);
      setText("");
      setAttachment(undefined);
      void refreshSessions().catch(() => {});
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!sessionId || busy) return;
    setBusy(true);
    try {
      acceptSession(
        await postJSON(`/user/agent/chat/sessions/${sessionId}/cancel`),
      );
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  async function permission(optionId: string) {
    if (!session?.permission || busy) return;
    setBusy(true);
    try {
      acceptSession(
        await postJSON(`/user/agent/chat/sessions/${sessionId}/permission`, {
          body: { permissionId: session.permission.id, optionId },
        }),
      );
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="agent-chat-panel">
      <RailPanelHeader
        title="我的 Agent"
        actions={
          <OLIconButton
            icon="settings"
            accessibilityLabel="连接设置"
            className="rail-panel-header-button-subdued"
            size="sm"
            onClick={() => setModal(true)}
          />
        }
      />
      <div className="agent-chat-toolbar p-3 border-bottom">
        <div className="d-flex justify-content-between align-items-center mb-2">
          <span className="small text-break">{name}</span>
          <OLButton
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              autoSelect.current = false;
              selectSession("");
              setError("");
              if (!active?.online) return;
              setBusy(true);
              try {
                const created = await postJSON<ChatSession>(
                  "/user/agent/chat/sessions",
                  { body: { projectId, connectionId: active.id } },
                );
                selectSession(created.id);
                acceptSession(created);
                await refreshSessions();
              } catch (e) {
                report(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            新对话
          </OLButton>
        </div>
        <OLFormSelect
          aria-label="选择 Agent"
          value={session?.connectionId || connectionId}
          disabled={busy || running}
          onChange={(e) => {
            autoSelect.current = true;
            selectSession("");
            setConnectionId(e.target.value);
            setError("");
          }}
        >
          <option value="">选择连接</option>
          {connections
            .filter((c) => !c.revoked || c.id === session?.connectionId)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} · {c.online ? "在线" : "离线"}
              </option>
            ))}
        </OLFormSelect>
        {sessions.length > 0 && (
          <OLFormSelect
            className="mt-2"
            aria-label="选择对话"
            disabled={busy}
            value={sessionId}
            onChange={(e) => {
              selectSession(e.target.value);
              setError("");
            }}
          >
            <option value="">新对话</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </OLFormSelect>
        )}
        <OLButton
          className="mt-2 w-100"
          variant="secondary"
          leadingIcon="link"
          onClick={() => setModal(true)}
        >
          连接我的 Agent
        </OLButton>
      </div>
      <div className="agent-chat-messages p-3" aria-label="Agent 对话记录">
        {!session?.messages.length && (
          <p className="small">
            连接自己的 Agent 后，在这里讨论当前项目、修改 LaTeX
            或请求编译。编辑会在 History 中标为 Your agent。
          </p>
        )}
        {session?.messages.map((message) => (
          <div
            key={message.id}
            className={`agent-chat-message agent-message-${message.role}`}
          >
            {message.role === "tool" ? (
              <details
                open={
                  message.state === "in_progress" || message.state === "pending"
                }
              >
                <summary>
                  {message.title || "工具调用"} ·{" "}
                  {(
                    {
                      pending: "准备中",
                      in_progress: "执行中",
                      completed: "完成",
                      failed: "失败",
                    } as Record<string, string>
                  )[message.state || ""] || message.state}
                </summary>
                <pre>{message.text}</pre>
              </details>
            ) : (
              <>
                <div className="agent-message-author small">
                  {message.role === "user"
                    ? "你"
                    : message.role === "assistant"
                      ? active?.name || "Agent"
                      : "任务状态"}
                </div>
                <div className="agent-message-text">{message.text}</div>
                {message.attachment && (
                  <div className="small">
                    附件：{message.attachment.name}
                    {message.attachment.text
                      ? ` · 选区 ${message.attachment.text.length} 字符`
                      : ""}
                  </div>
                )}
              </>
            )}
          </div>
        ))}
        {session?.permission && (
          <div className="agent-permission border rounded p-2">
            <p>{session.permission.title}</p>
            <div className="d-flex flex-wrap gap-2">
              {session.permission.options.map((option) => (
                <OLButton
                  size="sm"
                  key={option.optionId}
                  variant="secondary"
                  disabled={busy}
                  onClick={() => permission(option.optionId)}
                >
                  {option.name}
                </OLButton>
              ))}
            </div>
          </div>
        )}
        {running && (
          <p role="status" className="small">
            {session?.status === "cancelling"
              ? "正在停止…"
              : session?.status === "waiting_permission"
                ? "等待你的选择…"
                : "Agent 正在处理…"}
          </p>
        )}
        <div ref={bottom} />
      </div>
      <div className="agent-chat-composer p-3 border-top">
        {error && <Notification type="error" content={error} />}
        {session?.agentError && (
          <Notification type="error" content={session.agentError} />
        )}
        {!streaming && (
          <p className="small" role="status">
            正在恢复消息连接…
          </p>
        )}
        {attachment && (
          <div className="d-flex align-items-center gap-2 mb-2 small">
            <span className="text-break">
              {attachment.name}
              {attachment.text ? ` · 选区 ${attachment.text.length} 字符` : ""}
            </span>
            <OLIconButton
              icon="close"
              accessibilityLabel="移除附件"
              onClick={() => setAttachment(undefined)}
            />
          </div>
        )}
        <div className="d-flex gap-2 mb-2">
          <OLButton
            size="sm"
            variant="secondary"
            disabled={!editor?.currentDocumentId}
            onClick={() => attach(false)}
          >
            附加文件
          </OLButton>
          <OLButton
            size="sm"
            variant="secondary"
            disabled={!editor?.currentDocumentId}
            onClick={() => attach(true)}
          >
            附加选区
          </OLButton>
        </div>
        <OLFormControl
          as="textarea"
          aria-label="发给 Agent 的消息"
          rows={3}
          maxLength={20_000}
          placeholder={
            active?.online ? "描述你希望完成的修改…" : "请先连接自己的 Agent"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="d-flex justify-content-between align-items-center mt-2">
          <span className="small">
            {session?.agentState === "preparing"
              ? "正在建立会话…"
              : session?.agentState === "error"
                ? "会话需要重试"
                : active?.online
                  ? "Agent 已连接"
                  : "Agent 离线"}
          </span>
          {running ? (
            <OLButton
              variant="secondary"
              disabled={busy || session?.status === "cancelling"}
              onClick={cancel}
            >
              停止
            </OLButton>
          ) : (
            <OLButton
              variant="primary"
              disabled={
                busy ||
                !active?.online ||
                session?.agentState === "preparing" ||
                !text.trim() ||
                !streaming
              }
              onClick={send}
            >
              发送
            </OLButton>
          )}
        </div>
      </div>
      {modal && (
        <AgentConnectionModal
          projectId={projectId}
          projectName={name || "当前项目"}
          connections={connections}
          onHide={() => setModal(false)}
          refresh={() => {
            void refresh().catch(report);
          }}
        />
      )}
    </div>
  );
}
