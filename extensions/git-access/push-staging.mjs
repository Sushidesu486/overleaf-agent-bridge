import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GitError, validId } from "./access.mjs";
import {
  validatePath,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_PROJECT_BYTES,
} from "./snapshots.mjs";

const validOperation = (id) =>
  typeof id === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    id,
  );
const invalid = (message) => new GitError("invalid_candidate", message, 422);
async function syncPath(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Staging is complete before a native write barrier is acquired. Opaque filenames
// keep Git paths out of filesystem lookups; the published manifest has no URLs.
export function createPushStaging({
  root,
  bridgeUrl,
  snapshots,
  fetcher = fetch,
}) {
  const origin = new URL(bridgeUrl);
  if (
    !/^https?:$/.test(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("GIT_BRIDGE_INTERNAL_URL must be an HTTP(S) origin");
  function directory(projectId, operationId) {
    if (!validId(projectId) || !validOperation(operationId))
      throw invalid("Invalid Git operation identifier.");
    return join(root, projectId, operationId);
  }
  function validateManifest(projectId, body) {
    if (
      !body ||
      !Number.isSafeInteger(body.latestVerId) ||
      body.latestVerId < 1 ||
      body.latestVerId > 2147483647 ||
      !Array.isArray(body.files)
    )
      throw invalid("Invalid Git candidate version or file list.");
    if (body.files.length > MAX_FILES)
      throw new GitError(
        "file_limit",
        "Too many files in the Git candidate.",
        413,
      );
    let callback;
    try {
      callback = new URL(body.postbackUrl);
    } catch {
      throw invalid("Invalid Git callback.");
    }
    const match = new RegExp(
      `^/api/${projectId}/([A-Za-z0-9_-]{20,128})/postback$`,
    ).exec(callback.pathname);
    if (
      callback.origin !== origin.origin ||
      callback.username ||
      callback.password ||
      callback.search ||
      callback.hash ||
      !match
    )
      throw invalid(
        "Git callback must belong to the configured bridge and project.",
      );
    const names = new Set();
    const files = body.files.map((file) => {
      if (!file || typeof file !== "object")
        throw invalid("Invalid Git file entry.");
      const path = validatePath(file.name);
      if (names.has(path)) throw invalid(`Duplicate Git path: ${path}`);
      names.add(path);
      if (file.url === undefined) return { path };
      let url;
      try {
        url = new URL(file.url);
      } catch {
        throw invalid("Invalid Git blob URL.");
      }
      if (
        url.origin !== origin.origin ||
        url.username ||
        url.password ||
        url.hash ||
        !new RegExp(`^/api/${projectId}/[A-Za-z0-9_-]{1,128}$`).test(
          url.pathname,
        ) ||
        url.search !== `?key=${match[1]}`
      )
        throw invalid(
          "Git blobs must belong to the configured bridge, project and operation.",
        );
      return { path, url: url.href };
    });
    for (const path of names) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++)
        if (names.has(parts.slice(0, i).join("/")))
          throw invalid(`File/folder conflict: ${path}`);
    }
    return files;
  }
  return {
    filePath(projectId, operationId, index) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_FILES)
        throw invalid("Invalid staged file index.");
      return join(directory(projectId, operationId), String(index));
    },
    async read(projectId, operationId) {
      return JSON.parse(
        await readFile(
          join(directory(projectId, operationId), "manifest.json"),
          "utf8",
        ),
      );
    },
    async discard(projectId, operationId) {
      await rm(directory(projectId, operationId), {
        recursive: true,
        force: true,
      });
    },
    async stage(projectId, operationId, body) {
      const destination = directory(projectId, operationId);
      const entries = validateManifest(projectId, body);
      const base = await snapshots.read(projectId, body.latestVerId);
      const oldFiles = new Map(base.files.map((file) => [file.path, file]));
      // Reject missing unchanged blobs before making any network requests.
      for (const entry of entries)
        if (!entry.url && !oldFiles.has(entry.path))
          throw invalid(`Missing content for new file: ${entry.path}`);
      await mkdir(join(root, projectId), { recursive: true, mode: 0o700 });
      const temp = await mkdtemp(join(root, projectId, ".staging-"));
      let totalBytes = 0;
      try {
        const files = [];
        for (const [index, entry] of entries.entries()) {
          let stream;
          if (entry.url) {
            const response = await fetcher(entry.url, {
              redirect: "error",
              signal: AbortSignal.timeout(60_000),
            });
            if (!response.ok || !response.body)
              throw new GitError(
                "blob_unavailable",
                "Unable to download a Git candidate file. Retry the push.",
                502,
              );
            stream = Readable.fromWeb(response.body);
          } else {
            stream = (
              await snapshots.file(
                projectId,
                base.version,
                oldFiles.get(entry.path).index,
              )
            ).stream;
          }
          let bytes = 0;
          const hash = createHash("sha256");
          const filePath = join(temp, String(index));
          await pipeline(
            stream,
            new Transform({
              transform(chunk, _encoding, done) {
                bytes += chunk.length;
                totalBytes += chunk.length;
                if (bytes > MAX_FILE_BYTES || totalBytes > MAX_PROJECT_BYTES)
                  return done(
                    new GitError(
                      "size_limit",
                      "Git files must be at most 50 MB and the project at most 500 MB.",
                      413,
                    ),
                  );
                hash.update(chunk);
                done(null, chunk);
              },
            }),
            createWriteStream(filePath, { flags: "wx", mode: 0o600 }),
          );
          await syncPath(filePath);
          const sha256 = hash.digest("hex");
          const previous = oldFiles.get(entry.path);
          if (
            !entry.url &&
            (previous.bytes !== bytes || previous.sha256 !== sha256)
          )
            throw new GitError(
              "snapshot_corrupt",
              "The base Git snapshot is incomplete. Fetch and retry.",
              409,
            );
          files.push({
            index,
            path: entry.path,
            bytes,
            sha256,
            changed: previous?.sha256 !== sha256,
          });
        }
        const names = new Set(files.map((file) => file.path));
        const manifest = {
          projectId,
          operationId,
          baseVersion: base.version,
          files,
          deleted: base.files
            .filter((file) => !names.has(file.path))
            .map((file) => file.path),
          totalBytes,
        };
        const handle = await open(join(temp, "manifest.json"), "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(manifest));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncPath(temp);
        // Never replace an operation that a recovery worker may already own.
        await rename(temp, destination);
        await syncPath(join(root, projectId));
        return manifest;
      } catch (error) {
        await rm(temp, { recursive: true, force: true });
        throw error;
      }
    },
  };
}
