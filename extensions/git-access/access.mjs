import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export class GitError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
export const digest = (secret) =>
  createHash("sha256").update(secret).digest("hex");
export const validId = (id) =>
  typeof id === "string" && /^[a-f0-9]{24}$/.test(id);
const writable = (role) => role === "owner" || role === "readAndWrite";
const publicGrant = ({ digest: _digest, ...grant }) => grant;

export function createGitAccess({ store, users, now = () => new Date() }) {
  async function member(userId, projectId) {
    if (!validId(userId) || !validId(projectId))
      throw new GitError("invalid_id", "Invalid user or project ID.");
    const user = await users.get(userId);
    if (!user) throw new GitError("session", "Sign in to your account.", 401);
    const role = await users.role(userId, projectId);
    if (!["owner", "readAndWrite", "readOnly"].includes(role))
      throw new GitError(
        "forbidden",
        "You do not have access to this project.",
        403,
      );
    return { user, role };
  }
  async function active(token) {
    if (
      typeof token !== "string" ||
      !/^olg_[a-f0-9]{24}\.[A-Za-z0-9_-]{43}$/.test(token)
    )
      throw new GitError("token_invalid", "Invalid Git token.", 401);
    const [id] = token.slice(4).split(".");
    const grant = await store.getGrant(id);
    if (
      !grant ||
      grant.revokedAt ||
      !timingSafeEqual(
        Buffer.from(grant.digest, "hex"),
        Buffer.from(digest(token), "hex"),
      )
    )
      throw new GitError("token_invalid", "Invalid Git token.", 401);
    if (new Date(grant.expiresAt) <= now())
      throw new GitError("token_expired", "This Git token has expired.", 401);
    return grant;
  }
  async function authorizeGrant(grant, projectId, mode) {
    if (!grant || grant.revokedAt)
      throw new GitError("token_invalid", "Invalid Git token.", 401);
    if (new Date(grant.expiresAt) <= now())
      throw new GitError("token_expired", "This Git token has expired.", 401);
    if (projectId && grant.projectId !== projectId)
      throw new GitError(
        "forbidden",
        "This token does not grant access to this project.",
        403,
      );
    const { user, role } = await member(grant.userId, grant.projectId);
    if (!(await store.getLink(grant.projectId))?.enabled)
      throw new GitError(
        "disabled",
        "Git access is disabled for this project.",
        403,
      );
    if (mode === "write" && (grant.mode !== "write" || !writable(role)))
      throw new GitError("forbidden", "This Git token is read-only.", 403);
    return { ...publicGrant(grant), user };
  }
  return {
    async enable(userId, projectId, enabled) {
      const { role } = await member(userId, projectId);
      if (role !== "owner")
        throw new GitError(
          "forbidden",
          "Only the project owner can enable Git access.",
          403,
        );
      if (typeof enabled !== "boolean")
        throw new GitError(
          "invalid_input",
          "Choose whether Git access is enabled.",
        );
      await store.setEnabled(projectId, enabled);
    },
    async status(userId, projectId) {
      const { role } = await member(userId, projectId);
      return {
        enabled: (await store.getLink(projectId))?.enabled === true,
        role,
        grants: (await store.listGrants(userId, projectId)).map(publicGrant),
      };
    },
    async issue(userId, projectId, input) {
      const { role } = await member(userId, projectId);
      if (!(await store.getLink(projectId))?.enabled)
        throw new GitError(
          "disabled",
          "The project owner must enable Git access first.",
          409,
        );
      const name = typeof input?.name === "string" ? input.name.trim() : "";
      if (
        !name ||
        name.length > 80 ||
        !["read", "write"].includes(input.mode) ||
        !["human", "agent"].includes(input.actor)
      )
        throw new GitError(
          "invalid_input",
          "Enter a name, access level and client type.",
        );
      if (input.mode === "write" && !writable(role))
        throw new GitError(
          "forbidden",
          "This project is read-only for your account.",
          403,
        );
      const id = randomBytes(12).toString("hex");
      const token = `olg_${id}.${randomBytes(32).toString("base64url")}`;
      const grant = {
        id,
        userId,
        projectId,
        name,
        mode: input.mode,
        actor: input.actor,
        digest: digest(token),
        createdAt: now().toISOString(),
        expiresAt: new Date(now().getTime() + 90 * 86400_000).toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      };
      await store.putGrant(grant);
      return { ...publicGrant(grant), token };
    },
    async revoke(userId, projectId, id) {
      if (!validId(userId) || !validId(projectId) || !validId(id))
        throw new GitError("invalid_id", "Invalid token ID.");
      const grant = await store.getGrant(id);
      if (!grant || grant.userId !== userId || grant.projectId !== projectId)
        throw new GitError("not_found", "Git token not found.", 404);
      // A user can revoke their token even after leaving the project.
      await store.revoke(id, userId);
    },
    async authorize(token, projectId, mode = "read") {
      const grant = await active(token);
      const context = await authorizeGrant(grant, projectId, mode);
      await store.touch(grant.id);
      return context;
    },
    async authorizeDownload(grantId, projectId) {
      return authorizeGrant(await store.getGrant(grantId), projectId, "read");
    },
  };
}
