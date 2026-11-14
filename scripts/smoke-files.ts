import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Browser } from "./lab-browser.js";

const origin = process.env.OVERLEAF_LAB_ORIGIN ?? "http://localhost:18080";
const accountPath =
  process.env.OVERLEAF_LAB_ACCOUNT ?? ".local/file-smoke-account.json";
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname),
  "Only run this fixture against an isolated loopback lab",
);
assert.equal(
  (await stat(accountPath)).mode & 0o077,
  0,
  "Restrict the fixture account file to mode 0600",
);
const account = JSON.parse(await readFile(accountPath, "utf8"));
assert.ok(
  account.email.endsWith("@example.invalid"),
  "Use a synthetic lab account",
);
const browser = new Browser(origin);
await browser.login(account);
const { project_id: projectId } = await browser.json("/project/new", {
  projectName: `MCP file smoke ${new Date().toISOString()}`,
  template: "example",
});
assert.match(projectId, /^[a-f0-9]{24}$/);
const grants: string[] = [],
  clients: Client[] = [];
async function connect(actions = ["read", "edit", "compile"]) {
  const link = await browser.json("/user/agent/links", {
    name: "File smoke",
    projects: [projectId],
    actions,
  });
  grants.push(link.grant.id);
  const client = new Client({ name: "file-smoke", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(link.url)));
  return client;
}
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  expectedError?: string,
) {
  const result = await client.callTool(
    { name, arguments: { projectId, ...args } },
    undefined,
    { timeout: 120_000 },
  );
  const value = JSON.parse((result.content as Array<{ text: string }>)[0].text);
  if (expectedError) {
    assert.ok(result.isError, `Expected ${expectedError}`);
    assert.equal(value.code, expectedError);
  } else assert.ok(!result.isError, `${name}: ${value.code}: ${value.message}`);
  return value;
}
const op = () => ({ operationId: randomUUID() });
try {
  const client = await connect();
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 10);
  assert.equal(
    tools.find((t) => t.name === "overleaf_delete_file")?.annotations
      ?.destructiveHint,
    true,
  );
  const tree = () => call(client, "overleaf_get_project_tree", {});
  const original = await tree();
  assert.ok(
    original.folders.some(
      (f: { id: string; path: string }) =>
        f.id === original.rootFolderId && f.path === "/",
    ),
  );
  const folderArgs = { name: "sections", ...op() };
  const folderPreview = await call(client, "overleaf_create_folder", {
    ...folderArgs,
    dryRun: true,
  });
  assert.equal(folderPreview.result.path, "/sections/");
  assert.equal((await tree()).folders.length, original.folders.length);
  const folder = (await call(client, "overleaf_create_folder", folderArgs))
    .result;
  assert.equal(folder.parentFolderId, original.rootFolderId);
  await call(
    client,
    "overleaf_create_folder",
    folderArgs,
    "OPERATION_ALREADY_SUBMITTED",
  );
  await call(
    client,
    "overleaf_create_folder",
    { name: "sections", ...op() },
    "NAME_CONFLICT",
  );
  await call(
    client,
    "overleaf_create_folder",
    { name: "main.tex", ...op() },
    "NAME_CONFLICT",
  );
  await call(
    client,
    "overleaf_create_folder",
    { name: "foreign", parentFolderId: "aaaaaaaaaaaaaaaaaaaaaaaa", ...op() },
    "NOT_FOUND",
  );
  await call(
    client,
    "overleaf_create_folder",
    { name: "../outside", ...op() },
    "INVALID_INPUT",
  );
  const nested = (
    await call(client, "overleaf_create_folder", {
      name: "资料",
      parentFolderId: folder.folderId,
      ...op(),
    })
  ).result;
  assert.equal(nested.path, "/sections/资料/");
  const nestedFile = (
    await call(client, "overleaf_create_file", {
      name: "notes.tex",
      folderId: nested.folderId,
      content: "% 中文目录中的文件\n",
      ...op(),
    })
  ).result;
  assert.equal(nestedFile.path, "/sections/资料/notes.tex");
  assert.equal(
    (await call(client, "overleaf_read_document", { docId: nestedFile.id }))
      .content,
    "% 中文目录中的文件\n",
  );
  const racedFolders = await Promise.all(
    [1, 2].map(() =>
      client.callTool({
        name: "overleaf_create_folder",
        arguments: { projectId, name: "concurrent-folder", ...op() },
      }),
    ),
  );
  assert.equal(racedFolders.filter((result) => !result.isError).length, 1);
  assert.equal(
    JSON.parse(
      (
        racedFolders.find((result) => result.isError)!.content as Array<{
          text: string;
        }>
      )[0].text,
    ).code,
    "NAME_CONFLICT",
  );
  assert.equal(
    (await tree()).folders.filter(
      (f: { name: string }) => f.name === "concurrent-folder",
    ).length,
    1,
  );
  const args = {
    name: "part.tex",
    folderId: folder.folderId,
    content: "% 中文内容\r\n\\section{MCP files}\nCreated through MCP.\n",
    ...op(),
  };
  const preview = await call(client, "overleaf_create_file", {
    ...args,
    dryRun: true,
  });
  assert.equal(preview.result.path, "/sections/part.tex");
  assert.equal((await tree()).entries.length, original.entries.length + 1);
  const created = (await call(client, "overleaf_create_file", args)).result;
  assert.equal(created.type, "document");
  const doc = await call(client, "overleaf_read_document", {
    docId: created.id,
  });
  assert.equal(doc.content, args.content.replace(/\r\n/g, "\n"));
  await call(
    client,
    "overleaf_create_file",
    args,
    "OPERATION_ALREADY_SUBMITTED",
  );
  await call(
    client,
    "overleaf_create_file",
    { ...args, ...op() },
    "NAME_CONFLICT",
  );
  await call(
    client,
    "overleaf_create_file",
    { name: "sections", ...op() },
    "NAME_CONFLICT",
  );
  await call(
    client,
    "overleaf_create_file",
    { name: "x.tex", folderId: "aaaaaaaaaaaaaaaaaaaaaaaa", ...op() },
    "NOT_FOUND",
  );
  const concurrent = await Promise.all(
    [1, 2].map(() =>
      client.callTool({
        name: "overleaf_create_file",
        arguments: { projectId, name: "race.tex", ...op() },
      }),
    ),
  );
  assert.equal(concurrent.filter((r) => !r.isError).length, 1);
  assert.equal(
    JSON.parse(
      (concurrent.find((r) => r.isError)!.content as Array<{ text: string }>)[0]
        .text,
    ).code,
    "NAME_CONFLICT",
  );
  const initialHistory = await browser.json(`/project/${projectId}/updates`);
  assert.ok(
    initialHistory.updates.some(
      (update: {
        meta?: {
          origin?: { kind: string };
          users?: Array<{ displayName: string }>;
        };
      }) =>
        update.meta?.origin?.kind === "agent" &&
        update.meta.users?.[0]?.displayName === "Your agent",
    ),
    "File creation must retain Agent history attribution",
  );
  const bib = (
    await call(client, "overleaf_create_file", {
      name: "references.bib",
      content: "@misc{bridge, title={Overleaf Agent Bridge}}\n",
      ...op(),
    })
  ).result;
  assert.match(
    (await call(client, "overleaf_read_document", { docId: bib.id })).content,
    /Overleaf Agent Bridge/,
  );
  const bytes = randomBytes(50_000_000);
  const attachment = (
    await call(client, "overleaf_create_file", {
      name: "attachment.bin",
      encoding: "base64",
      content: bytes.toString("base64"),
      ...op(),
    })
  ).result;
  const downloaded = await browser.request(
    `/project/${projectId}/file/${attachment.id}`,
  );
  assert.equal(downloaded.status, 200);
  const checksum = (buffer: Buffer) =>
    createHash("sha256").update(buffer).digest("hex");
  assert.equal(
    checksum(Buffer.from(await downloaded.arrayBuffer())),
    checksum(bytes),
  );
  const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><!--${"x".repeat(3_000_000)}--><rect width="1" height="1"/></svg>`;
  const vector = (
    await call(client, "overleaf_create_file", {
      name: "vector.svg",
      encoding: "base64",
      content: Buffer.from(svgContent).toString("base64"),
      ...op(),
    })
  ).result;
  assert.equal(vector.type, "file");
  const svgDownload = await browser.request(
    `/project/${projectId}/file/${vector.id}`,
  );
  assert.equal(svgDownload.status, 200);
  assert.equal(await svgDownload.text(), svgContent);
  const pixel = (
    await call(client, "overleaf_create_file", {
      name: "pixel.png",
      encoding: "base64",
      content:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1cAAAAASUVORK5CYII=",
      ...op(),
    })
  ).result;
  const main = await call(client, "overleaf_read_document", {
    docId: original.rootDocId,
  });
  await call(client, "overleaf_edit_document", {
    docId: original.rootDocId,
    expectedVersion: main.version,
    oldText: "\\end{document}",
    newText: "\\input{sections/part}\n\\end{document}",
    ...op(),
  });
  const compilation = await call(client, "overleaf_compile", {});
  assert.equal(
    compilation.status,
    "success",
    JSON.stringify(compilation.diagnostics),
  );
  const readOnly = await connect(["read"]);
  await call(
    readOnly,
    "overleaf_create_folder",
    { name: "denied", ...op() },
    "OUTSIDE_GRANT",
  );
  await call(
    client,
    "overleaf_create_folder",
    { projectId: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "denied", ...op() },
    "OUTSIDE_GRANT",
  );
  await call(
    readOnly,
    "overleaf_create_file",
    { name: "denied.tex", ...op() },
    "OUTSIDE_GRANT",
  );
  await call(
    readOnly,
    "overleaf_delete_file",
    { fileId: created.id, expectedPath: created.path, ...op() },
    "OUTSIDE_GRANT",
  );
  await call(
    client,
    "overleaf_create_file",
    { projectId: "aaaaaaaaaaaaaaaaaaaaaaaa", name: "denied.tex", ...op() },
    "OUTSIDE_GRANT",
  );
  await call(
    client,
    "overleaf_delete_file",
    { fileId: folder.folderId, expectedPath: "/sections/", ...op() },
    "FOLDER_DELETE_UNSUPPORTED",
  );
  const deletion = { fileId: bib.id, expectedPath: bib.path, ...op() };
  await call(client, "overleaf_delete_file", { ...deletion, dryRun: true });
  assert.ok(
    (await tree()).entries.some((e: { id: string }) => e.id === bib.id),
  );
  const rename = await browser.request(
    `/project/${projectId}/doc/${bib.id}/rename`,
    { name: "renamed.bib" },
  );
  assert.ok([200, 204].includes(rename.status));
  await call(client, "overleaf_delete_file", deletion, "PATH_CONFLICT");
  const deleted = await call(client, "overleaf_delete_file", {
    ...deletion,
    expectedPath: "/renamed.bib",
    ...op(),
  });
  assert.equal(deleted.result.deleted, true);
  await call(
    client,
    "overleaf_delete_file",
    { fileId: bib.id, expectedPath: "/renamed.bib", ...op() },
    "NOT_FOUND",
  );
  for (const file of [attachment, pixel, vector]) {
    const args = { fileId: file.id, expectedPath: file.path, ...op() };
    await call(client, "overleaf_delete_file", args);
    await call(
      client,
      "overleaf_delete_file",
      args,
      "OPERATION_ALREADY_SUBMITTED",
    );
    assert.ok(
      !(await tree()).entries.some((e: { id: string }) => e.id === file.id),
    );
  }
  const finalHistory = await browser.json(`/project/${projectId}/updates`);
  for (const pathname of [
    "renamed.bib",
    "attachment.bin",
    "pixel.png",
    "vector.svg",
  ]) {
    assert.ok(
      finalHistory.updates.some(
        (update: {
          meta?: {
            origin?: { kind: string };
            users?: Array<{ displayName: string }>;
          };
          project_ops?: Array<{ remove?: { pathname: string } }>;
        }) =>
          update.meta?.origin?.kind === "agent" &&
          update.meta.users?.[0]?.displayName === "Your agent" &&
          update.project_ops?.some(
            (operation) => operation.remove?.pathname === pathname,
          ),
      ),
      `Deletion missing Agent history attribution: ${pathname}`,
    );
  }
  console.log(
    JSON.stringify(
      {
        projectId,
        tools: tools.length,
        folders:
          "root, nested, Unicode names, collision, dry run and replay checks passed",
        textAndBib: "read back",
        binaryBytes: bytes.length,
        binaryChecksum: "matched",
        svgBytes: Buffer.byteLength(svgContent),
        concurrentNameCollision: "one creation",
        createAndDeleteHistory: "Your agent",
        compile: compilation.status,
        delete: "document and attachments",
        stalePath: "rejected",
        readOnly: "denied",
      },
      null,
      2,
    ),
  );
} finally {
  for (const client of clients) await client.close();
  for (const id of grants)
    await browser.json(`/user/agent/links/${id}/revoke`, {});
}
