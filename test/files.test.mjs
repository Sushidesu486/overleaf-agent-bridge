import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import {
  createFileBackend,
  projectFileTree,
} from "../extensions/agent-access/files.mjs";

function fixture() {
  const project = {
    rootDoc_id: "d",
    rootFolder: [
      {
        _id: "r",
        name: "rootFolder",
        docs: [{ _id: "d", name: "main.tex" }],
        folders: [{ _id: "nested", name: "sections", docs: [] }],
      },
    ],
  };
  const calls = [],
    events = [];
  let held = false,
    onLock = () => {},
    uploadPath;
  class AgentError extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  }
  const native = (kind) => ({
    withoutLock: async (...args) => {
      assert.ok(held);
      calls.push({ kind, args });
      if (kind === "file") {
        uploadPath = args[3];
        assert.deepEqual(await readFile(uploadPath), Buffer.from([0, 1, 255]));
        return { fileRef: { _id: "new-file" } };
      }
      return { doc: { _id: "new-doc" } };
    },
  });
  const backend = createFileBackend({
    AgentError,
    ProjectGetter: {
      promises: {
        getProject: async () => {
          assert.ok(held);
          return project;
        },
      },
    },
    ProjectEntityUpdateHandler: {
      promises: {
        addDocWithRanges: native("doc"),
        addFile: native("file"),
        deleteEntity: native("delete"),
      },
    },
    LockManager: {
      promises: {
        runWithLock: async (namespace, id, fn) => {
          assert.equal(namespace, "sequentialProjectStructureUpdateLock");
          assert.equal(id, "p");
          assert.equal(held, false);
          held = true;
          try {
            onLock();
            return await fn();
          } finally {
            held = false;
          }
        },
      },
    },
    EditorRealTimeController: { emitToRoom: (...args) => events.push(args) },
    SafePath: {
      isCleanFilename: () => true,
      isBlockedFilename: () => false,
      isAllowedLength: (p) => p.length <= 1024,
    },
  });
  return {
    backend,
    project,
    calls,
    events,
    authorize: async () => assert.ok(held),
    setOnLock: (fn) => {
      onLock = fn;
    },
    uploadPath: () => uploadPath,
  };
}
const createArgs = {
  folderId: "nested",
  name: "part.tex",
  encoding: "utf8",
  content: "中文\ntext",
  dryRun: false,
};
const deleteArgs = { fileId: "d", expectedPath: "/main.tex", dryRun: false };

test("file paths and native events retain folder IDs and the human agent attribution", async () => {
  const f = fixture();
  assert.deepEqual(
    projectFileTree(f.project).folders.map((x) => x.path),
    ["/", "/sections/"],
  );
  const doc = await f.backend.createFile("p", "user", createArgs, f.authorize);
  assert.equal(doc.path, "/sections/part.tex");
  assert.deepEqual(f.calls[0].args.slice(-2), ["user", "agent"]);
  assert.deepEqual(f.events[0], [
    "p",
    "reciveNewDoc",
    "nested",
    { _id: "new-doc" },
    "agent",
    "user",
  ]);
  const file = await f.backend.createFile(
    "p",
    "user",
    { ...createArgs, encoding: "base64", content: "AAH/" },
    f.authorize,
  );
  assert.equal(file.type, "file");
  assert.deepEqual(f.events[1], [
    "p",
    "reciveNewFile",
    "nested",
    { _id: "new-file" },
    "agent",
    undefined,
    "user",
  ]);
  await assert.rejects(access(f.uploadPath()), { code: "ENOENT" });
  const deleted = await f.backend.deleteFile(
    "p",
    "user",
    deleteArgs,
    f.authorize,
  );
  assert.equal(deleted.wasRootDocument, true);
  assert.deepEqual(f.calls[2].args, ["p", "d", "doc", "user", "agent"]);
  assert.deepEqual(f.events[2], ["p", "removeEntity", "d", "agent"]);
});

test("dry runs and rejected names, foreign folders, directory deletes and paths never mutate", async () => {
  const f = fixture();
  await f.backend.createFile(
    "p",
    "user",
    { ...createArgs, dryRun: true },
    f.authorize,
  );
  await f.backend.deleteFile(
    "p",
    "user",
    { ...deleteArgs, dryRun: true },
    f.authorize,
  );
  await assert.rejects(
    f.backend.createFile(
      "p",
      "user",
      { ...createArgs, folderId: null, name: "main.tex" },
      f.authorize,
    ),
    { code: "NAME_CONFLICT" },
  );
  await assert.rejects(
    f.backend.createFile(
      "p",
      "user",
      { ...createArgs, folderId: "foreign" },
      f.authorize,
    ),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    f.backend.createFile(
      "p",
      "user",
      { ...createArgs, content: "🌱" },
      f.authorize,
    ),
    { code: "UNSUPPORTED_TEXT" },
  );
  await assert.rejects(
    f.backend.deleteFile(
      "p",
      "user",
      { ...deleteArgs, fileId: "nested" },
      f.authorize,
    ),
    { code: "FOLDER_DELETE_UNSUPPORTED" },
  );
  await assert.rejects(
    f.backend.deleteFile(
      "p",
      "user",
      { ...deleteArgs, fileId: "foreign" },
      f.authorize,
    ),
    { code: "NOT_FOUND" },
  );
  await assert.rejects(
    f.backend.deleteFile(
      "p",
      "user",
      { ...deleteArgs, expectedPath: "/stale.tex" },
      f.authorize,
    ),
    { code: "PATH_CONFLICT" },
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.events.length, 0);
});

test("path and collision checks observe structure changes made before acquiring the lock", async () => {
  const f = fixture();
  f.setOnLock(() => {
    f.project.rootFolder[0].docs[0].name = "renamed.tex";
  });
  await assert.rejects(
    f.backend.deleteFile("p", "user", deleteArgs, f.authorize),
    { code: "PATH_CONFLICT" },
  );
  f.setOnLock(() => {
    f.project.rootFolder[0].folders[0].docs.push({
      _id: "raced",
      name: "part.tex",
    });
  });
  await assert.rejects(
    f.backend.createFile("p", "user", createArgs, f.authorize),
    { code: "NAME_CONFLICT" },
  );
  assert.equal(f.calls.length, 0);
});
