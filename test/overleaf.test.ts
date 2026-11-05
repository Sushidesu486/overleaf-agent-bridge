import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { OverleafClient } from "../src/overleaf.js";
const id = "0123456789abcdef01234567";
test("session cookies and CSRF, project filtering, no redirect following", async (t) => {
  let leak = false;
  let login = false;
  const http = createServer(async (req, res) => {
    if (req.url === "/login" && req.method === "GET") {
      res.setHeader("set-cookie", "sid=pre; Path=/; HttpOnly");
      res.end('<meta name="ol-csrfToken" content="csrf1"><title>Lab</title>');
    } else if (req.url === "/login") {
      let raw = "";
      for await (const b of req) raw += b;
      assert.equal(req.headers.cookie, "sid=pre");
      assert.equal(req.headers["x-csrf-token"], "csrf1");
      assert.equal(JSON.parse(raw).email, "agent@example.invalid");
      login = true;
      res.setHeader("set-cookie", "sid=auth; Path=/; HttpOnly");
      res.end("{}");
    } else if (req.url === "/user/settings") {
      assert.ok(login);
      assert.equal(req.headers.cookie, "sid=auth");
      res.end('<meta name="ol-csrfToken" content="csrf2">');
    } else if (req.url === "/api/project") {
      assert.equal(req.headers["x-csrf-token"], "csrf2");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          projects: [
            { id, name: "allowed" },
            { id: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "hidden" },
          ],
        }),
      );
    } else if (req.url === `/project/${id}/compile`) {
      res.statusCode = 302;
      res.setHeader("location", "/leak");
      res.end();
    } else {
      leak = true;
      res.end("unexpected");
    }
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  t.after(
    () => new Promise<void>((r, j) => http.close((e) => (e ? j(e) : r()))),
  );
  const a = http.address() as { port: number };
  const c = new OverleafClient({
    baseUrl: `http://127.0.0.1:${a.port}`,
    email: "agent@example.invalid",
    password: "test-pass",
    allowedProjectIds: [id],
  });
  await c.login();
  assert.deepEqual(await c.listProjects(), [{ id, name: "allowed" }]);
  await assert.rejects(() => c.compile("aaaaaaaaaaaaaaaaaaaaaaaa"), {
    code: "PROJECT_NOT_ALLOWED",
  });
  await assert.rejects(() => c.compile(id), { code: "SESSION_EXPIRED" });
  assert.equal(leak, false);
  await assert.rejects(() => c.artifact(id, "https://other.invalid/file.pdf"), {
    code: "INVALID_ARTIFACT",
  });
});
test("reject insecure remote endpoints and embedded credentials", () => {
  for (const baseUrl of [
    "http://remote.example",
    "https://u:pass@example.org",
    "https://example.org/path",
  ])
    assert.throws(
      () =>
        new OverleafClient({
          baseUrl,
          email: "a@example.org",
          password: "p",
          allowedProjectIds: [],
        }),
      { code: "INVALID_ORIGIN" },
    );
});
