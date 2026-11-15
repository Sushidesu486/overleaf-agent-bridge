import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { GitError, validId } from "./access.mjs";

export const MAX_FILE_BYTES = 50_000_000;
export const MAX_PROJECT_BYTES = 500_000_000;
export const MAX_FILES = 2000;

export function validatePath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    path.length > 1024 ||
    path.startsWith("/") ||
    /[\\*\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/.test(path) ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part.trim() !== part ||
          [".", "..", ".git"].includes(part.toLowerCase()),
      )
  )
    throw new GitError(
      "invalid_path",
      "The project contains an unsupported Git path.",
      409,
    );
  return path;
}

function boundedStream(limit, hash) {
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > limit)
        return done(
          new GitError(
            "size_limit",
            "The project exceeds the Git file or transfer limit.",
            413,
          ),
        );
      hash?.update(chunk);
      done(null, chunk);
    },
  });
}

async function unpack(zipPath, directory) {
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(zipPath, { lazyEntries: true }, (error, zip) =>
      error ? reject(error) : resolve(zip),
    ),
  );
  const files = [],
    names = new Set();
  let totalBytes = 0;
  return new Promise((resolve, reject) => {
    let failed = false;
    const fail = (error) => {
      if (!failed) {
        failed = true;
        zip.close();
        reject(error);
      }
    };
    zip.on("error", fail);
    zip.on("end", () => resolve(files));
    zip.on("entry", (entry) => {
      void (async () => {
        if (entry.fileName.endsWith("/")) {
          zip.readEntry();
          return;
        }
        const path = validatePath(entry.fileName);
        if (names.has(path) || files.length >= MAX_FILES)
          throw new GitError(
            "file_limit",
            "Duplicate paths or too many project files.",
            409,
          );
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (mode && mode !== 0x8000)
          throw new GitError(
            "file_mode",
            "Only regular Git files are supported.",
            409,
          );
        totalBytes += entry.uncompressedSize;
        if (
          entry.uncompressedSize > MAX_FILE_BYTES ||
          totalBytes > MAX_PROJECT_BYTES
        )
          throw new GitError(
            "size_limit",
            "The project exceeds the Git file or transfer limit.",
            413,
          );
        names.add(path);
        const index = files.length;
        const stream = await new Promise((resolve, reject) =>
          zip.openReadStream(entry, (error, stream) =>
            error ? reject(error) : resolve(stream),
          ),
        );
        const hash = createHash("sha256");
        await pipeline(
          stream,
          boundedStream(MAX_FILE_BYTES, hash),
          createWriteStream(join(directory, String(index)), {
            mode: 0o600,
            flags: "wx",
          }),
        );
        files.push({
          path,
          index,
          bytes: entry.uncompressedSize,
          sha256: hash.digest("hex"),
        });
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}

// Every exported file comes from the same history ZIP and X-History-Version.
// The immutable on-disk snapshot remains available during all bridge downloads.
export function createSnapshotCache({ root, capture }) {
  const inFlight = new Map();
  const queues = new Map();
  // Reads renew retention before URLs are issued. Serialize them with cleanup
  // so a snapshot cannot be selected for deletion while renewing its lease.
  function exclusive(projectId, operation) {
    const result = (queues.get(projectId) ?? Promise.resolve()).then(operation);
    const tail = result.catch(() => {});
    queues.set(projectId, tail);
    void tail.then(() => {
      if (queues.get(projectId) === tail) queues.delete(projectId);
    });
    return result;
  }
  function pathFor(projectId, version) {
    if (
      !validId(projectId) ||
      !Number.isSafeInteger(version) ||
      version < 1 ||
      version > 2147483647
    )
      throw new GitError("invalid_version", "Invalid project version.");
    return join(root, projectId, String(version));
  }
  async function read(projectId, version) {
    try {
      const directory = pathFor(projectId, version);
      const manifest = JSON.parse(
        await readFile(join(directory, "manifest.json"), "utf8"),
      );
      const now = new Date();
      await utimes(directory, now, now);
      return manifest;
    } catch (error) {
      if (error.code === "ENOENT")
        throw new GitError(
          "snapshot_expired",
          "This snapshot is unavailable. Fetch the project again.",
          404,
        );
      throw error;
    }
  }
  async function latest(projectId) {
    const base = join(root, projectId);
    await mkdir(base, { recursive: true, mode: 0o700 });
    const temp = await mkdtemp(join(base, ".capture-"));
    try {
      const { stream, historyVersion, author, timestamp } =
        await capture(projectId);
      if (!/^\d+$/.test(String(historyVersion))) {
        stream.destroy();
        throw new GitError(
          "invalid_version",
          "The history service did not provide a snapshot version.",
          503,
        );
      }
      const version = Number(historyVersion) + 1;
      const target = pathFor(projectId, version);
      await pipeline(
        stream,
        boundedStream(MAX_PROJECT_BYTES + 10_000_000),
        createWriteStream(join(temp, "snapshot.zip"), { mode: 0o600 }),
      );
      try {
        await stat(join(target, "manifest.json"));
        return await read(projectId, version);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const files = await unpack(join(temp, "snapshot.zip"), temp);
      const manifest = {
        projectId,
        version,
        historyVersion: Number(historyVersion),
        author: author ?? null,
        timestamp: timestamp ?? new Date().toISOString(),
        files,
      };
      await writeFile(join(temp, "manifest.json"), JSON.stringify(manifest), {
        mode: 0o600,
      });
      await rm(join(temp, "snapshot.zip"));
      await rename(temp, target);
      // Export URLs live for 15 minutes. Keep snapshots for two days after use
      // for in-flight transfers; permanent Git history lives in the bridge PVC.
      for (const name of await readdir(base)) {
        if (!/^\d+$/.test(name) || name === String(version)) continue;
        const old = join(base, name);
        if ((await stat(old)).mtimeMs < Date.now() - 2 * 86400_000)
          await rm(old, { recursive: true, force: true });
      }
      return manifest;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  return {
    latest(projectId) {
      if (!validId(projectId))
        return Promise.reject(
          new GitError("invalid_id", "Invalid project ID."),
        );
      if (!inFlight.has(projectId))
        inFlight.set(
          projectId,
          exclusive(projectId, () => latest(projectId)).finally(() =>
            inFlight.delete(projectId),
          ),
        );
      return inFlight.get(projectId);
    },
    read(projectId, version) {
      return exclusive(projectId, () => read(projectId, version));
    },
    file(projectId, version, index) {
      return exclusive(projectId, async () => {
        const manifest = await read(projectId, version);
        const file = manifest.files.find((file) => file.index === index);
        if (!file)
          throw new GitError("not_found", "Snapshot file not found.", 404);
        return {
          ...file,
          stream: createReadStream(
            join(pathFor(projectId, version), String(index)),
          ),
        };
      });
    },
  };
}
