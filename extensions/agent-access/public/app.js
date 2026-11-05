const $ = (id) => document.getElementById(id);
const csrf = document.querySelector('meta[name="csrf-token"]').content;
function message(text) {
  $("message").textContent = text;
}
async function request(path, body) {
  const response = await fetch(`/user/agent/${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401)
    throw new Error("登录已过期，请重新登录 Overleaf。");
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "请求失败，请稍后重试。");
  return data;
}
function element(tag, text, className) {
  const el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  return el;
}
async function refresh() {
  const state = await request("state");
  $("identity").textContent = state.user.name;
  const selections = new Set(
    [...$("projects").querySelectorAll("input:checked")].map((i) => i.value),
  );
  $("projects").replaceChildren(
    ...state.projects.map((p) => {
      const label = element("label", "");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = p.id;
      input.checked = selections.has(p.id);
      label.append(input, document.createTextNode(p.name));
      return label;
    }),
  );
  $("links").replaceChildren();
  if (!state.grants.length)
    $("links").append(
      element("p", "还没有连接。生成第一条链接即可开始。", "muted"),
    );
  for (const grant of state.grants) {
    const row = element("div", "", "connection");
    const info = element("div", "", "connection-info");
    info.append(
      element("strong", grant.name),
      element(
        "span",
        grant.revokedAt
          ? "已停用"
          : grant.lastUsedAt
            ? "已使用"
            : "等待首次连接",
        grant.revokedAt ? "badge muted" : "badge",
      ),
    );
    info.append(
      element(
        "p",
        `${grant.projects === null ? "全部本人可访问项目" : `${grant.projects.length} 个指定项目`} · ${grant.actions.map((a) => ({ read: "读取", edit: "编辑", compile: "编译" })[a]).join("、")}`,
        "muted",
      ),
    );
    info.append(
      element(
        "p",
        grant.lastUsedAt
          ? `最近使用：${new Date(grant.lastUsedAt).toLocaleString()}`
          : "尚无使用记录",
        "muted",
      ),
    );
    row.append(info);
    if (!grant.revokedAt)
      for (const [action, label] of [
        ["rotate", "重新生成"],
        ["revoke", "停用"],
      ]) {
        const button = element("button", label, "secondary");
        button.type = "button";
        button.addEventListener("click", async () => {
          button.disabled = true;
          try {
            const data = await request(`links/${grant.id}/${action}`, {});
            if (data.url) showLink(data.url);
            else {
              $("created").hidden = true;
              $("url").value = "";
              message("连接已停用。");
            }
            await refresh();
          } catch (e) {
            message(e.message);
          } finally {
            button.disabled = false;
          }
        });
        row.append(button);
      }
    $("links").append(row);
  }
}
function showLink(url) {
  $("created").hidden = false;
  $("url").value = url;
  $("url").type = "password";
  $("reveal").checked = false;
  message("新链接已准备好，请复制到客户端。");
  $("created").scrollIntoView({ behavior: "smooth", block: "nearest" });
}
$("limited").addEventListener("change", () => {
  $("projects").hidden = !$("limited").checked;
});
$("reveal").addEventListener("change", () => {
  $("url").type = $("reveal").checked ? "text" : "password";
});
$("create").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("generate").disabled = true;
  try {
    const projects = $("limited").checked
      ? [...$("projects").querySelectorAll("input:checked")].map((i) => i.value)
      : null;
    const actions = ["read"];
    if ($("edit").checked) actions.push("edit");
    if ($("compile").checked) actions.push("compile");
    const data = await request("links", {
      name: $("name").value,
      projects,
      actions,
    });
    showLink(data.url);
    await refresh();
  } catch (error) {
    message(error.message);
  } finally {
    $("generate").disabled = false;
  }
});
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("url").value);
    message("已复制，打开客户端的 MCP 设置粘贴即可。");
  } catch {
    $("url").type = "text";
    $("reveal").checked = true;
    $("url").select();
    message("请手动复制选中的链接。");
  }
});
$("refresh").addEventListener("click", () =>
  refresh().catch((e) => message(e.message)),
);
refresh().catch((e) => message(e.message));
