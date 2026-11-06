import { Fragment, useMemo, useState, type ReactNode } from "react";
import { marked } from "marked";
import OLButton from "@/shared/components/ol/ol-button";
import type { ChatMessage } from "../../../shared/chat";

// Marked's inline tokens contain escaped entities. Decode in a text-only
// element; literal angle brackets never enter the HTML parser as markup.
function textValue(value: string) {
  if (!value.includes("&")) return value;
  const element = document.createElement("textarea");
  element.innerHTML = value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return element.value;
}

function linkTarget(value: string) {
  if (!/^(https?:|mailto:|\/(?![\/\\]))/i.test(value)) return undefined;
  try {
    const url = new URL(value, "https://overleaf.invalid");
    return ["https:", "http:", "mailto:"].includes(url.protocol)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function CodeBlock({ text, language }: { text: string; language?: string }) {
  const [copied, setCopied] = useState<{ text: string; message: string }>();
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied({ text, message: "已复制" });
    } catch {
      setCopied({ text, message: "复制失败，请手动选择代码复制" });
    }
  }
  return (
    <div className="agent-code-block">
      <div className="agent-code-toolbar">
        <span>{language?.split(/\s+/)[0].slice(0, 32) || "代码"}</span>
        <OLButton variant="secondary" size="sm" onClick={copy}>
          复制代码
        </OLButton>
      </div>
      {copied?.text === text && (
        <span className="small" role="status">
          {copied.message}
        </span>
      )}
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

function tokensToReact(tokens: marked.Token[], depth = 0): ReactNode {
  return tokens.map((token, index) => {
    let content: ReactNode;
    // The server bounds message size. Also bound renderer recursion for nested
    // generated lists/quotes, retaining their source as readable text.
    if (depth > 24) return <Fragment key={index}>{token.raw}</Fragment>;
    const children = () =>
      tokensToReact("tokens" in token ? token.tokens || [] : [], depth + 1);
    switch (token.type) {
      case "space":
        content = null;
        break;
      case "paragraph":
        content = <p>{children()}</p>;
        break;
      case "heading":
        content = (
          <div
            role="heading"
            aria-level={token.depth}
            className="agent-markdown-heading"
          >
            {children()}
          </div>
        );
        break;
      case "strong":
        content = <strong>{children()}</strong>;
        break;
      case "em":
        content = <em>{children()}</em>;
        break;
      case "del":
        content = <del>{children()}</del>;
        break;
      case "br":
        content = <br />;
        break;
      case "hr":
        content = <hr />;
        break;
      case "blockquote":
        content = <blockquote>{children()}</blockquote>;
        break;
      case "code":
        content = <CodeBlock text={token.text} language={token.lang} />;
        break;
      case "codespan":
        content = <code>{textValue(token.text)}</code>;
        break;
      case "link":
      case "image": {
        const href = linkTarget(token.href);
        const label =
          token.type === "image"
            ? `图片：${token.text || "查看图片"}`
            : children();
        // Images are explicit links, so rendering a response makes no request
        // to an Agent-supplied remote host. HTML is always rendered as text.
        content = href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={token.title || undefined}
          >
            {label}
          </a>
        ) : (
          <span>{label}</span>
        );
        break;
      }
      case "list": {
        const items = token.items.map((item, i) => (
          <li key={i}>
            {item.task && (
              <span aria-label={item.checked ? "已完成" : "未完成"}>
                {item.checked ? "☑ " : "☐ "}
              </span>
            )}
            {tokensToReact(item.tokens, depth + 1)}
          </li>
        ));
        content = token.ordered ? (
          <ol start={token.start || 1}>{items}</ol>
        ) : (
          <ul>{items}</ul>
        );
        break;
      }
      case "table":
        content = (
          <div
            className="agent-markdown-table"
            role="region"
            aria-label="回复中的表格"
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  {token.header.map((cell, i) => (
                    <th key={i}>{tokensToReact(cell.tokens, depth + 1)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {token.rows.map((row, i) => (
                  <tr key={i}>
                    {row.map((cell, j) => (
                      <td key={j}>{tokensToReact(cell.tokens, depth + 1)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        break;
      case "text":
        content = token.tokens ? children() : textValue(token.text);
        break;
      case "escape":
        content = textValue(token.text);
        break;
      default:
        content = token.raw;
    }
    return <Fragment key={index}>{content}</Fragment>;
  });
}

export function AgentMarkdown({ text }: { text: string }) {
  const tokens = useMemo(() => {
    try {
      return marked.lexer(text, { gfm: true });
    } catch {
      return undefined;
    }
  }, [text]);
  return (
    <div className="agent-message-text agent-markdown">
      {tokens ? tokensToReact(tokens) : text}
    </div>
  );
}

function ToolMessage({ message }: { message: ChatMessage }) {
  const [expanded, setExpanded] = useState<boolean>();
  const open = expanded ?? message.state === "failed";
  const label =
    (
      {
        pending: "准备中",
        in_progress: "执行中",
        completed: "完成",
        failed: "失败",
      } as Record<string, string>
    )[message.state || ""] || "工具调用";
  return (
    <details open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          setExpanded(!open);
        }}
      >
        {message.title || "工具调用"} · {label}
      </summary>
      <pre>{message.text || "暂未返回详细结果"}</pre>
    </details>
  );
}

export default function AgentMessage({
  message,
  agentName,
}: {
  message: ChatMessage;
  agentName?: string;
}) {
  return (
    <div className={`agent-chat-message agent-message-${message.role}`}>
      {message.role === "tool" ? (
        <ToolMessage message={message} />
      ) : (
        <>
          <div className="agent-message-author small">
            {message.role === "user"
              ? "你"
              : message.role === "assistant"
                ? message.actorName || agentName || "Agent"
                : "任务状态"}
          </div>
          {message.role === "assistant" ? (
            <AgentMarkdown text={message.text} />
          ) : (
            <div className="agent-message-text">{message.text}</div>
          )}
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
  );
}
