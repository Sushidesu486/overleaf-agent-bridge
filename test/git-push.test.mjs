import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { createPushStaging } from "../extensions/git-access/push-staging.mjs";

const projectId = "a".repeat(24);
const operationId = "4b4f1f28-79c8-4a48-a78f-449779be8036";
const old = Buffer.from("Keep this file.\n");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "git-push-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hits = [];
  const blobs = new Map([
    ["new", Buffer.from("中文 collaboration\n")],
    ["image", Buffer.from([0, 255, 23, 0])],
  ]);
  const server = createServer((req, res) => {
    hits.push(req.url);
    const key = new URL(req.url, "http://localhost").pathname.split("/").at(-1);
    const bytes = blobs.get(key);
    if (!bytes) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.end(bytes);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  const key = "1234567890abcdefghijklmnopqrstuv";
  const body = {
    latestVerId: 17,
    files: [
      { name: "keep.tex" },
      {
        name: "chapters/中文.tex",
        url: `${origin}/api/${projectId}/new?key=${key}`,
      },
      {
        name: "img/plot.png",
        url: `${origin}/api/${projectId}/image?key=${key}`,
      },
    ],
    postbackUrl: `${origin}/api/${projectId}/${key}/postback`,
  };
  const snapshots = {
    async read(id, version) {
      assert.equal(id, projectId);
      assert.equal(version, 17);
      return {
        version: 17,
        files: [
          { index: 0, path: "keep.tex", bytes: old.length, sha256: sha(old) },
          {
            index: 1,
            path: "delete.tex",
            bytes: 4,
            sha256: sha(Buffer.from("bye\n")),
          },
        ],
      };
    },
    async file(id, version, index) {
      assert.equal(id, projectId);
      assert.equal(version, 17);
      assert.equal(index, 0);
      return { bytes: old.length, stream: Readable.from(old) };
    },
  };
  return {
    root,
    hits,
    blobs,
    body,
    staging: createPushStaging({ root, bridgeUrl: origin, snapshots }),
  };
}

test("push staging reconstructs the complete candidate tree and retains exact bytes after reopening", async (t) => {
  const { root, body, staging } = await fixture(t);
  const staged = await staging.stage(projectId, operationId, body);
  assert.equal(staged.baseVersion, 17);
  assert.deepEqual(staged.deleted, ["delete.tex"]);
  assert.deepEqual(
    staged.files.map((f) => [f.path, f.changed]),
    [
      ["keep.tex", false],
      ["chapters/中文.tex", true],
      ["img/plot.png", true],
    ],
  );
  assert.equal(
    (await staging.read(projectId, operationId)).files[1].sha256,
    sha(Buffer.from("中文 collaboration\n")),
  );
  for (const [index, bytes] of [
    old,
    Buffer.from("中文 collaboration\n"),
    Buffer.from([0, 255, 23, 0]),
  ].entries())
    assert.deepEqual(
      await readFile(staging.filePath(projectId, operationId, index)),
      bytes,
    );
  assert.ok(
    !(
      await readFile(
        join(root, projectId, operationId, "manifest.json"),
        "utf8",
      )
    ).includes("?key="),
  );
});

test("invalid candidates are rejected before any bridge download", async (t) => {
  const { body, staging, hits } = await fixture(t);
  const cases = [
    { ...body, files: [{ name: "../outside" }] },
    { ...body, files: [{ name: "same" }, { name: "same" }] },
    { ...body, files: [{ name: "keep.tex" }, { name: "keep.tex/sub.tex" }] },
    { ...body, files: [{ name: "new.tex" }] },
    { ...body, postbackUrl: "http://untrusted.invalid/api/callback" },
    {
      ...body,
      files: [{ name: "new.tex", url: "http://untrusted.invalid/secret" }],
    },
    {
      ...body,
      files: [
        {
          name: "new.tex",
          url: body.files[1].url.replace(projectId, "b".repeat(24)),
        },
      ],
    },
    {
      ...body,
      files: [{ name: "new.tex", url: body.files[1].url + "&extra=1" }],
    },
    {
      ...body,
      files: [
        {
          name: "new.tex",
          url: body.files[1].url.replace("?key=", "?key=other"),
        },
      ],
    },
  ];
  for (const candidate of cases)
    await assert.rejects(staging.stage(projectId, operationId, candidate));
  assert.equal(hits.length, 0);
});

test("failed staging publishes no manifest, and completed operations cannot be overwritten", async (t) => {
  const { root, body, staging, blobs } = await fixture(t);
  blobs.delete("image");
  await assert.rejects(staging.stage(projectId, operationId, body), /download/);
  await assert.rejects(staging.read(projectId, operationId), {
    code: "ENOENT",
  });
  assert.deepEqual(await readdir(join(root, projectId)), []);
  blobs.set("image", Buffer.from([0, 255, 23, 0]));
  const first = await staging.stage(projectId, operationId, body);
  blobs.set("new", Buffer.from("Changed candidate.\n"));
  await assert.rejects(staging.stage(projectId, operationId, body));
  assert.deepEqual(await staging.read(projectId, operationId), first);
  assert.equal(
    await readFile(staging.filePath(projectId, operationId, 1), "utf8"),
    "中文 collaboration\n",
  );
  await staging.discard(projectId, operationId);
  await assert.rejects(staging.read(projectId, operationId), {
    code: "ENOENT",
  });
});

test("staging keeps the inclusive 50 MB file limit and cleans up an oversized transfer", async (t) => {
  const { body, staging, blobs } = await fixture(t);
  blobs.set("image", Buffer.alloc(50_000_000, 12));
  const first = await staging.stage(projectId, operationId, body);
  assert.equal(first.files[2].bytes, 50_000_000);
  await staging.discard(projectId, operationId);
  blobs.set("image", Buffer.alloc(50_000_001, 12));
  await assert.rejects(staging.stage(projectId, operationId, body), {
    code: "size_limit",
  });
  await assert.rejects(staging.read(projectId, operationId), {
    code: "ENOENT",
  });
});
