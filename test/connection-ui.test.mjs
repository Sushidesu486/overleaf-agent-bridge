import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import React from "react";
import { create, act } from "react-test-renderer";
import { build } from "esbuild";
let AgentChat, AgentConnectionModal, AgentMessage;
before(async () => {
  await mkdir(".local", { recursive: true });
  const outdir = resolve(".local/connection-ui");
  await build({
    entryPoints: {
      chat: "extensions/agent-access/frontend/js/components/agent-chat.tsx",
      message:
        "extensions/agent-access/frontend/js/components/agent-message.tsx",
      modal:
        "extensions/agent-access/frontend/js/components/agent-connection-modal.tsx",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime"],
    outdir,
    outExtension: { ".js": ".mjs" },
    plugins: [
      {
        name: "native-ui-fixture",
        setup(b) {
          b.onResolve(
            {
              filter:
                /^@\/|^\.\/agent-(connection-modal|page)$|^react-bootstrap$/,
            },
            (args) => ({ path: args.path, namespace: "native-ui-fixture" }),
          );
          b.onLoad(
            { filter: /.*/, namespace: "native-ui-fixture" },
            ({ path }) => {
              let contents;
              if (path === "react-bootstrap")
                contents =
                  'import React from "react"; const Stub=p=>React.createElement("div",p,p.children); export const Tab={Pane:Stub},TabContainer=Stub,TabContent=Stub,Nav=Stub,NavLink=Stub;';
              else if (path === "./agent-page")
                contents = "export const AgentSettings=()=>null;";
              else if (path.endsWith("/ol-modal"))
                contents =
                  'import React from "react"; const Stub=p=>React.createElement("div",p,p.children); export const OLModal=Stub,OLModalHeader=Stub,OLModalTitle=Stub,OLModalBody=Stub;';
              else if (path.includes("fetch-json"))
                contents =
                  "export const getJSON=(...a)=>globalThis.agentUI.get(...a); export const postJSON=(...a)=>globalThis.agentUI.post(...a); export const getUserFacingMessage=e=>e.message;";
              else if (path.includes("project-context"))
                contents =
                  'export const useProjectContext=()=>({projectId:"project",name:"Fixture"});';
              else if (path.includes("editor-open-doc-context"))
                contents =
                  'import {createContext} from "react"; export const EditorOpenDocContext=createContext(null);';
              else if (path.includes("editor-selection-context"))
                contents =
                  'import {createContext} from "react"; export const EditorSelectionContext=createContext(null);';
              else {
                const tag = path.includes("form-select")
                  ? "select"
                  : path.includes("form-control")
                    ? "textarea"
                    : path.includes("notification")
                      ? "notification"
                      : path.includes("modal")
                        ? "modal"
                        : path.includes("header")
                          ? "header"
                          : "button";
                contents = `import React from "react"; export default function Stub(props){return React.createElement(${JSON.stringify(tag)},props,props.children || props.content || props.title)}`;
              }
              return { contents, loader: "js" };
            },
          );
        },
      },
    ],
  });
  AgentChat = (await import(pathToFileURL(resolve(outdir, "chat.mjs")).href))
    .default;
  AgentMessage = (
    await import(pathToFileURL(resolve(outdir, "message.mjs")).href)
  ).default;
  AgentConnectionModal = (
    await import(pathToFileURL(resolve(outdir, "modal.mjs")).href)
  ).default;
});
const old = {
  id: "old",
  name: "Old Agent",
  online: false,
  revoked: false,
  runtime: "Codex",
  canRebind: true,
  projects: ["project"],
};
const fresh = {
  id: "fresh",
  name: "New Agent",
  online: true,
  revoked: false,
  runtime: "Codex",
  canRebind: true,
  projects: ["project"],
};
const session = (id, connectionId) => ({
  id,
  connectionId,
  projectId: "project",
  userId: "user",
  title: id,
  messages: [{ id: "m", role: "user", text: "saved content" }],
  status: "idle",
  runId: null,
  permission: null,
  agentState: "ready",
  revision: 1,
  updatedAt: "2026-11-06T08:00:00.000Z",
  createdAt: "2026-11-06T08:00:00.000Z",
});
async function fixture({
  connections = [old],
  sessions = [session("previous", "old")],
  saved = "previous",
  failInitialSessions = false,
} = {}) {
  const intervals = new Set(),
    sources = new Set(),
    storage = new Map(
      saved === null ? [] : [["overleaf-agent-session:project", saved]],
    );
  const real = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    EventSource: globalThis.EventSource,
    localStorage: globalThis.localStorage,
  };
  const state = {
    connections,
    sessions,
    posts: [],
    async get(url) {
      if (failInitialSessions && !url.includes("/connections")) {
        failInitialSessions = false;
        throw new Error("temporary session lookup failure");
      }
      if (url.includes("/connections")) return this.connections;
      const parsed = new URL(url, "http://localhost");
      if (parsed.pathname === "/user/agent/chat/sessions")
        return this.sessions.filter(
          (s) =>
            Boolean(s.archivedAt) ===
              (parsed.searchParams.get("archived") === "1") &&
            s.title.includes(parsed.searchParams.get("search") || ""),
        );
      const found = this.sessions.find(
        (s) => s.id === parsed.pathname.split("/").at(-1),
      );
      if (!found) throw Object.assign(new Error("not found"), { status: 404 });
      return structuredClone(found);
    },
    async post(url, options = {}) {
      this.posts.push({ url, body: options.body });
      if (url === "/user/agent/chat/sessions") {
        const created = {
          ...session("created", options.body.connectionId),
          title: "新对话",
          messages: [],
        };
        this.sessions.push(created);
        return structuredClone(created);
      }
      const found = this.sessions.find((s) => s.id === url.split("/").at(-2));
      assert.ok(found);
      if (url.endsWith("/settings")) {
        const { title, archived, connectionId } = options.body;
        if (title) found.title = title;
        if (archived) found.archivedAt = "now";
        if (archived === false) delete found.archivedAt;
        if (connectionId) found.connectionId = connectionId;
      } else if (url.endsWith("/messages")) {
        found.messages.push({
          id: "sent",
          role: "user",
          text: options.body.text,
        });
        found.title = options.body.text;
      } else throw new Error("unexpected POST " + url);
      found.revision++;
      return structuredClone(found);
    },
  };
  globalThis.agentUI = state;
  globalThis.localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, v),
    removeItem: (k) => storage.delete(k),
  };
  globalThis.setInterval = (fn) => (intervals.add(fn), fn);
  globalThis.clearInterval = (fn) => intervals.delete(fn);
  globalThis.EventSource = class {
    constructor(url) {
      this.id = url.split("/").at(-2);
      this.listeners = {};
      sources.add(this);
    }
    addEventListener(type, fn) {
      this.listeners[type] = fn;
      queueMicrotask(() => {
        if (!sources.has(this)) return;
        const value = state.sessions.find((s) => s.id === this.id);
        if (value) fn({ data: JSON.stringify(value) });
      });
    }
    close() {
      sources.delete(this);
    }
  };
  const scroll = { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 };
  let view;
  await act(async () => {
    view = create(React.createElement(AgentChat), {
      createNodeMock: (node) =>
        node.props["aria-label"] === "Agent 对话记录" ? scroll : null,
    });
  });
  return {
    state,
    storage,
    view,
    scroll,
    async publish(value) {
      state.sessions = state.sessions.map((s) =>
        s.id === value.id ? value : s,
      );
      await act(async () => {
        for (const source of sources)
          if (source.id === value.id)
            source.listeners.session?.({ data: JSON.stringify(value) });
      });
    },
    async poll() {
      await act(async () => {
        for (const fn of intervals) fn();
      });
    },
    async close() {
      await act(async () => view.unmount());
      Object.assign(globalThis, real);
      delete globalThis.agentUI;
    },
  };
}
const button = (f, label) =>
  f.view.root
    .findAllByType("button")
    .find(
      (n) => n.props.accessibilityLabel === label || n.children.includes(label),
    );
const title = (f) => f.view.root.findByType("strong").children.join("");
const click = async (f, label) => {
  const b = button(f, label);
  assert.ok(b, label);
  await act(async () => b.props.onClick());
};
const message = (f) =>
  f.view.root.findByProps({ "aria-label": "发给 Agent 的消息" });

test("streaming follows the latest reply until the reader scrolls up", async () => {
  const f = await fixture();
  try {
    assert.equal(f.scroll.scrollTop, 1000);
    const record = f.view.root.findByProps({ "aria-label": "Agent 对话记录" });
    f.scroll.scrollTop = 100;
    await act(async () => record.props.onScroll({ currentTarget: f.scroll }));
    f.scroll.scrollHeight = 1600;
    await f.publish({ ...f.state.sessions[0], revision: 2 });
    assert.equal(f.scroll.scrollTop, 100);
    await click(f, "回到最新");
    assert.equal(f.scroll.scrollTop, 1600);
    f.scroll.scrollHeight = 1800;
    await f.publish({ ...f.state.sessions[0], revision: 3 });
    assert.equal(f.scroll.scrollTop, 1800);
  } finally {
    await f.close();
  }
});

test("send shortcut respects readiness and Chinese IME composition", async () => {
  const preparing = { ...session("previous", "old"), agentState: "preparing" };
  const f = await fixture({
    connections: [{ ...old, online: true }],
    sessions: [preparing],
  });
  const key = {
    key: "Enter",
    ctrlKey: true,
    nativeEvent: {},
    preventDefault() {},
  };
  try {
    await act(async () =>
      message(f).props.onChange({ target: { value: "中文消息" } }),
    );
    await act(async () => message(f).props.onKeyDown(key));
    assert.equal(f.state.posts.length, 0);
    await f.publish({ ...preparing, agentState: "ready", revision: 2 });
    await act(async () => {
      message(f).props.onCompositionStart();
      message(f).props.onKeyDown(key);
      message(f).props.onCompositionEnd();
      message(f).props.onKeyDown({
        ...key,
        nativeEvent: { isComposing: true },
      });
      message(f).props.onKeyDown({ ...key, keyCode: 229 });
    });
    assert.equal(f.state.posts.length, 0);
    await act(async () => message(f).props.onKeyDown(key));
    assert.equal(f.state.posts.length, 1);
    assert.equal(f.state.posts[0].body.text, "中文消息");
  } finally {
    await f.close();
  }
});

test("a pending send preserves the next draft, including a conversation's first send", async () => {
  for (const isNew of [false, true]) {
    const f = await fixture({
      connections: [{ ...old, online: true }],
      ...(isNew ? { saved: "", sessions: [] } : {}),
    });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const post = f.state.post.bind(f.state);
    f.state.post = async (url, options) => {
      if (url.endsWith("/messages")) await gate;
      return post(url, options);
    };
    try {
      await act(async () =>
        message(f).props.onChange({ target: { value: "send this" } }),
      );
      let sending;
      await act(async () => {
        sending = button(f, "发送").props.onClick();
      });
      await act(async () =>
        message(f).props.onChange({ target: { value: "next draft" } }),
      );
      await act(async () => {
        release();
        await sending;
      });
      assert.equal(message(f).props.value, "next draft");
      assert.equal(
        f.state.posts.find((p) => p.url.endsWith("/messages")).body.text,
        "send this",
      );
    } finally {
      release();
      await f.close();
    }
  }
});

test("Markdown renders structure without active HTML or remote images; code copying preserves LaTeX", async () => {
  const code = String.raw`\frac{x}{y} < z & \alpha`;
  const text = `## Answer\n\n**Strong** and [docs](https://example.com)\n\n- first\n- second\n\n\`\`\`latex\n${code}\n\`\`\`\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert(1)) ![remote](https://example.com/image.png)`;
  let view, copied;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (value) => {
          copied = value;
        },
      },
    },
  });
  try {
    await act(async () => {
      view = create(
        React.createElement(AgentMessage, {
          message: { id: "m", role: "assistant", text },
        }),
      );
    });
    assert.equal(view.root.findAllByType("strong").length, 1);
    assert.equal(view.root.findAllByType("li").length, 2);
    assert.equal(view.root.findAllByType("img").length, 0);
    assert.equal(view.root.findAllByType("script").length, 0);
    assert.deepEqual(
      view.root.findAllByType("a").map((a) => a.props.href),
      ["https://example.com", "https://example.com/image.png"],
    );
    assert.ok(
      view.root
        .findAllByType("a")
        .every((a) => a.props.rel === "noopener noreferrer"),
    );
    const copy = view.root
      .findAllByType("button")
      .find((b) => b.children.includes("复制代码"));
    await act(async () => copy.props.onClick());
    assert.equal(copied, code);
  } finally {
    if (view) await act(async () => view.unmount());
    if (descriptor) Object.defineProperty(globalThis, "navigator", descriptor);
    else delete globalThis.navigator;
  }
});

test("tool disclosure keeps the reader's choice across streamed updates", async () => {
  let view;
  const tool = {
    id: "tool",
    role: "tool",
    title: "Read file",
    text: "result",
    state: "in_progress",
  };
  try {
    await act(async () => {
      view = create(React.createElement(AgentMessage, { message: tool }));
    });
    assert.equal(view.root.findByType("details").props.open, false);
    await act(async () =>
      view.root.findByType("summary").props.onClick({ preventDefault() {} }),
    );
    await act(async () =>
      view.update(
        React.createElement(AgentMessage, {
          message: { ...tool, state: "completed" },
        }),
      ),
    );
    assert.equal(view.root.findByType("details").props.open, true);
    await act(async () =>
      view.root.findByType("summary").props.onClick({ preventDefault() {} }),
    );
    await act(async () =>
      view.update(
        React.createElement(AgentMessage, {
          message: { ...tool, state: "failed" },
        }),
      ),
    );
    assert.equal(view.root.findByType("details").props.open, false);
  } finally {
    if (view) await act(async () => view.unmount());
  }
});

test("an online connector never replaces the conversation being read", async () => {
  const f = await fixture();
  try {
    assert.equal(title(f), "previous");
    f.state.connections = [old, fresh];
    f.state.sessions.unshift(session("other", "fresh"));
    await f.poll();
    assert.equal(title(f), "previous");
    assert.ok(button(f, "选择 Agent 继续此对话"));
    assert.equal(f.storage.get("overleaf-agent-session:project"), "previous");
    assert.equal(f.state.posts.length, 0);
  } finally {
    await f.close();
  }
});

test("new conversation stays local until first send and drafts survive history navigation", async () => {
  const f = await fixture({ connections: [{ ...old, online: true }] });
  try {
    await act(async () =>
      message(f).props.onChange({ target: { value: "old draft" } }),
    );
    await click(f, "新对话");
    assert.equal(title(f), "新对话");
    assert.equal(message(f).props.value, "");
    assert.equal(f.state.posts.length, 0);
    await act(async () =>
      message(f).props.onChange({ target: { value: "new draft" } }),
    );
    await click(f, "对话历史");
    const item = f.view.root
      .findAllByType("button")
      .find((n) => n.props.className === "agent-conversation-item");
    await act(async () => item.props.onClick());
    assert.equal(title(f), "previous");
    assert.equal(message(f).props.value, "old draft");
    await click(f, "新对话");
    assert.equal(message(f).props.value, "new draft");
    await click(f, "发送");
    assert.equal(
      f.state.posts.filter((p) => p.url === "/user/agent/chat/sessions").length,
      1,
    );
    assert.equal(title(f), "new draft");
    assert.equal(message(f).props.value, "");
  } finally {
    await f.close();
  }
});

test("an explicitly selected new draft remains a draft after reload", async () => {
  const f = await fixture({ saved: "", connections: [old, fresh] });
  try {
    assert.equal(title(f), "新对话");
    assert.equal(f.state.posts.length, 0);
  } finally {
    await f.close();
  }
});

test("renaming, archiving and restoring update the same conversation", async () => {
  const f = await fixture({ connections: [{ ...old, online: true }] });
  try {
    await click(f, "管理当前对话");
    await act(async () =>
      f.view.root
        .findByProps({ id: "agent-conversation-title" })
        .props.onChange({ target: { value: "Useful title" } }),
    );
    await act(async () =>
      f.view.root.findByType("form").props.onSubmit({ preventDefault() {} }),
    );
    assert.equal(title(f), "Useful title");
    await click(f, "管理当前对话");
    await click(f, "归档对话");
    assert.equal(message(f).props.disabled, true);
    assert.equal(f.state.sessions.length, 1);
    await click(f, "管理当前对话");
    const restores = f.view.root
      .findAllByType("button")
      .filter((n) => n.children.includes("恢复对话"));
    await act(async () => restores.at(-1).props.onClick());
    assert.equal(message(f).props.disabled, false);
    assert.equal(f.state.sessions[0].id, "previous");
  } finally {
    await f.close();
  }
});

test("switching Agent preserves conversation identity, messages and draft", async () => {
  const f = await fixture({ connections: [old, fresh] });
  try {
    await act(async () =>
      message(f).props.onChange({ target: { value: "continue this" } }),
    );
    await click(f, "选择 Agent 继续此对话");
    await act(async () =>
      f.view.root
        .findByProps({ id: "agent-conversation-connection" })
        .props.onChange({ target: { value: "fresh" } }),
    );
    await click(f, "使用所选 Agent 继续");
    assert.equal(title(f), "previous");
    assert.equal(f.state.sessions[0].connectionId, "fresh");
    assert.equal(f.state.sessions[0].messages[0].text, "saved content");
    assert.equal(message(f).props.value, "continue this");
  } finally {
    await f.close();
  }
});

test("history searches and archived view remain scoped to the current project", async () => {
  const f = await fixture({
    sessions: [
      session("previous", "old"),
      { ...session("archived", "old"), archivedAt: "now" },
    ],
  });
  try {
    await click(f, "对话历史");
    const items = () =>
      f.view.root
        .findAllByType("button")
        .filter((n) => n.props.className === "agent-conversation-item");
    assert.equal(items().length, 1);
    await act(async () =>
      f.view.root
        .findByProps({ "aria-label": "搜索对话" })
        .props.onChange({ target: { value: "not found" } }),
    );
    assert.equal(items().length, 0);
    await act(async () =>
      f.view.root
        .findByProps({ "aria-label": "搜索对话" })
        .props.onChange({ target: { value: "" } }),
    );
    await act(async () =>
      f.view.root
        .findByProps({ "aria-label": "对话范围" })
        .props.onChange({ target: { value: "archived" } }),
    );
    assert.equal(items().length, 1);
    await act(async () => items()[0].props.onClick());
    assert.equal(title(f), "archived");
    assert.equal(message(f).props.disabled, true);
  } finally {
    await f.close();
  }
});

test("a failed initial lookup recovers without switching away from saved history", async () => {
  const f = await fixture({
    failInitialSessions: true,
    connections: [old, fresh],
  });
  try {
    await f.poll();
    assert.equal(title(f), "previous");
  } finally {
    await f.close();
  }
});

test("online connectors for another project cannot take over this conversation", async () => {
  const f = await fixture({
    connections: [
      old,
      {
        ...fresh,
        availableInProject: false,
        projectNames: ["Another project"],
      },
    ],
  });
  try {
    assert.equal(title(f), "previous");
    assert.ok(!button(f, "选择 Agent 继续此对话"));
    assert.ok(
      f.view.root
        .findAllByProps({ role: "status" })
        .some((n) => n.children.join("").includes("Another project")),
    );
  } finally {
    await f.close();
  }
});

test("pairing modal selects only its matching online connection, once", async () => {
  const selected = [];
  globalThis.agentUI = {
    post: async () => ({
      code: "pair.secret",
      server: "http://localhost:18080",
      expiresAt: "later",
    }),
  };
  const props = {
    projectId: "project",
    projectName: "Fixture",
    connections: [old],
    onHide() {},
    refresh() {},
    onConnected: (id) => selected.push(id),
  };
  let view;
  try {
    await act(async () => {
      view = create(React.createElement(AgentConnectionModal, props));
    });
    const pairButton = view.root
      .findAllByType("button")
      .find((n) => n.children.includes("生成配对码"));
    await act(async () => pairButton.props.onClick());
    await act(async () =>
      view.update(
        React.createElement(AgentConnectionModal, {
          ...props,
          connections: [{ ...fresh, pairingId: "other" }],
        }),
      ),
    );
    assert.deepEqual(selected, []);
    const connected = { ...fresh, pairingId: "pair" };
    await act(async () =>
      view.update(
        React.createElement(AgentConnectionModal, {
          ...props,
          connections: [connected],
        }),
      ),
    );
    assert.deepEqual(selected, ["fresh"]);
    await act(async () =>
      view.update(
        React.createElement(AgentConnectionModal, {
          ...props,
          connections: [{ ...connected }],
        }),
      ),
    );
    assert.deepEqual(selected, ["fresh"]);
    assert.ok(
      view.root
        .findAllByType("notification")
        .some((n) => n.props.content.includes("连接成功")),
    );
  } finally {
    if (view) await act(async () => view.unmount());
    delete globalThis.agentUI;
  }
});
