import { test } from "node:test";
import assert from "node:assert/strict";
import { createGitAccess } from "../extensions/git-access/access.mjs";

test("a project Git token follows membership changes and can be revoked independently", async () => {
  const grants = new Map(),
    links = new Map();
  let role = "owner";
  const store = {
    async putGrant(grant) {
      grants.set(grant.id, structuredClone(grant));
    },
    async getGrant(id) {
      return grants.get(id);
    },
    async listGrants(userId, projectId) {
      return [...grants.values()].filter(
        (g) => g.userId === userId && g.projectId === projectId,
      );
    },
    async revoke(id, userId) {
      const g = grants.get(id);
      if (g?.userId === userId) g.revokedAt = new Date().toISOString();
    },
    async touch() {},
    async getLink(projectId) {
      return links.get(projectId);
    },
    async setEnabled(projectId, enabled) {
      links.set(projectId, { enabled });
    },
  };
  const svc = createGitAccess({
    store,
    users: {
      async get() {
        return { name: "Alice", email: "alice@example.invalid" };
      },
      async role() {
        return role;
      },
    },
  });
  const p = "a".repeat(24),
    u = "b".repeat(24);
  await assert.rejects(
    svc.issue(u, p, { name: "Laptop", mode: "write", actor: "human" }),
    { code: "disabled" },
  );
  await svc.enable(u, p, true);
  const issued = await svc.issue(u, p, {
    name: "Agent",
    mode: "write",
    actor: "agent",
  });
  assert.equal((await svc.authorize(issued.token, p, "write")).actor, "agent");
  assert.ok(!JSON.stringify(await svc.status(u, p)).includes(issued.token));
  role = "readOnly";
  await svc.authorize(issued.token, p, "read");
  await assert.rejects(svc.authorize(issued.token, p, "write"), {
    code: "forbidden",
  });
  await assert.rejects(svc.authorize(issued.token, "c".repeat(24), "read"), {
    code: "forbidden",
  });
  await svc.revoke(u, p, issued.id);
  await assert.rejects(svc.authorize(issued.token, p, "read"), {
    code: "token_invalid",
  });
});
