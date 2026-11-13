import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Settings from "@overleaf/settings";
import logger from "@overleaf/logger";
import mongoose from "../../app/src/infrastructure/Mongoose.mjs";
import { RateLimiter } from "../../app/src/infrastructure/RateLimiter.mjs";
import UserGetter from "../../app/src/Features/User/UserGetter.mjs";
import UserCreator from "../../app/src/Features/User/UserCreator.mjs";
import EmailHelper from "../../app/src/Features/Helpers/EmailHelper.mjs";
import EmailSender from "../../app/src/Features/Email/EmailSender.mjs";
import AuthenticationManager from "../../app/src/Features/Authentication/AuthenticationManager.mjs";
import AuthenticationController from "../../app/src/Features/Authentication/AuthenticationController.mjs";
import SessionManager from "../../app/src/Features/Authentication/SessionManager.mjs";
import { createAccessService, AccessError, digest } from "./auth.mjs";

const enabled = process.env.SITE_SELF_REGISTRATION === "true";
Settings.siteAccess = { registration: enabled };
const siteUrl = Settings.siteUrl.replace(/\/$/, "");
const view = (name) =>
  fileURLToPath(new URL(`./app/views/${name}`, import.meta.url));
let tokensPromise;
function tokens() {
  return (tokensPromise ??= (async () => {
    await mongoose.connectionPromise;
    const collection = mongoose.connection.db.collection(
      "site_registration_tokens",
    );
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    return collection;
  })());
}
const store = {
  async putToken(token) {
    await (await tokens()).insertOne(token);
  },
  async deleteToken(key) {
    await (await tokens()).deleteOne({ _id: key });
  },
  async getToken(key, now) {
    return (await tokens()).findOne({ _id: key, expiresAt: { $gt: now } });
  },
  async takeToken(key, now) {
    return (await tokens()).findOneAndDelete({
      _id: key,
      expiresAt: { $gt: now },
    });
  },
};
const access = createAccessService({
  store,
  siteUrl,
  normalizeEmail: EmailHelper.parseEmail,
  users: {
    findByEmail: UserGetter.promises.getUserByAnyEmail,
    validatePassword(password, email) {
      if (
        typeof password !== "string" ||
        AuthenticationManager.validatePassword(password, email)
      )
        throw new AccessError(
          "password",
          "Use 8–72 characters with letters, numbers or common symbols. Avoid including your email address.",
        );
    },
    async create(email, password) {
      // Hash before saving: the account is created with its final credentials.
      const hashedPassword =
        await AuthenticationManager.promises.hashPassword(password);
      try {
        return await UserCreator.promises.createNewUser(
          {
            email,
            hashedPassword,
            holdingAccount: false,
            analyticsId: randomUUID(),
          },
          { confirmedAt: new Date() },
        );
      } catch (error) {
        if (error.code === 11000)
          throw new AccessError(
            "existing",
            "An account already uses this email address. Sign in to your existing account.",
          );
        throw error;
      }
    },
  },
  async mail(email, kind, link) {
    // Native EmailSender otherwise logs the entire email and reports success.
    if (!Settings.email?.parameters)
      throw new AccessError(
        "mail",
        "Registration email is not configured. Please try again later.",
        503,
      );
    const brand = Settings.appName;
    const text =
      kind === "existing"
        ? `You requested an account on ${brand}. This email already has an account. Sign in with your existing password, or use the password reset link on the sign-in page.\n\n${link}\n\nIf you did not request this, you can ignore this email.`
        : `Welcome to ${brand}. Open the following link within 30 minutes to verify your email address and set a password:\n\n${link}\n\nThis link can only be used once.If you did not request this, you can ignore this email.`;
    try {
      await EmailSender.promises.sendEmail(
        {
          to: email,
          subject: `${brand} · ${kind === "existing" ? "Sign in to your account" : "Verify your email and create an account"}`,
          text,
        },
        "siteRegistration",
      );
    } catch {
      // SMTP errors can embed credentials or the activation link.
      logger.warn({}, "Site registration email delivery failed");
      throw new AccessError(
        "mail",
        "Email delivery failed. Try again later or contact the administrator.",
        503,
      );
    }
  },
});

const ipLimit = new RateLimiter("site-registration-ip", {
  points: 20,
  duration: 600,
});
const emailLimit = new RateLimiter("site-registration-email", {
  points: 3,
  duration: 3600,
});
const cooldown = new RateLimiter("site-registration-cooldown", {
  points: 1,
  duration: 60,
});
const verifyLimit = new RateLimiter("site-registration-verify", {
  points: 30,
  duration: 600,
});
async function limit(limiter, key, method) {
  try {
    await limiter.consume(key, 1, { method });
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new AccessError(
      "rate_limit",
      "Too many requests. Please try again later.",
      429,
    );
  }
}
function guard(handler, page) {
  return async (req, res) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    try {
      if (!enabled)
        throw new AccessError(
          "closed",
          "Self-registration is closed. Please contact the administrator.",
          403,
        );
      if (SessionManager.isUserLoggedIn(req.session))
        return res.redirect("/project");
      await handler(req, res);
    } catch (error) {
      const expected = error instanceof AccessError;
      if (!expected)
        logger.error(
          { code: String(error.code || "unknown") },
          "Site registration failed",
        );
      res.status(expected ? error.status : 500).render(view(page), {
        title: "register",
        error: expected
          ? error.message
          : "Registration is temporarily unavailable. Please try again later.",
        // Keep the token only for a password validation retry; never echo passwords.
        token:
          error.code === "password" && typeof req.body.token === "string"
            ? req.body.token
            : "",
      });
    }
  };
}

export const router = {
  apply(webRouter) {
    for (const path of ["/register", "/signup/verify", "/site-access.js"])
      AuthenticationController.addEndpointToLoginWhitelist(path);
    webRouter.get("/site-access.js", (_req, res) =>
      res.sendFile(
        fileURLToPath(new URL("./public/site-access.js", import.meta.url)),
      ),
    );
    webRouter.post(
      "/register",
      guard(async (req, res) => {
        await limit(ipLimit, req.ip, "ip");
        const email = EmailHelper.parseEmail(req.body.email);
        if (!email)
          throw new AccessError("email", "Enter a valid email address.");
        await limit(cooldown, digest(email), "email");
        await limit(emailLimit, digest(email), "email");
        await access.requestRegistration(email);
        res.render(view("register"), { title: "register", sent: true });
      }, "register"),
    );
    webRouter.get(
      "/signup/verify",
      guard(async (_req, res) => {
        res.render(view("verify"), { title: "register" });
      }, "verify"),
    );
    webRouter.post(
      "/signup/verify",
      guard(async (req, res) => {
        await limit(verifyLimit, req.ip, "ip");
        if (req.body.password !== req.body.passwordConfirm)
          throw new AccessError(
            "password",
            "The passwords do not match. Please try again.",
          );
        const user = await access.completeRegistration(
          req.body.token,
          req.body.password,
        );
        req.session.justRegistered = true;
        AuthenticationController.setAuditInfo(req, {
          method: "Verified email registration",
        });
        await AuthenticationController.promises.finishLogin(user, req, res);
      }, "verify"),
    );
  },
};

export default { router };
