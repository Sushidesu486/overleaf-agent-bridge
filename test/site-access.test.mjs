import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAccessService,
  AccessError,
} from "../extensions/site-access/auth.mjs";

function fixture() {
  let clock = new Date("2026-11-13T09:00:00Z");
  const tokens = new Map();
  const users = new Map();
  const sent = [];
  let failMail = false;
  const service = createAccessService({
    now: () => clock,
    siteUrl: "https://latex.example.org",
    normalizeEmail: (email) =>
      typeof email === "string" &&
      /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())
        ? email.trim().toLowerCase()
        : null,
    store: {
      async putToken(token) {
        tokens.set(token._id, token);
      },
      async deleteToken(key) {
        tokens.delete(key);
      },
      async getToken(key, now) {
        const value = tokens.get(key);
        return value?.expiresAt > now ? value : null;
      },
      async takeToken(key, now) {
        const value = tokens.get(key);
        if (value?.expiresAt > now) {
          tokens.delete(key);
          return value;
        }
        return null;
      },
    },
    users: {
      async findByEmail(email) {
        return users.get(email);
      },
      validatePassword(password) {
        if (typeof password !== "string" || password.length < 8)
          throw new AccessError("password", "invalid password");
      },
      async create(email, password) {
        assert.equal(users.has(email), false, "must not overwrite an account");
        const user = { _id: "new-user", email, password };
        users.set(email, user);
        return user;
      },
    },
    async mail(email, kind, link) {
      if (failMail) throw new Error("delivery failed");
      sent.push({ email, kind, link });
    },
  });
  return {
    service,
    tokens,
    users,
    sent,
    token: () =>
      new URLSearchParams(new URL(sent.at(-1).link).hash.slice(1)).get("token"),
    advance: (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
    failMail: () => {
      failMail = true;
    },
  };
}

test("registration verifies any email domain before creating an account; stores only token digests", async () => {
  const f = fixture();
  await f.service.requestRegistration(" Student@university.example ");
  assert.equal(f.users.size, 0);
  assert.equal(f.sent[0].email, "student@university.example");
  assert.equal(new URL(f.sent[0].link).search, "");
  const token = f.token();
  assert.equal(token.length, 43);
  assert.equal(JSON.stringify([...f.tokens.values()]).includes(token), false);
  const user = await f.service.completeRegistration(token, "correct-password");
  assert.equal(user.email, "student@university.example");
  assert.equal(f.tokens.size, 0);
  await assert.rejects(
    f.service.completeRegistration(token, "different-password"),
    { code: "token" },
  );
});

test("expired tokens cannot create an account even before Mongo TTL cleanup", async () => {
  const f = fixture();
  await f.service.requestRegistration("student@example.net");
  f.advance(30 * 60_000);
  await assert.rejects(
    f.service.completeRegistration(f.token(), "correct-password"),
    { code: "token" },
  );
  assert.equal(f.users.size, 0);
});

test("concurrent token submissions create only one account", async () => {
  const f = fixture();
  await f.service.requestRegistration("student@example.net");
  const result = await Promise.allSettled(
    Array.from({ length: 2 }, () =>
      f.service.completeRegistration(f.token(), "correct-password"),
    ),
  );
  assert.equal(result.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(f.users.size, 1);
});

test("invalid password can be corrected without requesting another email", async () => {
  const f = fixture();
  await f.service.requestRegistration("student@example.net");
  await assert.rejects(f.service.completeRegistration(f.token(), "short"), {
    code: "password",
  });
  await f.service.completeRegistration(f.token(), "correct-password");
  assert.equal(f.users.size, 1);
});

test("existing email registration only sends login guidance and preserves credentials", async () => {
  const f = fixture();
  const existing = {
    _id: "legacy",
    password: "original",
    projects: ["thesis"],
  };
  f.users.set("student@example.net", existing);
  await f.service.requestRegistration("student@example.net");
  assert.equal(f.tokens.size, 0);
  assert.equal(f.users.get("student@example.net"), existing);
  assert.deepEqual(f.sent, [
    {
      email: "student@example.net",
      kind: "existing",
      link: "https://latex.example.org/login",
    },
  ]);
});

test("a previously sent registration cannot replace a subsequently created account", async () => {
  const f = fixture();
  await f.service.requestRegistration("student@example.net");
  f.users.set("student@example.net", { _id: "invited", password: "original" });
  await assert.rejects(
    f.service.completeRegistration(f.token(), "correct-password"),
    { code: "existing" },
  );
  assert.equal(f.users.get("student@example.net").password, "original");
});

test("delivery failure removes its token and does not create a user", async () => {
  const f = fixture();
  f.failMail();
  await assert.rejects(
    f.service.requestRegistration("student@example.net"),
    /delivery failed/,
  );
  assert.equal(f.tokens.size, 0);
  assert.equal(f.users.size, 0);
});

test("malformed input is rejected before sending mail", async () => {
  const f = fixture();
  for (const email of [
    null,
    { email: "a@example.org" },
    "bad",
    "a@example.org\r\nBcc:other@example.org",
  ])
    await assert.rejects(f.service.requestRegistration(email), {
      code: "email",
    });
  assert.equal(f.sent.length, 0);
});
