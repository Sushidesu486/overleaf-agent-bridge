import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import React from "react";
import { create, act } from "react-test-renderer";
import { build } from "esbuild";
let AgentChat, AgentConnectionModal;
before(async () => {
  await mkdir(".local", { recursive: true });
  const outdir = resolve(".local/connection-ui");
  await build({
    entryPoints: {
      chat: "extensions/agent-access/frontend/js/components/agent-chat.tsx",
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
  projects: ["project"],
};
const fresh = {
  id: "fresh",
  name: "New Agent",
  online: true,
  revoked: false,
  runtime: "Codex",
  projects: ["project"],
};
const session = (id, connectionId) => ({
  id,
  connectionId,
  projectId: "project",
  userId: "user",
  title: id,
  messages: [],
  status: "idle",
  runId: null,
  permission: null,
  agentState: "ready",
  revision: 1,
  updatedAt: "now",
  createdAt: "now",
});
async function fixture({
  connections = [old],
  sessions = [session("previous", "old")],
  saved = "previous",
  failInitialSessions = false,
} = {}) {
  const intervals = new Set(),
    sources = new Set(),
    storage = new Map(saved ? [["overleaf-agent-session:project", saved]] : []);
  const real = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    EventSource: globalThis.EventSource,
    localStorage: globalThis.localStorage,
  };
  const state = {
    connections,
    sessions,
    async get(url) {
      if (failInitialSessions && !url.includes("/connections")) {
        failInitialSessions = false;
        throw new Error("temporary session lookup failure");
      }
      return url.includes("/connections") ? this.connections : this.sessions;
    },
    async post() {
      throw new Error("unexpected POST");
    },
  };
  globalThis.agentUI = state;
  globalThis.localStorage = {
    getItem: (k) => storage.get(k) || null,
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
  let view;
  await act(async () => {
    view = create(React.createElement(AgentChat));
  });
  return {
    state,
    view,
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
test("sidebar selects a newly connected Agent instead of keeping an offline saved session", async () => {
  const f = await fixture();
  try {
    assert.equal(
      f.view.root.findByProps({ "aria-label": "选择 Agent" }).props.value,
      "old",
    );
    f.state.connections = [old, fresh];
    f.state.sessions = [
      session("prepared", "fresh"),
      session("previous", "old"),
    ];
    await f.poll();
    assert.equal(
      f.view.root.findByProps({ "aria-label": "选择 Agent" }).props.value,
      "fresh",
      "connector is online but sidebar is pinned to its old offline session",
    );
    assert.ok(
      f.view.root
        .findAllByType("span")
        .some((n) => n.children.includes("Agent 已连接")),
    );
  } finally {
    await f.close();
  }
});
test("sidebar restores the online connection when local storage points at an old disconnected session", async () => {
  const f = await fixture({
    connections: [old, fresh],
    sessions: [session("prepared", "fresh"), session("previous", "old")],
  });
  try {
    assert.equal(
      f.view.root.findByProps({ "aria-label": "选择 Agent" }).props.value,
      "fresh",
    );
  } finally {
    await f.close();
  }
});
test("sidebar remembers the user-selected conversation across reloads", async () => {
  const f = await fixture({
    connections: [{ ...old, online: true }, fresh],
    sessions: [session("prepared", "fresh"), session("previous", "old")],
    saved: "previous",
  });
  try {
    assert.equal(
      f.view.root.findByProps({ "aria-label": "选择对话" }).props.value,
      "previous",
      "initial empty state must not erase saved conversation before loading it",
    );
  } finally {
    await f.close();
  }
});
test("sidebar preserves an unsent draft and offers an explicit online switch", async () => {
  const f = await fixture();
  try {
    await act(async () =>
      f.view.root
        .findByProps({ "aria-label": "发给 Agent 的消息" })
        .props.onChange({ target: { value: "my unsent draft" } }),
    );
    f.state.connections = [old, fresh];
    f.state.sessions = [
      session("prepared", "fresh"),
      session("previous", "old"),
    ];
    await f.poll();
    assert.equal(
      f.view.root.findByProps({ "aria-label": "选择 Agent" }).props.value,
      "old",
    );
    const switchButton = f.view.root
      .findAllByType("button")
      .find((n) => n.children.includes("使用在线 Agent"));
    assert.ok(switchButton);
    await act(async () => switchButton.props.onClick());
    assert.equal(
      f.view.root.findByProps({ "aria-label": "选择 Agent" }).props.value,
      "fresh",
    );
    assert.equal(
      f.view.root.findByProps({ "aria-label": "发给 Agent 的消息" }).props
        .value,
      "my unsent draft",
    );
  } finally {
    await f.close();
  }
});
test("explicit history selection survives polling while another Agent is online", async () => {
  const f = await fixture({
    connections: [old, fresh],
    sessions: [session("prepared", "fresh"), session("previous", "old")],
    saved: "prepared",
  });
  try {
    await act(async () =>
      f.view.root
        .findByProps({ "aria-label": "选择对话" })
        .props.onChange({ target: { value: "previous" } }),
    );
    await f.poll();
    assert.equal(
      f.view.root.findByProps({ "aria-label": "选择对话" }).props.value,
      "previous",
    );
  } finally {
    await f.close();
  }
});
test("online connections for other projects are explained and cannot become the active Agent", async () => {
  const elsewhere = {
    ...fresh,
    availableInProject: false,
    projectNames: ["Another project"],
  };
  const f = await fixture({ connections: [old, elsewhere] });
  try {
    assert.equal(
      f.view.root.findByProps({ "aria-label": "选择 Agent" }).props.value,
      "old",
    );
    const notice = f.view.root
      .findAllByProps({ role: "status" })
      .find((n) => n.children.join("").includes("Another project"));
    assert.ok(notice);
    assert.ok(
      !f.view.root
        .findByProps({ "aria-label": "选择 Agent" })
        .findAllByType("option")
        .some((n) => n.props.value === "fresh"),
    );
  } finally {
    await f.close();
  }
});

test("a failed first session lookup recovers on the next successful poll", async () => {
  const f = await fixture({ failInitialSessions: true });
  try {
    f.state.connections = [old, fresh];
    f.state.sessions = [
      session("prepared", "fresh"),
      session("previous", "old"),
    ];
    await f.poll();
    assert.equal(
      f.view.root.findByProps({ "aria-label": "选择 Agent" }).props.value,
      "fresh",
    );
    assert.ok(
      f.view.root
        .findAllByType("span")
        .some((n) => n.children.includes("Agent 已连接")),
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
