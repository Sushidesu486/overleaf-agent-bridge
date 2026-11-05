import { CookieJar } from "tough-cookie";
import { load } from "cheerio";
import type { Config } from "./config.js";
export class AdapterError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export class OverleafClient {
  private jar = new CookieJar();
  private csrf = "";
  readonly origin: string;
  constructor(private readonly config: Config) {
    const url = new URL(config.baseUrl);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new AdapterError(
        "INVALID_ORIGIN",
        "Configure an origin without credentials or a path",
      );
    if (
      url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
    )
      throw new AdapterError(
        "INVALID_ORIGIN",
        "HTTP is allowed only for a loopback development server",
      );
    this.origin = url.origin;
  }
  private async request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Response> {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin)
      throw new AdapterError(
        "INVALID_ORIGIN",
        "Cross-origin requests are not supported",
      );
    const headers: Record<string, string> = {
      accept: "application/json",
      cookie: await this.jar.getCookieString(url.href),
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["x-csrf-token"] = this.csrf;
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new AdapterError(
        "CONNECTION_FAILED",
        "Overleaf request failed or timed out",
      );
    }
    for (const cookie of response.headers.getSetCookie())
      await this.jar.setCookie(cookie, url.href);
    // Never follow redirects with session credentials or replay a failed mutation.
    if (response.status >= 300 && response.status < 400)
      throw new AdapterError(
        "SESSION_EXPIRED",
        "Overleaf redirected the request; authenticate again",
      );
    if (!response.ok)
      throw new AdapterError(
        response.status === 401 || response.status === 403
          ? "ACCESS_DENIED"
          : "UPSTREAM_ERROR",
        `Overleaf returned HTTP ${response.status}`,
      );
    return response;
  }
  async status() {
    const r = await new OverleafClient(this.config).request("/login");
    const html = await r.text();
    const $ = load(html);
    if (!$('meta[name="ol-csrfToken"]').attr("content"))
      throw new AdapterError(
        "UNSUPPORTED_SERVER",
        "Login page has no expected CSRF metadata",
      );
    return {
      reachable: true,
      origin: this.origin,
      title: $("title").text(),
      realtime: "not implemented",
      writeTools: false,
    };
  }
  async login() {
    const page = await (await this.request("/login")).text();
    this.csrf = load(page)('meta[name="ol-csrfToken"]').attr("content") ?? "";
    if (!this.csrf)
      throw new AdapterError("UNSUPPORTED_SERVER", "Missing CSRF metadata");
    await this.request("/login", "POST", {
      email: this.config.email,
      password: this.config.password,
      _csrf: this.csrf,
    });
    // CSRF token may rotate after session regeneration.
    const html = await (await this.request("/user/settings")).text();
    this.csrf =
      load(html)('meta[name="ol-csrfToken"]').attr("content") ?? this.csrf;
  }
  async createProject(name: string): Promise<string> {
    const data = (await (
      await this.request("/project/new", "POST", {
        projectName: name,
        template: "example",
      })
    ).json()) as { project_id?: string };
    if (!data.project_id || !/^[a-f0-9]{24}$/.test(data.project_id))
      throw new AdapterError(
        "UNSUPPORTED_SERVER",
        "Unexpected new-project response",
      );
    return data.project_id;
  }
  async listProjects(): Promise<Array<{ id: string; name: string }>> {
    const data = (await (
      await this.request("/api/project", "POST", {})
    ).json()) as {
      projects?: Array<{ id?: string; _id?: string; name: string }>;
    };
    if (!Array.isArray(data.projects))
      throw new AdapterError(
        "UNSUPPORTED_SERVER",
        "Unexpected project-list response",
      );
    return data.projects
      .map((p) => ({ id: p.id ?? p._id ?? "", name: p.name }))
      .filter((p) => this.config.allowedProjectIds.includes(p.id));
  }
  private assertProject(id: string) {
    if (
      !/^[a-f0-9]{24}$/.test(id) ||
      !this.config.allowedProjectIds.includes(id)
    )
      throw new AdapterError(
        "PROJECT_NOT_ALLOWED",
        "Project is outside this client configuration",
      );
  }
  async compile(projectId: string) {
    this.assertProject(projectId);
    return (
      await this.request(`/project/${projectId}/compile`, "POST", {
        check: "silent",
        draft: false,
        incrementalCompilesEnabled: false,
        stopOnFirstError: false,
      })
    ).json();
  }
  async artifact(projectId: string, path: string): Promise<Uint8Array> {
    this.assertProject(projectId);
    const url = new URL(path, this.origin);
    if (
      url.origin !== this.origin ||
      (!url.pathname.startsWith(`/project/${projectId}/`) &&
        !url.pathname.startsWith(`/download/project/${projectId}/`))
    )
      throw new AdapterError(
        "INVALID_ARTIFACT",
        "Artifact must belong to the allowed project on this server",
      );
    return new Uint8Array(
      await (await this.request(url.pathname + url.search)).arrayBuffer(),
    );
  }
}
