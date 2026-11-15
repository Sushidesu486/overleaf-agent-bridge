import { useCallback, useEffect, useRef, useState } from "react";
import {
  OLModal,
  OLModalHeader,
  OLModalTitle,
  OLModalBody,
} from "@/shared/components/ol/ol-modal";
import OLButton from "@/shared/components/ol/ol-button";
import OLFormControl from "@/shared/components/ol/ol-form-control";
import OLFormSelect from "@/shared/components/ol/ol-form-select";
import Notification from "@/shared/components/notification";
import { getJSON, getUserFacingMessage } from "@/infrastructure/fetch-json";
import type {
  ChatSession,
  PublicConnection,
  SessionSummary,
} from "../../../shared/chat";

const statusText = (s: SessionSummary) =>
  s.archivedAt
    ? "Archived"
    : s.runId
      ? s.status === "waiting_permission"
        ? "Awaiting approval"
        : s.status === "cancelling"
          ? "Stopping"
          : "Working"
      : s.status === "interrupted"
        ? "Interrupted"
        : "Ready to continue";

export function AgentConversationHistory({
  projectId,
  currentId,
  connections,
  onSelect,
  onHide,
}: {
  projectId: string;
  currentId: string;
  connections: PublicConnection[];
  onSelect: (id: string) => void;
  onHide: () => void;
}) {
  const [search, setSearch] = useState("");
  const [archived, setArchived] = useState(false);
  const [items, setItems] = useState<SessionSummary[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [more, setMore] = useState(false);
  const request = useRef(0);
  const load = useCallback(
    async (after?: SessionSummary) => {
      const generation = ++request.current;
      setBusy(true);
      setError("");
      const query = new URLSearchParams({
        projectId,
        search,
        archived: archived ? "1" : "0",
      });
      if (after) {
        query.set("before", after.updatedAt);
        query.set("beforeId", after.id);
      }
      try {
        const page = await getJSON<SessionSummary[]>(
          `/user/agent/chat/sessions?${query}`,
        );
        if (generation !== request.current) return;
        setItems((previous) =>
          after
            ? [
                ...previous,
                ...page.filter((s) => !previous.some((p) => p.id === s.id)),
              ]
            : page,
        );
        setMore(page.length === 30);
      } catch (e) {
        if (generation === request.current)
          setError(
            getUserFacingMessage(e as Error) ||
              "Unable to load conversation history. Please try again.",
          );
      } finally {
        if (generation === request.current) setBusy(false);
      }
    },
    [projectId, search, archived],
  );
  useEffect(() => {
    setItems([]);
    setMore(false);
    void load();
    return () => {
      request.current++;
    };
  }, [load]);
  return (
    <OLModal
      show
      onHide={onHide}
      themed
      size="lg"
      className="agent-conversations-modal"
    >
      <OLModalHeader closeButton>
        <OLModalTitle>Conversation history</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        <p className="small">
          Only your conversations in this project are shown. Chat history is
          stored on the Overleaf server.
        </p>
        <div className="d-flex gap-2 mb-3">
          <OLFormControl
            type="search"
            aria-label="Search conversations"
            placeholder="Search conversation titles"
            maxLength={100}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <OLFormSelect
            aria-label="Conversation filter"
            value={archived ? "archived" : "active"}
            onChange={(e) => setArchived(e.target.value === "archived")}
          >
            <option value="active">Recent conversations</option>
            <option value="archived">Archived</option>
          </OLFormSelect>
        </div>
        {error && <Notification type="error" content={error} />}
        <div
          className="agent-conversation-list"
          aria-label="Conversations"
          aria-busy={busy}
        >
          {items.map((s) => (
            <OLButton
              key={s.id}
              variant="secondary"
              className="agent-conversation-item"
              aria-current={s.id === currentId ? "true" : undefined}
              onClick={() => onSelect(s.id)}
            >
              <span className="agent-conversation-title">{s.title}</span>
              <span className="small agent-conversation-meta">
                {connections.find((c) => c.id === s.connectionId)?.runtime ||
                  "Agent"}{" "}
                · {statusText(s)} · {new Date(s.updatedAt).toLocaleString()}
              </span>
            </OLButton>
          ))}
          {!busy && !items.length && (
            <p className="small">
              {search
                ? "No matching conversations found."
                : archived
                  ? "No archived conversations yet."
                  : "Conversations appear here after you send the first message."}
            </p>
          )}
        </div>
        {busy && (
          <p role="status" className="small">
            Loading conversation…
          </p>
        )}
        {more && (
          <OLButton
            variant="secondary"
            disabled={busy}
            onClick={() => void load(items.at(-1))}
          >
            Load more
          </OLButton>
        )}
        {error && (
          <OLButton
            variant="secondary"
            disabled={busy}
            onClick={() => void load()}
          >
            Retry
          </OLButton>
        )}
      </OLModalBody>
    </OLModal>
  );
}

export function AgentConversationSettings({
  session,
  suggestedConnectionId,
  connections,
  onUpdate,
  onHide,
}: {
  session: ChatSession;
  suggestedConnectionId?: string;
  connections: PublicConnection[];
  onUpdate: (change: {
    title?: string;
    archived?: boolean;
    connectionId?: string;
  }) => Promise<void>;
  onHide: () => void;
}) {
  const [title, setTitle] = useState(session.title);
  const [connectionId, setConnectionId] = useState(
    suggestedConnectionId || session.connectionId,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const selected = connections.find((c) => c.id === connectionId);
  const disabled = busy || Boolean(session.runId);
  async function update(change: Parameters<typeof onUpdate>[0]) {
    setBusy(true);
    setError("");
    try {
      await onUpdate(change);
      onHide();
    } catch (e) {
      setError(
        getUserFacingMessage(e as Error) ||
          "Unable to save changes. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <OLModal
      show
      onHide={() => !busy && onHide()}
      themed
      className="agent-conversations-modal"
    >
      <OLModalHeader closeButton>
        <OLModalTitle>Manage conversation</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        {error && <Notification type="error" content={error} />}
        <details className="small mb-3">
          <summary>
            Where is history stored, and how does reconnection work?
          </summary>
          <p className="mt-2">
            Chat history is stored on the Overleaf server, scoped to your
            account and project. Local connection credentials, working
            directories and session indexes are stored in
            <code>~/.config/overleaf-agent/</code>. On Windows, ~ means your
            user directory. With a custom --config path, files are stored next
            to that configuration file.
          </p>
          <p>
            After restarting, the connector tries to resume the original local
            agent session. If you change devices or agents, or the original
            session is unavailable, it uses the latest 20 user and assistant
            messages (up to 40,000 characters) to continue, excluding tool
            details. Sign-in or network errors prompt a retry. Reconnecting does
            not automatically resubmit interrupted tasks.
          </p>
          <p>
            Session indexes are stored in{" "}
            <code>sessions/&lt;connection-id&gt;/</code>, and only record
            session mappings. Codex and Claude manage their native history,
            stored by default in <code>~/.codex/sessions/</code> and{" "}
            <code>~/.claude/projects/</code>. Archiving a web conversation
            preserves these records.
          </p>
        </details>
        {session.runId && (
          <p role="status">
            Stop the current task before managing this conversation.
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!disabled && title.trim()) void update({ title: title.trim() });
          }}
        >
          <label htmlFor="agent-conversation-title" className="form-label">
            Conversation title
          </label>
          <OLFormControl
            id="agent-conversation-title"
            type="text"
            value={title}
            maxLength={100}
            disabled={disabled}
            onChange={(e) => setTitle(e.target.value)}
          />
          <OLButton
            type="submit"
            className="mt-2"
            variant="secondary"
            disabled={
              disabled || !title.trim() || title.trim() === session.title
            }
          >
            Save title
          </OLButton>
        </form>
        {!session.archivedAt && (
          <div className="mt-4">
            <label
              htmlFor="agent-conversation-connection"
              className="form-label"
            >
              Agent for this conversation
            </label>
            <OLFormSelect
              id="agent-conversation-connection"
              value={connectionId}
              disabled={disabled}
              onChange={(e) => setConnectionId(e.target.value)}
            >
              {!connections.some((c) => c.id === session.connectionId) && (
                <option value={session.connectionId}>
                  Original connection unavailable
                </option>
              )}
              {connections
                .filter(
                  (c) =>
                    c.id === session.connectionId ||
                    (!c.revoked && c.availableInProject !== false),
                )
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.runtime} · {c.online ? "Online" : "Offline"}
                  </option>
                ))}
            </OLFormSelect>
            <p className="small mt-2">
              Switching preserves this chat history. The new agent rebuilds
              context from recent messages. Check the document before
              continuing; previous tasks are not retried automatically.
            </p>
            {selected?.online && !selected.canRebind && (
              <p className="small">
                Download the latest connector to continue an existing
                conversation with this connection.
              </p>
            )}
            <OLButton
              variant="secondary"
              disabled={
                disabled ||
                connectionId === session.connectionId ||
                !selected?.online ||
                !selected.canRebind
              }
              onClick={() => void update({ connectionId })}
            >
              Continue with selected agent
            </OLButton>
          </div>
        )}
        <div className="mt-4">
          <p className="small">
            Archiving hides the conversation and preserves its history. You can
            restore it from conversation history.
          </p>
          <OLButton
            variant="secondary"
            disabled={disabled}
            onClick={() => void update({ archived: !session.archivedAt })}
          >
            {session.archivedAt
              ? "Restore conversation"
              : "Archive conversation"}
          </OLButton>
        </div>
      </OLModalBody>
    </OLModal>
  );
}
