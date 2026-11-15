import { createHash, randomBytes } from "node:crypto";

export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const secret = () => randomBytes(32).toString("base64url");
export class AccessError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function createAccessService({
  store,
  users,
  mail,
  normalizeEmail,
  siteUrl,
  now = () => new Date(),
}) {
  return {
    async requestRegistration(rawEmail) {
      const email = normalizeEmail(rawEmail);
      if (!email)
        throw new AccessError("email", "Enter a valid email address.");
      if (await users.findByEmail(email)) {
        await mail(email, "existing", `${siteUrl}/login`);
        return;
      }
      const token = secret();
      const key = digest(token);
      await store.putToken({
        _id: key,
        email,
        expiresAt: new Date(now().getTime() + 30 * 60_000),
      });
      try {
        // The fragment is removed by the browser before submitting the form.
        // Email tokens never become request URLs or access-log entries.
        await mail(
          email,
          "register",
          `${siteUrl}/signup/verify#token=${token}`,
        );
      } catch (error) {
        await store.deleteToken(key);
        throw error;
      }
    },
    async completeRegistration(token, password) {
      if (typeof token !== "string" || !/^[\w-]{43}$/.test(token))
        throw new AccessError(
          "token",
          "This verification link has expired. Request a new registration email.",
        );
      const key = digest(token);
      const pending = await store.getToken(key, now());
      if (!pending)
        throw new AccessError(
          "token",
          "This verification link has expired. Request a new registration email.",
        );
      users.validatePassword(password, pending.email);
      const consumed = await store.takeToken(key, now());
      if (!consumed)
        throw new AccessError(
          "token",
          "This verification link has already been used. Sign in or request a new one.",
        );
      if (await users.findByEmail(consumed.email))
        throw new AccessError(
          "existing",
          "An account already uses this email address. Sign in to your existing account.",
        );
      return users.create(consumed.email, password);
    },
  };
}
