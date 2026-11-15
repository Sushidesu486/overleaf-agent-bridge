import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CookieJar } from "tough-cookie";
import { load } from "cheerio";

const origin = process.env.GITHUB_LINK_SMOKE_URL || "http://localhost:18083";
const url = new URL(origin);
assert.ok(
  ["localhost", "127.0.0.1"].includes(url.hostname),
  "Use an isolated loopback preview",
);
const account = JSON.parse(
  await readFile(
    process.env.GITHUB_LINK_SMOKE_ACCOUNT ||
      ".local/github-preview-account.json",
    "utf8",
  ),
);
const jar = new CookieJar();
let csrf = "";
async function request(
  path: string,
  body?: unknown,
  token = csrf,
  authenticated = true,
) {
  const response = await fetch(origin + path, {
    method: body === undefined ? "GET" : "POST",
    redirect: "manual",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Cookie: authenticated ? await jar.getCookieString(origin) : "",
      "X-CSRF-Token": token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (authenticated)
    for (const cookie of response.headers.getSetCookie())
      await jar.setCookie(cookie, origin);
  return response;
}
const login = await request("/login");
csrf = load(await login.text())('meta[name="ol-csrfToken"]').attr("content")!;
assert.ok(csrf);
assert.equal((await request("/login", account)).status, 200);
const settings = await request("/user/settings");
assert.equal(settings.status, 200);
csrf = load(await settings.text())('meta[name="ol-csrfToken"]').attr(
  "content",
)!;
assert.ok(csrf);
assert.equal((await request("/user/github", undefined, "", false)).status, 401);
assert.equal(
  (await request("/user/github/start", {}, "invalid-csrf")).status,
  403,
);
const status = await request("/user/github");
assert.equal(status.status, 200);
assert.equal(status.headers.get("cache-control"), "no-store");
const state = await status.json();
if (process.env.GITHUB_LINK_SMOKE_EXPECT_CONFIGURED !== undefined)
  assert.equal(
    state.configured,
    process.env.GITHUB_LINK_SMOKE_EXPECT_CONFIGURED === "true",
  );
assert.equal(state.link, null, "Use an unlinked synthetic test account");
assert.equal(state.canonicalSettingsUrl, null);
const start = await request("/user/github/start", {});
if (state.configured) {
  assert.equal(start.status, 200);
  const authorize = new URL((await start.json()).url);
  assert.equal(authorize.origin, "https://github.com");
  assert.equal(
    authorize.searchParams.get("redirect_uri"),
    `${origin}/user/github/callback`,
  );
  const callback = `/user/github/callback?state=${encodeURIComponent(authorize.searchParams.get("state")!)}&error=access_denied`;
  const denied = await request(callback);
  assert.equal(denied.status, 303);
  assert.equal(
    denied.headers.get("location"),
    "/user/settings?github=denied#github-account",
  );
  assert.equal(
    (await request(callback)).headers.get("location"),
    "/user/settings?github=expired#github-account",
  );
} else {
  assert.equal(start.status, 503);
  assert.equal((await start.json()).error, "unconfigured");
}
assert.equal((await request("/github-callback")).status, 404);
for (const suffix of ["", "/"]) {
  const callback = await request(
    `/user/github/callback${suffix}?state=GithubLogProbeState20261114&code=GithubLogProbeCode20261114`,
  );
  assert.equal(callback.status, 303);
  assert.ok(!callback.headers.get("location")!.includes("Probe"));
}
const registration = await request("/register");
assert.equal(registration.status, 404);
assert.equal((await request("/signup/verify")).status, 403);
assert.equal((await request("/user/agent/state")).status, 200);
console.log(
  `GitHub native HTTP smoke passed (${state.configured ? "authorization cancellation and replay" : "unconfigured App"}); email login, CSRF, callback sanitization, closed registration and Agent settings passed.`,
);
