import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createGitAccess } from "../extensions/git-access/access.mjs";
import { createGitApi } from "../extensions/git-access/http.mjs";

test("the bridge API authenticates reads and reauthorizes signed attachment downloads", async (t) => {
  const projectId = "a".repeat(24),
    userId = "b".repeat(24),
    secret = "s".repeat(64);
  const grants = new Map();
  let now = new Date();
  const access = createGitAccess({
    now: () => now,
    users: {
      async get() {
        return { name: "Reader", email: "reader@example.invalid" };
      },
      async role() {
        return "readOnly";
      },
    },
    store: {
      async getLink() {
        return { enabled: true };
      },
      async putGrant(grant) {
        grants.set(grant.id, grant);
      },
      async getGrant(id) {
        return grants.get(id);
      },
      async touch() {},
      async revoke(id) {
        grants.get(id).revokedAt = new Date().toISOString();
      },
    },
  });
  const issued = await access.issue(userId, projectId, {
    name: "Client",
    mode: "read",
    actor: "human",
  });
  let handler;
  const server = createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const internalUrl = `http://127.0.0.1:${server.address().port}`;
  const files = [{ index: 0, path: "main.tex", bytes: 7 }];
  handler = createGitApi({
    access,
    secret,
    internalUrl,
    snapshots: {
      async latest() {
        return {
          version: 7,
          timestamp: "2026-01-01T00:00:00Z",
          author: null,
          files,
        };
      },
      async read() {
        return { version: 7, files };
      },
      async file() {
        return { bytes: 7, stream: Readable.from([Buffer.from("Hello!\n")]) };
      },
    },
  });
  const headers = {
    "X-Overleaf-Git-Service": secret,
    Authorization: `Bearer ${issued.token}`,
  };
  const url = `${internalUrl}/oauth/token/info?project_id=${projectId}&access=read`;
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(url, { headers })).status, 200);
  assert.equal(
    (await fetch(url.replace("access=read", "access=write"), { headers }))
      .status,
    403,
  );
  assert.equal(
    (await fetch(url.replace(projectId, "c".repeat(24)), { headers })).status,
    403,
  );
  const doc = await fetch(`${internalUrl}/api/v0/docs/${projectId}`, {
    headers,
  });
  assert.equal(doc.status, 200);
  assert.equal((await doc.json()).latestVerId, 7);
  const snapshot = await (
    await fetch(`${internalUrl}/api/v0/docs/${projectId}/snapshots/7`, {
      headers,
    })
  ).json();
  const [blobUrl] = snapshot.atts[0];
  assert.equal(await (await fetch(blobUrl)).text(), "Hello!\n");
  assert.equal((await fetch(blobUrl.replace("/7/0", "/7/1"))).status, 403);
  now = new Date(now.getTime() + 91 * 86400_000);
  const expired = await fetch(url, { headers });
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error_code, "token_expired");
  now = new Date();
  await access.revoke(userId, projectId, issued.id);
  assert.equal((await fetch(blobUrl)).status, 401);
  assert.equal((await fetch(url, { headers })).status, 401);
});
