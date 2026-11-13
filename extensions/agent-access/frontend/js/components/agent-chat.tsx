import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import RailPanelHeader from "@/features/ide-react/components/rail/rail-panel-header";
import { useProjectContext } from "@/shared/context/project-context";
import { EditorOpenDocContext } from "@/features/ide-react/context/editor-open-doc-context";
import { EditorSelectionContext } from "@/shared/context/editor-selection-context";
import OLButton from "@/shared/components/ol/ol-button";
import OLIconButton from "@/shared/components/ol/ol-icon-button";
import OLFormControl from "@/shared/components/ol/ol-form-control";
import Notification from "@/shared/components/notification";
import {
  getJSON,
  postJSON,
  getUserFacingMessage,
} from "@/infrastructure/fetch-json";
import AgentMessage from "./agent-message";
import AgentConnectionModal from "./agent-connection-modal";
import {
  AgentConversationHistory,
  AgentConversationSettings,
} from "./agent-conversations";
import { recoveryMessage } from "../../../shared/chat";
import type {
  Attachment,
  ChatSession,
  PublicConnection,
  SessionSummary,
} from "../../../shared/chat";
export default function AgentChat() {
  const { projectId, name } = useProjectContext();
  const editor = useContext(EditorOpenDocContext),
    selection = useContext(EditorSelectionContext);
  const [history, setHistory] = useState(false),
    [settings, setSettings] = useState(false);
  const [modal, setModal] = useState(false),
    [connections, setConnections] = useState<PublicConnection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [suggestedConnection, setSuggestedConnection] = useState("");
  const [sessionId, setSessionId] = useState(""),
    [session, setSession] = useState<ChatSession | null>(null);
  const [text, setText] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | undefined>();
  const [streaming, setStreaming] = useState(true);
  const messages = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const composing = useRef(false);
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  function showLatest() {
    followLatest.current = true;
    setAwayFromLatest(false);
    if (messages.current)
      messages.current.scrollTop = messages.current.scrollHeight;
  }
  const selectedSession = useRef("");
  const drafts = useRef(
    new Map<string, { text: string; attachment?: Attachment }>(),
  );
  const input = useRef({ text, attachment });
  input.current = { text, attachment };
  const [loaded, setLoaded] = useState(false);
  const selectSession = useCallback((id: string) => {
    if (selectedSession.current === id) return;
    drafts.current.set(selectedSession.current, input.current);
    const draft = drafts.current.get(id);
    setText(draft?.text || "");
    setAttachment(draft?.attachment);
    followLatest.current = true;
    setAwayFromLatest(false);
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
  const projectConnections = connections.filter(
    (c) => c.availableInProject !== false,
  );
  const otherConnections = connections.filter(
    (c) => c.availableInProject === false && c.online && !c.revoked,
  );
  const active = projectConnections.find(
    (c) => c.id === (session?.connectionId || connectionId),
  );
  const running = Boolean(session?.runId);
  const storageKey = `overleaf-agent-session:${projectId}`;
  const report = (e: unknown) =>
    setError(
      getUserFacingMessage(
        e instanceof Error
          ? e
          : new Error("The action failed. Please try again."),
      ) || "The action failed. Please try again.",
    );
  const refresh = useCallback(async () => {
    const data = await getJSON<PublicConnection[]>(
      `/user/agent/chat/connections?projectId=${projectId}&includeOthers=1`,
    );
    setConnections(data);
    setConnectionId(
      (current) =>
        current ||
        data.find(
          (c) => c.availableInProject !== false && c.online && !c.revoked,
        )?.id ||
        data.find((c) => c.availableInProject !== false && !c.revoked)?.id ||
        "",
    );
  }, [projectId]);
  useEffect(() => {
    let disposed = false,
      initialized = false,
      loading = false;
    const saved = localStorage.getItem(storageKey);
    async function loadSelection() {
      if (initialized || loading) return;
      loading = true;
      try {
        let id = saved;
        if (id === null) {
          const recent = await getJSON<SessionSummary[]>(
            `/user/agent/chat/sessions?projectId=${projectId}`,
          );
          id = recent[0]?.id || "";
        }
        if (id) {
          try {
            await getJSON<ChatSession>(`/user/agent/chat/sessions/${id}`);
          } catch (e) {
            // A removed/inaccessible selection can be cleared; transient errors retry.
            if (
              [403, 404].includes(
                (e as { response?: { status?: number } }).response?.status ||
                  (e as { status?: number }).status ||
                  0,
              )
            )
              id = "";
            else throw e;
          }
        }
        if (disposed) return;
        initialized = true;
        selectSession(id || "");
        setLoaded(true);
        setError("");
      } catch (e) {
        if (!disposed) report(e);
      } finally {
        loading = false;
      }
    }
    void refresh().catch(report);
    void loadSelection();
    const timer = setInterval(() => {
      void refresh().catch(() => {});
      void loadSelection();
    }, 4000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [refresh, projectId, storageKey, selectSession]);
  useEffect(() => {
    // Only an unsent new conversation follows the available connection.
    if (sessionId || !loaded) return;
    if (
      projectConnections.some(
        (c) => c.id === connectionId && c.online && !c.revoked,
      )
    )
      return;
    const online = projectConnections.find((c) => c.online && !c.revoked);
    if (online) setConnectionId(online.id);
  }, [connections, connectionId, sessionId, loaded]);
  const useConnection = useCallback((id: string) => {
    setError("");
    setSuggestedConnection(id);
    setModal(false);
    if (selectedSession.current) {
      // Pairing changes availability, never the conversation being read.
      setSettings(true);
    } else setConnectionId(id);
  }, []);
  async function updateSession(change: {
    title?: string;
    archived?: boolean;
    connectionId?: string;
  }) {
    if (!session) return;
    const updated = await postJSON<ChatSession>(
      `/user/agent/chat/sessions/${session.id}/settings`,
      {
        body: { ...change, revision: session.revision },
      },
    );
    acceptSession(updated);
  }
  useEffect(() => {
    setSession(null);
    setStreaming(!sessionId);
    if (!sessionId) {
      if (loaded) localStorage.setItem(storageKey, "");
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
  }, [sessionId, storageKey, acceptSession, loaded]);
  useLayoutEffect(() => {
    if (followLatest.current && messages.current)
      messages.current.scrollTop = messages.current.scrollHeight;
  }, [sessionId, session?.revision]);
  function attach(selected: boolean) {
    if (!editor?.currentDocumentId) return;
    const value: Attachment = {
      docId: editor.currentDocumentId,
      name: editor.openDocName || "Current file",
    };
    if (selected) {
      const range = selection?.editorSelection?.main,
        snapshot = editor.currentDocument?.getSnapshot();
      if (!range || range.empty || typeof snapshot !== "string") {
        setError("Select some text in the source editor first.");
        return;
      }
      if (range.to - range.from > 20_000) {
        setError(
          "The selection is too long. Select fewer than 20,000 characters.",
        );
        return;
      }
      value.text = snapshot.slice(range.from, range.to);
      value.from = range.from;
      value.to = range.to;
    }
    setAttachment(value);
    setError("");
  }
  const canSend = Boolean(
    text.trim() &&
      !busy &&
      !running &&
      !session?.archivedAt &&
      active?.online &&
      loaded &&
      streaming &&
      session?.agentState !== "preparing",
  );
  async function send() {
    if (!canSend) return;
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
        const currentInput = input.current;
        selectSession(id);
        setText(currentInput.text);
        setAttachment(currentInput.attachment);
      }
      const updated = await postJSON<ChatSession>(
        `/user/agent/chat/sessions/${id}/messages`,
        { body: { text, ...(attachment ? { attachment } : {}) } },
      );
      acceptSession(updated);
      // Preserve text or a different attachment entered while the POST was pending.
      if (input.current.text === text || input.current.text === "") setText("");
      if (input.current.attachment === attachment) setAttachment(undefined);
      drafts.current.delete("");
      showLatest();
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
        title="My Agent"
        actions={
          <OLIconButton
            icon="settings"
            accessibilityLabel="Connection settings"
            className="rail-panel-header-button-subdued"
            size="sm"
            onClick={() => setModal(true)}
          />
        }
      />
      <div className="agent-chat-toolbar p-3 border-bottom">
        <div className="agent-chat-heading">
          <div className="agent-chat-title">
            <strong title={session?.title}>
              {session?.title ||
                (sessionId ? "Loading conversation…" : "New conversation")}
            </strong>
            <span className="small" title={name}>
              {name}
            </span>
          </div>
          <div className="d-flex gap-1">
            <OLIconButton
              icon="add"
              accessibilityLabel="New conversation"
              size="sm"
              disabled={busy || !loaded}
              onClick={() => {
                selectSession("");
                setError("");
              }}
            />
            <OLIconButton
              icon="history"
              accessibilityLabel="Conversation history"
              size="sm"
              disabled={busy || !loaded}
              onClick={() => setHistory(true)}
            />
            {session && (
              <OLIconButton
                icon="more_vert"
                accessibilityLabel="Manage conversation"
                size="sm"
                disabled={busy}
                onClick={() => setSettings(true)}
              />
            )}
          </div>
        </div>
        <OLButton
          className="agent-connection-status mt-2"
          variant="secondary"
          size="sm"
          onClick={() => setModal(true)}
        >
          <span
            className={`agent-status-dot ${active?.online ? "online" : ""}`}
            aria-hidden="true"
          />
          {active
            ? `${active.name} · ${active.runtime} · ${active.online ? "Online" : "Offline"}`
            : "Connect my agent"}
        </OLButton>
      </div>
      <div
        className="agent-chat-messages p-3"
        aria-label="Agent conversation"
        ref={messages}
        onScroll={(event) => {
          const element = event.currentTarget;
          const following =
            element.scrollHeight - element.clientHeight - element.scrollTop <
            64;
          followLatest.current = following;
          setAwayFromLatest(!following);
        }}
      >
        {!sessionId && (
          <p className="small">
            Connect your agent to discuss this project, edit LaTeX or request a
            compile. Conversations are saved after the first message.
          </p>
        )}
        {session?.messages.map((message) => (
          <AgentMessage
            key={`${session.id}:${message.id}`}
            message={message}
            agentName={active?.name}
          />
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
              ? "Stopping…"
              : session?.status === "waiting_permission"
                ? "Waiting for your choice…"
                : "Agent is working…"}
          </p>
        )}
      </div>
      {awayFromLatest && (
        <div className="agent-chat-latest">
          <OLButton size="sm" variant="secondary" onClick={showLatest}>
            {session?.permission
              ? "Action required · Jump to latest"
              : "Jump to latest"}
          </OLButton>
        </div>
      )}
      <div className="agent-chat-composer p-3 border-top">
        {session?.archivedAt && (
          <div className="small mb-2" role="status">
            This conversation is archived. Its history is preserved.
            <OLButton
              size="sm"
              variant="secondary"
              onClick={() => setSettings(true)}
            >
              Restore conversation
            </OLButton>
          </div>
        )}
        {session &&
          !session.archivedAt &&
          !active?.online &&
          projectConnections.some((c) => c.online && !c.revoked) && (
            <div className="small mb-2" role="status">
              The agent for this conversation is offline. Another agent is
              available.
              <OLButton
                size="sm"
                variant="secondary"
                disabled={running || busy}
                onClick={() => setSettings(true)}
              >
                Choose an agent to continue
              </OLButton>
            </div>
          )}
        {!active?.online && otherConnections.length > 0 && (
          <p className="small" role="status">
            Your local agent is connected to other projects:
            {otherConnections
              .map((c) => c.projectNames?.join("、") || c.name)
              .join("; ")}
            . Pair this project in connection settings to use it here.
          </p>
        )}
        {error && <Notification type="error" content={error} />}
        {session?.agentError && (
          <Notification type="error" content={session.agentError} />
        )}
        {active?.online &&
          session?.agentState === "ready" &&
          session.recovery &&
          session.recovery.mode !== "new" && (
            <p className="small agent-recovery-status" role="status">
              {recoveryMessage(session.recovery)}.
              {session.status === "interrupted" &&
                "Resubmit interrupted tasks when you are ready."}
            </p>
          )}
        {!streaming && (
          <p className="small" role="status">
            Reconnecting to messages…
          </p>
        )}
        {attachment && (
          <div className="d-flex align-items-center gap-2 mb-2 small">
            <span className="text-break">
              {attachment.name}
              {attachment.text
                ? ` · Selection: ${attachment.text.length} characters`
                : ""}
            </span>
            <OLIconButton
              icon="close"
              accessibilityLabel="Remove attachment"
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
            Attach file
          </OLButton>
          <OLButton
            size="sm"
            variant="secondary"
            disabled={!editor?.currentDocumentId}
            onClick={() => attach(true)}
          >
            Attach selection
          </OLButton>
        </div>
        <OLFormControl
          as="textarea"
          aria-label="Message to agent"
          rows={3}
          disabled={Boolean(session?.archivedAt)}
          maxLength={20_000}
          placeholder={
            session?.archivedAt
              ? "Restore this conversation to send messages"
              : active?.online
                ? "Describe the changes you want…"
                : "Draft a message, then connect an agent to send it"
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(e) => {
            if (
              composing.current ||
              e.nativeEvent.isComposing ||
              e.keyCode === 229
            )
              return;
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && canSend) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <div className="d-flex justify-content-between align-items-center mt-2">
          <span className="small">
            {!loaded
              ? "Loading conversation…"
              : session?.archivedAt
                ? "Archived"
                : !active?.online
                  ? active
                    ? "Selected agent offline"
                    : "No agent connected"
                  : session?.agentState === "preparing"
                    ? "Agent connected. Preparing session…"
                    : session?.agentState === "error"
                      ? "Agent connected. Retry session setup."
                      : "Agent connected"}
          </span>
          {running ? (
            <OLButton
              variant="secondary"
              disabled={busy || session?.status === "cancelling"}
              onClick={cancel}
            >
              Stop
            </OLButton>
          ) : (
            <OLButton variant="primary" disabled={!canSend} onClick={send}>
              Send
            </OLButton>
          )}
        </div>
      </div>
      {history && (
        <AgentConversationHistory
          projectId={projectId}
          currentId={sessionId}
          connections={connections}
          onHide={() => setHistory(false)}
          onSelect={(id) => {
            selectSession(id);
            setHistory(false);
            setError("");
          }}
        />
      )}
      {settings && session && (
        <AgentConversationSettings
          key={session.id}
          session={session}
          suggestedConnectionId={suggestedConnection}
          connections={connections}
          onUpdate={updateSession}
          onHide={() => {
            setSettings(false);
            setSuggestedConnection("");
          }}
        />
      )}
      {modal && (
        <AgentConnectionModal
          projectId={projectId}
          projectName={name || "Current project"}
          connections={connections}
          onConnected={useConnection}
          onHide={() => setModal(false)}
          refresh={() => {
            void refresh().catch(report);
          }}
        />
      )}
    </div>
  );
}
