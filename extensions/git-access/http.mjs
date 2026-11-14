import { createHmac, timingSafeEqual } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { GitError, validId } from "./access.mjs";

const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function createGitApi({
  access,
  snapshots,
  secret,
  internalUrl,
  push,
  onError = () => {},
}) {
  const sign = (text) =>
    createHmac("sha256", secret).update(text).digest("hex");
  const downloadUrl = (ctx, snapshot, file) => {
    const path = `/blobs/${ctx.projectId}/${snapshot.version}/${file.index}`;
    const query = `grant=${ctx.id}&expires=${Date.now() + 15 * 60_000}`;
    return `${internalUrl}${path}?${query}&signature=${sign(path + "?" + query)}`;
  };
  const send = (res, status, result) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(result));
  };
  return async (req, res) => {
    try {
      const url = new URL(req.url, internalUrl);
      const blob = /^\/blobs\/([a-f0-9]{24})\/(\d+)\/(\d+)$/.exec(url.pathname);
      if (req.method === "GET" && blob) {
        const grant = url.searchParams.get("grant"),
          expires = url.searchParams.get("expires");
        const query = `grant=${grant}&expires=${expires}`;
        if (
          !validId(grant) ||
          !/^\d{13}$/.test(expires ?? "") ||
          Number(expires) < Date.now() ||
          !equal(
            url.searchParams.get("signature"),
            sign(url.pathname + "?" + query),
          )
        )
          throw new GitError("forbidden", "Expired snapshot download.", 403);
        await access.authorizeDownload(grant, blob[1]);
        const file = await snapshots.file(
          blob[1],
          Number(blob[2]),
          Number(blob[3]),
        );
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          "Content-Length": file.bytes,
          "Cache-Control": "no-store",
        });
        await pipeline(file.stream, res);
        return;
      }
      if (!equal(req.headers["x-overleaf-git-service"], secret))
        throw new GitError("forbidden", "Private Git service.", 403);
      const token =
        /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      if (req.method === "GET" && url.pathname === "/oauth/token/info") {
        const projectId = url.searchParams.get("project_id");
        if (!validId(projectId))
          throw new GitError("invalid_id", "Invalid project ID.");
        const mode =
          url.searchParams.get("access") === "write" ? "write" : "read";
        await access.authorize(token, projectId, mode);
        if (mode === "write" && !push)
          throw new GitError(
            "read_only_preview",
            "Git push is not enabled in this preview.",
            403,
          );
        send(res, 200, { active: true });
        return;
      }
      const match =
        /^\/api\/v0\/docs\/([a-f0-9]{24})(?:\/(saved_vers|snapshots)(?:\/(\d+))?)?\/?$/.exec(
          url.pathname,
        );
      if (!match)
        throw new GitError("not_found", "Git endpoint not found.", 404);
      const [, projectId, endpoint, version] = match;
      const ctx = await access.authorize(
        token,
        projectId,
        req.method === "POST" ? "write" : "read",
      );
      if (req.method === "GET" && !endpoint) {
        const snapshot = await snapshots.latest(projectId);
        send(res, 200, {
          latestVerId: snapshot.version,
          latestVerAt: snapshot.timestamp,
          latestVerBy: snapshot.author,
        });
      } else if (req.method === "GET" && endpoint === "saved_vers" && !version)
        send(res, 200, []);
      else if (req.method === "GET" && endpoint === "snapshots" && version) {
        const snapshot = await snapshots.read(projectId, Number(version));
        send(res, 200, {
          srcs: [],
          atts: snapshot.files.map((file) => [
            downloadUrl(ctx, snapshot, file),
            file.path,
          ]),
        });
      } else if (
        req.method === "POST" &&
        endpoint === "snapshots" &&
        !version &&
        push
      ) {
        let bytes = 0;
        const chunks = [];
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 2_000_000)
            throw new GitError("size_limit", "Git manifest is too large.", 413);
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks));
        } catch {
          throw new GitError("invalid_input", "Invalid Git manifest.");
        }
        send(
          res,
          200,
          await push(ctx, body, () =>
            access.authorize(token, projectId, "write"),
          ),
        );
      } else
        throw new GitError(
          "unsupported",
          "This Git operation is not enabled.",
          405,
        );
    } catch (error) {
      onError(error);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const known = error instanceof GitError;
      // Do not serialize native errors: they may include tokens, blob URLs or content.
      send(res, known ? error.status : 503, {
        status: known ? error.status : 503,
        error: known ? error.code : "unavailable",
        error_code: known ? error.code : "unavailable",
        message: known
          ? error.message
          : "Git synchronization is temporarily unavailable.",
      });
    }
  };
}
