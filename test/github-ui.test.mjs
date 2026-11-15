import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import React from "react";
import { create, act } from "react-test-renderer";
import { build } from "esbuild";

let GitHubAccount;
before(async () => {
  await mkdir(".local", { recursive: true });
  const outfile = resolve(".local/github-ui.mjs");
  await build({
    entryPoints: [
      "extensions/agent-access/frontend/js/components/github-account.tsx",
    ],
    bundle: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    external: ["react", "react/jsx-runtime"],
    outfile,
    plugins: [
      {
        name: "native-components",
        setup(b) {
          b.onResolve({ filter: /^@\// }, (args) => ({
            path: args.path,
            namespace: "native-components",
          }));
          b.onLoad(
            { filter: /.*/, namespace: "native-components" },
            ({ path }) => {
              if (path.includes("fetch-json"))
                return {
                  contents:
                    "export const getJSON=(...a)=>globalThis.githubUI.get(...a), postJSON=(...a)=>globalThis.githubUI.post(...a), getUserFacingMessage=e=>e.message;",
                };
              if (path.endsWith("ol-modal"))
                return {
                  contents:
                    'import React from "react"; const Part=p=>React.createElement("div",p,p.children); export const OLModal=p=>p.show?React.createElement("dialog",p,p.children):null, OLModalHeader=Part, OLModalTitle=Part, OLModalBody=Part, OLModalFooter=Part;',
                };
              const tag = path.endsWith("ol-button")
                ? "button"
                : path.includes("notification")
                  ? "notification"
                  : "span";
              return {
                contents: `import React from "react"; export default p=>React.createElement(${JSON.stringify(tag)},p,p.children || p.content);`,
              };
            },
          );
        },
      },
    ],
  });
  GitHubAccount = (await import(pathToFileURL(outfile).href)).default;
});
async function fixture(t, state, search = "") {
  const previous = { window: globalThis.window, githubUI: globalThis.githubUI };
  const posts = [],
    navigations = [],
    replacements = [];
  globalThis.window = {
    location: {
      href: `https://latex.example.org/user/settings${search}`,
      assign: (url) => navigations.push(url),
    },
    history: {
      state: {},
      replaceState: (_, __, url) => replacements.push(String(url)),
    },
  };
  globalThis.githubUI = {
    get: async () => structuredClone(state),
    post: async (url, options) => {
      posts.push({ url, body: options.body });
      if (url.endsWith("/start"))
        return { url: "https://github.com/login/oauth/authorize?fixture" };
      if (url.endsWith("/confirm")) {
        state.link = { login: state.pending.login };
        state.pending = null;
      }
      if (url.endsWith("/unlink")) state.link = null;
      return {};
    },
  };
  let tree;
  await act(async () => {
    tree = create(React.createElement(GitHubAccount));
  });
  t.after(async () => {
    await act(async () => tree.unmount());
    Object.assign(globalThis, previous);
  });
  const button = (label) =>
    tree.root.findAllByType("button").find((b) => b.props.children === label);
  const click = async (label) => {
    assert.ok(button(label));
    await act(async () => button(label).props.onClick());
  };
  return { tree, posts, navigations, replacements, button, click };
}
test("settings disables an unconfigured connection with an explanation", async (t) => {
  const f = await fixture(t, { configured: false, link: null, pending: null });
  assert.equal(f.button("Connect GitHub").props.disabled, true);
  assert.equal(f.posts.length, 0);
  assert.match(JSON.stringify(f.tree.toJSON()), /not configured yet/);
});
test("connection uses native POST then navigates to GitHub", async (t) => {
  const f = await fixture(t, { configured: true, link: null, pending: null });
  await f.click("Connect GitHub");
  assert.equal(f.posts[0].url, "/user/github/start");
  assert.equal(f.navigations.length, 1);
});
test("confirmation submits the reviewed candidate and disconnect requires a separate confirmation", async (t) => {
  const f = await fixture(t, {
    configured: true,
    link: null,
    pending: { id: "reviewed-candidate", login: "student" },
  });
  assert.match(JSON.stringify(f.tree.toJSON()), /@|student/);
  assert.equal(f.button("Connect GitHub").props.disabled, true);
  await f.click("Confirm connection");
  assert.equal(f.posts[0].body.candidateId, "reviewed-candidate");
  assert.ok(f.button("Disconnect"));
  await f.click("Disconnect");
  assert.equal(f.posts.length, 1);
  assert.equal(f.tree.root.findAllByType("dialog").length, 1);
  await f.click("Disconnect GitHub");
  assert.equal(f.posts[1].url, "/user/github/unlink");
  assert.ok(f.button("Connect GitHub"));
});
test("authorization cancellation is explained and the harmless callback result is removed from the URL", async (t) => {
  const f = await fixture(
    t,
    { configured: true, link: null, pending: null },
    "?github=denied#github-account",
  );
  assert.match(JSON.stringify(f.tree.toJSON()), /authorization was cancelled/);
  assert.equal(
    f.replacements[0],
    "https://latex.example.org/user/settings#github-account",
  );
  assert.equal(f.posts.length, 0);
});
