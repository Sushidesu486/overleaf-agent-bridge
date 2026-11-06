import assert from "node:assert/strict";
import { CookieJar } from "tough-cookie";
import { load } from "cheerio";
export const origin = "http://localhost:18080";
export class Browser {
  jar = new CookieJar();
  csrf = "";
  async request(path: string, body?: unknown, csrf = this.csrf) {
    const response = await fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "manual",
      headers: {
        Accept: "application/json",
        Cookie: await this.jar.getCookieString(origin),
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie())
      await this.jar.setCookie(cookie, origin);
    return response;
  }
  async login(user: { email: string; password: string }) {
    this.csrf = load(await (await this.request("/login")).text())(
      'meta[name="ol-csrfToken"]',
    ).attr("content")!;
    assert.equal((await this.request("/login", user)).status, 200);
    const page = await this.request("/user/agent");
    assert.equal(page.status, 200);
    this.csrf = load(await page.text())('meta[name="ol-csrfToken"]').attr(
      "content",
    )!;
    assert.ok(this.csrf);
  }
  async json(path: string, body?: unknown) {
    const response = await this.request(path, body);
    assert.equal(response.status, 200, `HTTP request failed at ${path}`);
    return response.json();
  }
}
