import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  CompileLogs,
  compileDiagnostics,
  logPage,
  type CompileBuild,
} from "../src/agent/compilation.js";

const build: CompileBuild = {
  projectId: "project",
  userId: "alice",
  buildId: "abc-def",
  outputFiles: [
    { path: "output.log" },
    { path: "output.pdf" },
    { path: "../private.log" },
  ],
  expiresAt: new Date(Date.now() + 60_000),
};
test("compile logs bind build, project and user; only listed log files are readable", async () => {
  let fetched = 0;
  const logs = new CompileLogs(
    async () => build,
    async () => {
      fetched++;
      return Readable.from([Buffer.from("你好\nerror\n")]);
    },
  );
  for (const [project, user, id, file] of [
    ["project", "bob", "abc-def", "output.log"],
    ["other", "alice", "abc-def", "output.log"],
    ["project", "alice", "abc-123", "output.log"],
    ["project", "alice", "abc-def", "output.pdf"],
    ["project", "alice", "abc-def", "../private.log"],
    ["project", "alice", "abc-def", "unlisted.log"],
  ])
    await assert.rejects(logs.read(project, user, id, file));
  assert.equal(fetched, 0);
  const source = await logs.read("project", "alice", "abc-def", "output.log");
  const first = logPage("abc-def", "output.log", source, 0, 3);
  const second = logPage(
    "abc-def",
    "output.log",
    source,
    first.nextOffset!,
    100,
  );
  assert.equal(first.text + second.text, source.text);
  assert.equal(second.nextOffset, null);
  assert.equal(second.sourceTruncated, false);
  const expired = new CompileLogs(
    async () => ({ ...build, expiresAt: new Date(0) }),
    async () => {
      throw new Error("should not fetch");
    },
  );
  await assert.rejects(
    expired.read("project", "alice", "abc-def", "output.log"),
    { code: "BUILD_NOT_FOUND" },
  );
});
test("log reads cap bytes, close the stream, and hide internal upstream URLs", async () => {
  const stream = Readable.from([
    Buffer.alloc(1_900_000, "x"),
    Buffer.alloc(200_000, "y"),
  ]);
  const logs = new CompileLogs(
    async () => build,
    async () => stream,
  );
  const source = await logs.read("project", "alice", "abc-def", "output.log");
  assert.equal(source.text.length, 2_000_000);
  assert.equal(source.truncated, true);
  assert.ok(stream.destroyed);
  const missingMetadata = new CompileLogs(
    async () => {
      throw new Error("internal-db-detail");
    },
    async () => Readable.from([]),
  );
  await assert.rejects(
    missingMetadata.read("project", "alice", "abc-def", "output.log"),
    (error: any) =>
      error.code === "LOG_UNAVAILABLE" &&
      !error.message.includes("internal-db-detail"),
  );
  const unavailable = new CompileLogs(
    async () => build,
    async () => {
      throw new Error("http://internal-secret");
    },
  );
  await assert.rejects(
    unavailable.read("project", "alice", "abc-def", "output.log"),
    (error: any) =>
      error.code === "LOG_UNAVAILABLE" &&
      !error.message.includes("internal-secret"),
  );
});
test("diagnostics resolve precise document paths and include dropped glyphs even without TeX errors", () => {
  const entries = [{ id: "doc", path: "/chapters/main.tex", type: "document" }];
  const result = compileDiagnostics(
    "Missing character: There is no 中 in font cmr10!\n",
    () => ({
      all: [
        {
          level: "error",
          file: "./chapters/main.tex",
          line: "42",
          message: "Undefined control sequence.",
          raw: "l.42 \\unknown",
        },
      ],
    }),
    entries,
  );
  assert.deepEqual(
    [
      result.firstError?.docId,
      result.firstError?.file,
      result.firstError?.line,
    ],
    ["doc", "/chapters/main.tex", 42],
  );
  assert.equal(result.warningCount, 1);
  assert.match(result.warnings[0].message, /中/);
  const noErrors = compileDiagnostics(
    "Missing character: missing glyph\n",
    () => ({ all: [] }),
    entries,
  );
  assert.equal(noErrors.firstError, null);
  assert.equal(noErrors.warningCount, 1);
  const brokenParser = compileDiagnostics(
    "unparsed error",
    () => {
      throw new Error();
    },
    entries,
  );
  assert.equal(brokenParser.parserFailed, true);
  assert.equal(brokenParser.logTail, "unparsed error");
});
