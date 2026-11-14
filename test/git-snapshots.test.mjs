import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createSnapshotCache } from "../extensions/git-access/snapshots.mjs";

// A ZIP containing main.tex with the bytes "Hello, Git!\n".
const zip = Buffer.from(
  "UEsDBBQAAAAIAOW9bl09T4CIDgAAAAwAAAAIAAAAbWFpbi50ZXjzSM3JyddRcM8sUeQCAFBLAQIUAxQAAAAIAOW9bl09T4CIDgAAAAwAAAAIAAAAAAAAAAAAAACAAQAAAABtYWluLnRleFBLBQYAAAAAAQABADYAAAA0AAAAAAA=",
  "base64",
);

test("serving an old snapshot renews retention before a newer capture cleans the cache", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "git-snapshots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = "a".repeat(24);
  let historyVersion = 0;
  const cache = createSnapshotCache({
    root,
    async capture() {
      return { stream: Readable.from([zip]), historyVersion };
    },
  });
  const age = async (version) => {
    const old = new Date(Date.now() - 3 * 86400_000);
    await utimes(join(root, project, String(version)), old, old);
  };
  const contents = async (version) => {
    const { stream } = await cache.file(project, version, 0);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks).toString();
  };
  await cache.latest(project);
  await age(1);
  assert.equal((await cache.latest(project)).version, 1);
  historyVersion = 1;
  await cache.latest(project);
  assert.equal(await contents(1), "Hello, Git!\n");

  await age(1);
  await age(2);
  // The snapshot endpoint also renews retention when issuing fresh URLs.
  await cache.read(project, 1);
  historyVersion = 2;
  await cache.latest(project);
  assert.equal(await contents(1), "Hello, Git!\n");
  await assert.rejects(cache.read(project, 2), { code: "snapshot_expired" });
});
