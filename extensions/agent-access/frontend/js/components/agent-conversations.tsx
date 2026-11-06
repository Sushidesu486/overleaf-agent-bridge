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
    ? "已归档"
    : s.runId
      ? s.status === "waiting_permission"
        ? "等待确认"
        : s.status === "cancelling"
          ? "正在停止"
          : "处理中"
      : s.status === "interrupted"
        ? "已中断"
        : "可继续";

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
          setError(getUserFacingMessage(e as Error) || "读取历史失败，请重试");
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
        <OLModalTitle>对话历史</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        <p className="small">
          这里只显示你在当前项目的对话。聊天记录保存在 Overleaf 服务端。
        </p>
        <div className="d-flex gap-2 mb-3">
          <OLFormControl
            type="search"
            aria-label="搜索对话"
            placeholder="搜索对话标题"
            maxLength={100}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <OLFormSelect
            aria-label="对话范围"
            value={archived ? "archived" : "active"}
            onChange={(e) => setArchived(e.target.value === "archived")}
          >
            <option value="active">最近对话</option>
            <option value="archived">已归档</option>
          </OLFormSelect>
        </div>
        {error && <Notification type="error" content={error} />}
        <div
          className="agent-conversation-list"
          aria-label="对话列表"
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
                ? "没有找到匹配的对话。"
                : archived
                  ? "还没有归档的对话。"
                  : "发送第一条消息后，对话会保存在这里。"}
            </p>
          )}
        </div>
        {busy && (
          <p role="status" className="small">
            正在读取对话…
          </p>
        )}
        {more && (
          <OLButton
            variant="secondary"
            disabled={busy}
            onClick={() => void load(items.at(-1))}
          >
            加载更多
          </OLButton>
        )}
        {error && (
          <OLButton
            variant="secondary"
            disabled={busy}
            onClick={() => void load()}
          >
            重试
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
      setError(getUserFacingMessage(e as Error) || "保存失败，请重试");
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
        <OLModalTitle>管理当前对话</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        {error && <Notification type="error" content={error} />}
        <details className="small mb-3">
          <summary>记录保存在哪里？重连后如何继续？</summary>
          <p className="mt-2">
            聊天记录保存在 Overleaf
            服务端，按你的账号和项目隔离；本机连接器保存连接凭据和工作目录。
          </p>
          <p>
            连接器重启或切换 Agent 后，会用最近 20 条用户与助手消息（最多 4
            万字符）重建上下文，工具详情不包含在恢复上下文中。目前尚未接入 Agent
            原生 session 的恢复。
          </p>
        </details>
        {session.runId && <p role="status">请先停止当前任务，再管理对话。</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!disabled && title.trim()) void update({ title: title.trim() });
          }}
        >
          <label htmlFor="agent-conversation-title" className="form-label">
            对话标题
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
            保存标题
          </OLButton>
        </form>
        {!session.archivedAt && (
          <div className="mt-4">
            <label
              htmlFor="agent-conversation-connection"
              className="form-label"
            >
              执行当前对话的 Agent
            </label>
            <OLFormSelect
              id="agent-conversation-connection"
              value={connectionId}
              disabled={disabled}
              onChange={(e) => setConnectionId(e.target.value)}
            >
              {!connections.some((c) => c.id === session.connectionId) && (
                <option value={session.connectionId}>原连接不可用</option>
              )}
              {connections
                .filter(
                  (c) =>
                    c.id === session.connectionId ||
                    (!c.revoked && c.availableInProject !== false),
                )
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.runtime} · {c.online ? "在线" : "离线"}
                  </option>
                ))}
            </OLFormSelect>
            <p className="small mt-2">
              切换后保留当前聊天记录，新 Agent
              会根据最近的对话重建上下文。请检查文档后继续发送，不会自动重试之前的任务。
            </p>
            {selected?.online && !selected.canRebind && (
              <p className="small">
                此连接需要下载新版连接器，才能接手现有对话。
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
              使用所选 Agent 继续
            </OLButton>
          </div>
        )}
        <div className="mt-4">
          <p className="small">
            归档会收起对话，聊天记录仍保留；可从历史记录中恢复。
          </p>
          <OLButton
            variant="secondary"
            disabled={disabled}
            onClick={() => void update({ archived: !session.archivedAt })}
          >
            {session.archivedAt ? "恢复对话" : "归档对话"}
          </OLButton>
        </div>
      </OLModalBody>
    </OLModal>
  );
}
