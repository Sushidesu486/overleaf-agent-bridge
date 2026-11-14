import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { randomBytes } from "node:crypto";
import {
  createGitHubClient,
  createGitHubLinkService,
  githubConfig,
  hash,
} from "../extensions/site-access/github-core.mjs";
import { createGitHubStore } from "../extensions/site-access/github-store.mjs";

const config = githubConfig(
  {
    GITHUB_APP_CLIENT_ID: "test-client",
    GITHUB_APP_CLIENT_SECRET: "test-secret",
  },
  "https://latex.example.org",
);
test("GitHub App uses state, S256 PKCE and fixed callback without repository scopes", () => {
  const url = new URL(
    createGitHubClient(config).authorize("state", "verifier"),
  );
  assert.equal(url.origin, "https://github.com");
  assert.equal(url.searchParams.get("client_id"), "test-client");
  assert.equal(url.searchParams.get("state"), "state");
  assert.equal(url.searchParams.get("code_challenge"), hash("verifier"));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("redirect_uri"),
    "https://latex.example.org/user/github/callback",
  );
  assert.equal(url.searchParams.has("scope"), false);
  assert.equal(url.href.includes("test-secret"), false);
});
test("unconfigured App is disabled and only HTTPS or loopback callback origins are accepted", () => {
  assert.equal(githubConfig({}, "https://latex.example.org"), null);
  const env = {
    GITHUB_APP_CLIENT_ID: "id",
    GITHUB_APP_CLIENT_SECRET: "secret",
  };
  assert.equal(
    githubConfig(env, "http://localhost:18083").callbackUrl,
    "http://localhost:18083/user/github/callback",
  );
  for (const url of [
    "http://example.org",
    "https://user:password@example.org",
    "https://example.org?query=yes",
    "file:///tmp/test",
  ])
    assert.throws(() => githubConfig(env, url));
});
test("identity uses PKCE, durable numeric ID, accepts missing email, and revokes its transient token", async () => {
  const calls = [];
  const client = createGitHubClient(config, {
    async fetchImpl(url, options) {
      calls.push({ url, options });
      if (calls.length === 1)
        return Response.json({
          access_token: "transient",
          refresh_token: "discarded",
        });
      if (calls.length === 2)
        return Response.json({
          type: "User",
          id: 123,
          login: "student",
          email: null,
        });
      return new Response(null, { status: 204 });
    },
  });
  assert.deepEqual(await client.identity("oauth-code", "verifier"), {
    githubUserId: "123",
    githubLogin: "student",
  });
  const exchange = JSON.parse(calls[0].options.body);
  assert.equal(exchange.code_verifier, "verifier");
  assert.equal(exchange.client_secret, "test-secret");
  assert.equal(calls[1].options.headers.Authorization, "Bearer transient");
  assert.equal(
    calls[2].url,
    "https://api.github.com/applications/test-client/token",
  );
  assert.equal(calls[2].options.method, "DELETE");
  assert.equal(JSON.parse(calls[2].options.body).access_token, "transient");
  assert.ok(
    calls.every((c) => c.options.redirect === "error" && c.options.signal),
  );
});
test("provider failures are redacted and token cleanup still runs after an invalid identity", async () => {
  for (const profile of [
    { id: 0 },
    { type: "User", id: Number.MAX_SAFE_INTEGER + 1, login: "student" },
    { type: "User", id: 1, login: "../evil" },
  ]) {
    let calls = 0;
    const client = createGitHubClient(config, {
      async fetchImpl() {
        calls++;
        if (calls === 1) return Response.json({ access_token: "secret-token" });
        if (calls === 2) return Response.json(profile);
        return new Response(null, { status: 204 });
      },
    });
    await assert.rejects(client.identity("secret-code", "secret-verifier"), {
      code: "provider",
      message: "provider",
    });
    assert.equal(calls, 3);
  }
  const client = createGitHubClient(config, {
    fetchImpl() {
      throw new Error("credential in network error");
    },
  });
  await assert.rejects(client.identity("code", "verifier"), {
    message: "provider",
  });
});
test("cleanup failure keeps the verified identity and emits only a fixed outcome", async () => {
  let warnings = 0,
    calls = 0;
  const client = createGitHubClient(config, {
    cleanupWarning: (...args) => {
      assert.equal(args.length, 0);
      warnings++;
    },
    async fetchImpl() {
      if (++calls === 1) return Response.json({ access_token: "transient" });
      if (calls === 2)
        return Response.json({ type: "User", id: 123, login: "student" });
      throw new Error("secret-provider-error");
    },
  });
  assert.equal((await client.identity("code", "verifier")).githubUserId, "123");
  assert.equal(warnings, 1);
});

// Run against a disposable Mongo instance, from the pinned Overleaf workspace
// (which supplies its own mongodb driver). No production database is addressed.
let mongo;
const mongoUrl = process.env.GITHUB_LINK_TEST_MONGO_URL;
before(async () => {
  if (mongoUrl) {
    const { MongoClient } = await import("mongodb");
    mongo = await MongoClient.connect(mongoUrl);
  }
});
after(async () => {
  await mongo?.close();
});
const dbTest = (name, fn) => test(name, { skip: !mongoUrl }, fn);
const ctx = { userId: "user-a", sessionId: "browser-a" };

async function fixture(t) {
  const db = mongo.db(`github_link_check_${randomBytes(8).toString("hex")}`);
  t.after(() => db.dropDatabase());
  const store = await createGitHubStore(db);
  let clock = new Date("2026-11-14T12:00:00Z");
  let exchanges = 0;
  let identify = async () => ({ githubUserId: "123", githubLogin: "student" });
  const svc = createGitHubLinkService({
    store,
    now: () => clock,
    client: {
      authorize: createGitHubClient(config).authorize,
      async identity(code, verifier) {
        exchanges++;
        assert.ok(verifier);
        return identify(code);
      },
    },
  });
  async function start(context = ctx) {
    return new URL(await svc.start(context)).searchParams.get("state");
  }
  async function candidate(context = ctx) {
    await svc.callback(context, { state: await start(context), code: "code" });
    return (await svc.status(context)).pending.id;
  }
  return {
    db,
    store,
    svc,
    start,
    candidate,
    advance: (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
    identify: (fn) => {
      identify = fn;
    },
    exchanges: () => exchanges,
  };
}
dbTest(
  "real Mongo: explicit confirmation, persistence, single use, unlink and no token storage",
  async (t) => {
    const f = await fixture(t);
    const state = await f.start();
    const flow = await f.db.collection("github_link_flows").findOne({});
    assert.equal(flow.stateHash, hash(state));
    assert.equal(JSON.stringify(flow).includes(state), false);
    await f.svc.callback(ctx, { state, code: "code" });
    assert.equal((await f.svc.status(ctx)).link, null);
    const pending = (await f.svc.status(ctx)).pending;
    await assert.rejects(f.svc.confirm(ctx, "wrong-confirmation"), {
      code: "expired",
    });
    await f.svc.confirm(ctx, pending.id);
    assert.equal((await f.svc.status(ctx)).link.login, "student");
    await assert.rejects(f.svc.confirm(ctx, pending.id), { code: "expired" });
    await assert.rejects(f.svc.callback(ctx, { state, code: "code" }), {
      code: "expired",
    });
    const saved = await f.store.getAccount(ctx.userId);
    assert.deepEqual(
      Object.keys(saved).sort(),
      [
        "_id",
        "revision",
        "githubUserId",
        "githubLogin",
        "linkedAt",
        "verifiedAt",
      ].sort(),
    );
    assert.equal(
      await f.db.collection("github_link_flows").countDocuments(),
      0,
    );
    await f.svc.unlink(ctx);
    assert.equal((await f.svc.status(ctx)).link, null);
  },
);
dbTest(
  "real Mongo: wrong session/user/state, expiration and denial never exchange a code",
  async (t) => {
    const f = await fixture(t);
    const state = await f.start();
    for (const context of [
      { ...ctx, userId: "user-b" },
      { ...ctx, sessionId: "browser-b" },
    ])
      await assert.rejects(f.svc.callback(context, { state, code: "code" }), {
        code: "expired",
      });
    await assert.rejects(
      f.svc.callback(ctx, { state: "x".repeat(43), code: "code" }),
      { code: "expired" },
    );
    await assert.rejects(
      f.svc.callback(ctx, { state, error: "access_denied" }),
      { code: "denied" },
    );
    await assert.rejects(f.svc.callback(ctx, { state, code: "code" }), {
      code: "expired",
    });
    const expired = await f.start();
    f.advance(10 * 60_000);
    await assert.rejects(
      f.svc.callback(ctx, { state: expired, code: "code" }),
      { code: "expired" },
    );
    assert.equal(f.exchanges(), 0);
  },
);
dbTest(
  "real Mongo: concurrent callbacks exchange once and a newer start invalidates the old one",
  async (t) => {
    const f = await fixture(t);
    const old = await f.start(),
      state = await f.start();
    await assert.rejects(f.svc.callback(ctx, { state: old, code: "code" }), {
      code: "expired",
    });
    const results = await Promise.allSettled(
      [1, 2].map(() => f.svc.callback(ctx, { state, code: "code" })),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(f.exchanges(), 1);
  },
);
dbTest(
  "real Mongo: GitHub ID is unique across Overleaf users and links cannot be silently replaced",
  async (t) => {
    const f = await fixture(t);
    const second = { userId: "user-b", sessionId: "browser-b" };
    const a = await f.candidate(),
      b = await f.candidate(second);
    const results = await Promise.allSettled([
      f.svc.confirm(ctx, a),
      f.svc.confirm(second, b),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      results.find((r) => r.status === "rejected").reason.code,
      "in_use",
    );
    const owner = (await f.svc.status(ctx)).link ? ctx : second;
    f.identify(async () => ({ githubUserId: "999", githubLogin: "other" }));
    await assert.rejects(f.svc.confirm(owner, await f.candidate(owner)), {
      code: "changed",
    });
    assert.equal((await f.svc.status(owner)).link.login, "student");
  },
);
dbTest(
  "real Mongo: unlink invalidates a confirmation already taken by another worker",
  async (t) => {
    const f = await fixture(t);
    const id = await f.candidate();
    const candidate = await f.store.takeCandidate(
      hash(`${ctx.userId}:${ctx.sessionId}`),
      id,
      new Date("2026-11-14T12:00:00Z"),
    );
    await f.svc.unlink(ctx);
    assert.equal(await f.store.link(ctx.userId, candidate, new Date()), false);
    assert.equal((await f.svc.status(ctx)).link, null);
  },
);
dbTest(
  "real Mongo: unlink or a newer authorization cancels an in-flight profile lookup",
  async (t) => {
    for (const cancel of [(f) => f.svc.unlink(ctx), (f) => f.start()]) {
      const f = await fixture(t);
      let finish, began;
      const entered = new Promise((resolve) => {
        began = resolve;
      });
      f.identify(() => {
        began();
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      const callback = f.svc.callback(ctx, {
        state: await f.start(),
        code: "code",
      });
      await entered;
      await cancel(f);
      finish({ githubUserId: "123", githubLogin: "student" });
      await assert.rejects(callback, { code: "expired" });
      assert.equal((await f.svc.status(ctx)).pending, null);
    }
  },
);
dbTest(
  "real Mongo: pending confirmation expiry, cancellation and stale tab confirmation",
  async (t) => {
    const f = await fixture(t);
    const first = await f.candidate(),
      second = await f.candidate();
    await f.svc.cancel(ctx, first);
    await assert.rejects(f.svc.confirm(ctx, first), { code: "expired" });
    assert.equal((await f.svc.status(ctx)).pending.id, second);
    await f.svc.cancel(ctx, second);
    assert.equal((await f.svc.status(ctx)).pending, null);
    const third = await f.candidate();
    f.advance(10 * 60_000);
    await assert.rejects(f.svc.confirm(ctx, third), { code: "expired" });
  },
);
