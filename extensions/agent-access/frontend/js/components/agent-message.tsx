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
      setCopied({ text, message: "Copied" });
    } catch {
      setCopied({
        text,
        message: "Copy failed. Select and copy the code manually.",
      });
    }
  }
  return (
    <div className="agent-code-block">
      <div className="agent-code-toolbar">
        <span>{language?.split(/\s+/)[0].slice(0, 32) || "Code"}</span>
        <OLButton variant="secondary" size="sm" onClick={copy}>
          Copy code
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
            ? `Image: ${token.text || "View image"}`
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
              <span aria-label={item.checked ? "Completed" : "Incomplete"}>
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
            aria-label="Table in response"
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
        pending: "Preparing",
        in_progress: "Running",
        completed: "Completed",
        failed: "Failed",
      } as Record<string, string>
    )[message.state || ""] || "Tool call";
  return (
    <details open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          setExpanded(!open);
        }}
      >
        {message.title || "Tool call"} · {label}
      </summary>
      <pre>{message.text || "No details returned yet"}</pre>
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
              ? "You"
              : message.role === "assistant"
                ? message.actorName || agentName || "Agent"
                : "Task status"}
          </div>
          {message.role === "assistant" ? (
            <AgentMarkdown text={message.text} />
          ) : (
            <div className="agent-message-text">{message.text}</div>
          )}
          {message.attachment && (
            <div className="small">
              Attachment: {message.attachment.name}
              {message.attachment.text
                ? ` · Selection: ${message.attachment.text.length} characters`
                : ""}
            </div>
          )}
        </>
      )}
    </div>
  );
}
