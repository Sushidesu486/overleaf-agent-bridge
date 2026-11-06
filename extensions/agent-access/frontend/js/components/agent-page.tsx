import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Table } from "react-bootstrap";
import OLRow from "@/shared/components/ol/ol-row";
import OLCol from "@/shared/components/ol/ol-col";
import OLPageContentCard from "@/shared/components/ol/ol-page-content-card";
import OLButton from "@/shared/components/ol/ol-button";
import OLFormGroup from "@/shared/components/ol/ol-form-group";
import OLFormLabel from "@/shared/components/ol/ol-form-label";
import OLFormControl from "@/shared/components/ol/ol-form-control";
import OLFormCheckbox from "@/shared/components/ol/ol-form-checkbox";
import OLBadge from "@/shared/components/ol/ol-badge";
import Notification from "@/shared/components/notification";
import useWaitForI18n from "@/shared/hooks/use-wait-for-i18n";
import useThemedPage from "@/shared/hooks/use-themed-page";
import ThemeToggle from "@/features/project-list/components/sidebar/theme-toggle";
import {
  getJSON,
  postJSON,
  getUserFacingMessage,
  FetchError,
} from "@/infrastructure/fetch-json";

type Project = { id: string; name: string };
type Grant = {
  id: string;
  name: string;
  projects: string[] | null;
  actions: string[];
  revokedAt: string | null;
  lastUsedAt: string | null;
};
type State = {
  user: { name: string; email: string };
  projects: Project[];
  grants: Grant[];
};
type Notice = { type: "success" | "error" | "info"; text: string };
const actionNames: Record<string, string> = {
  read: "读取",
  edit: "编辑",
  compile: "编译",
};

export default function AgentPage() {
  useThemedPage();
  const { isReady } = useWaitForI18n();
  return (
    <div className="container">
      <OLRow>
        <OLCol xl={{ span: 10, offset: 1 }}>
          <OLPageContentCard>
            {isReady ? <AgentSettings /> : <p role="status">正在加载…</p>}
          </OLPageContentCard>
        </OLCol>
      </OLRow>
    </div>
  );
}

function AgentSettings() {
  const [requestedProject] = useState(() =>
    new URLSearchParams(window.location.search).get("project"),
  );
  const [state, setState] = useState<State | null>(null);
  const [name, setName] = useState("我的 Agent");
  const [limited, setLimited] = useState(Boolean(requestedProject));
  const [selected, setSelected] = useState<string[]>(
    requestedProject ? [requestedProject] : [],
  );
  const [edit, setEdit] = useState(true);
  const [compile, setCompile] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [created, setCreated] = useState<{
    url: string;
    grantId: string;
  } | null>(null);
  const [reveal, setReveal] = useState(false);
  const [showRevoked, setShowRevoked] = useState(false);
  const visibleGrants =
    state?.grants.filter((grant) => showRevoked || !grant.revokedAt) ?? [];
  const urlInput = useRef<HTMLInputElement>(null);
  const project = state?.projects.find((p) => p.id === requestedProject);
  const invalidProject = Boolean(state && requestedProject && !project);

  const showError = useCallback((error: unknown) => {
    setNotice({
      type: "error",
      text:
        error instanceof FetchError && error.response?.status === 401
          ? "登录已过期，请重新登录 Overleaf。"
          : getUserFacingMessage(
              error instanceof Error
                ? error
                : new Error("请求失败，请稍后重试。"),
            ) || "请求失败，请稍后重试。",
    });
  }, []);
  const refresh = useCallback(async () => {
    const data = await getJSON<State>("/user/agent/state", {
      cache: "no-store",
    });
    setState(data);
    setSelected((previous) =>
      previous.filter((id) => data.projects.some((p) => p.id === id)),
    );
  }, []);
  useEffect(() => {
    void refresh().catch(showError);
  }, [refresh, showError]);

  function showLink(url: string, grantId: string) {
    setCreated({ url, grantId });
    setReveal(false);
    setNotice({
      type: "success",
      text: "链接已生成，请复制到 Agent 客户端的 MCP 设置。",
    });
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || invalidProject || !state) return;
    if (limited && !selected.length) {
      setNotice({ type: "error", text: "请至少选择一个项目。" });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const data = await postJSON<{ url: string; grant: Grant }>(
        "/user/agent/links",
        {
          body: {
            name,
            projects: limited ? selected : null,
            actions: [
              "read",
              ...(edit ? ["edit"] : []),
              ...(compile ? ["compile"] : []),
            ],
          },
        },
      );
      showLink(data.url, data.grant.id);
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }
  async function changeLink(grant: Grant, action: "rotate" | "revoke") {
    setBusy(true);
    setNotice(null);
    try {
      const data = await postJSON<{ url?: string }>(
        `/user/agent/links/${grant.id}/${action}`,
        { body: {} },
      );
      if (data.url) showLink(data.url, grant.id);
      else {
        if (created?.grantId === grant.id) setCreated(null);
        setNotice({ type: "success", text: `“${grant.name}”已停用。` });
      }
      await refresh();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  }
  async function copyLink() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setNotice({
        type: "success",
        text: "已复制，粘贴到 Agent 客户端的 MCP 设置即可。",
      });
    } catch {
      setReveal(true);
      setNotice({
        type: "info",
        text: "浏览器未允许自动复制，请选中链接手动复制。",
      });
      urlInput.current?.focus();
      urlInput.current?.select();
    }
  }

  return (
    <>
      <div className="page-header">
        <div className="d-flex flex-wrap align-items-center justify-content-between gap-3">
          <h1>我的 Agent</h1>
          <div className="agent-theme-toggle">
            <ThemeToggle />
          </div>
        </div>
        <p>管理你的 MCP 连接，让 Agent 使用你的账号协作编辑 LaTeX。</p>
        {state && (
          <p className="small" id="identity">
            {state.user.name} · {state.user.email}
          </p>
        )}
        {project && (
          <OLButton
            variant="secondary"
            href={`/project/${project.id}`}
            leadingIcon="arrow_back"
          >
            返回 {project.name}
          </OLButton>
        )}
      </div>
      {invalidProject && (
        <Notification
          type="error"
          content="当前项目不存在或你已失去访问权限。请返回项目列表重新选择。"
        />
      )}
      {notice && (
        <div className="mb-3" id="message">
          <Notification
            type={notice.type}
            content={notice.text}
            ariaLive="polite"
          />
        </div>
      )}
      <OLRow>
        <OLCol lg={5}>
          <h3>连接我的 Agent</h3>
          {project && (
            <p>
              当前项目：<strong>{project.name}</strong>
            </p>
          )}
          <form id="create" onSubmit={create}>
            <fieldset disabled={busy || !state || invalidProject}>
              <OLFormGroup controlId="name">
                <OLFormLabel>连接名称</OLFormLabel>
                <OLFormControl
                  value={name}
                  maxLength={60}
                  required
                  onChange={(e) => setName(e.target.value)}
                />
              </OLFormGroup>
              <OLFormGroup>
                <fieldset>
                  <legend className="h6">项目范围</legend>
                  <OLFormCheckbox
                    id="scope-all"
                    type="radio"
                    name="scope"
                    label="全部本人可访问项目"
                    checked={!limited}
                    onChange={() => setLimited(false)}
                  />
                  <OLFormCheckbox
                    id="limited"
                    type="radio"
                    name="scope"
                    label="仅选中的项目"
                    checked={limited}
                    onChange={() => setLimited(true)}
                  />
                  {limited && (
                    <div
                      id="projects"
                      className="border rounded p-2 mt-2 overflow-auto"
                      style={{ maxHeight: "12rem" }}
                    >
                      {state?.projects.length ? (
                        state.projects.map((p) => (
                          <OLFormCheckbox
                            key={p.id}
                            id={`project-${p.id}`}
                            label={p.name}
                            checked={selected.includes(p.id)}
                            onChange={(e) =>
                              setSelected((old) =>
                                e.target.checked
                                  ? [...old, p.id]
                                  : old.filter((id) => id !== p.id),
                              )
                            }
                          />
                        ))
                      ) : (
                        <p className="small mb-0">暂无可访问的项目。</p>
                      )}
                    </div>
                  )}
                </fieldset>
              </OLFormGroup>
              <OLFormGroup>
                <fieldset>
                  <legend className="h6">允许的操作</legend>
                  <OLFormCheckbox
                    id="read"
                    label="读取项目（必需）"
                    checked
                    disabled
                  />
                  <OLFormCheckbox
                    id="edit"
                    label="编辑文档"
                    checked={edit}
                    onChange={(e) => setEdit(e.target.checked)}
                  />
                  <OLFormCheckbox
                    id="compile"
                    label="编译项目"
                    checked={compile}
                    onChange={(e) => setCompile(e.target.checked)}
                  />
                </fieldset>
              </OLFormGroup>
              <OLFormGroup>
                <OLButton
                  id="generate"
                  type="submit"
                  isLoading={busy}
                  disabled={limited && !selected.length}
                >
                  生成专属链接
                </OLButton>
              </OLFormGroup>
            </fieldset>
          </form>
        </OLCol>
        <OLCol lg={{ span: 5, offset: 1 }}>
          <h3>如何连接</h3>
          <ol className="ps-3">
            <li className="mb-2">填写连接名称，选择项目范围和操作权限。</li>
            <li className="mb-2">
              生成专属链接，复制到 Agent 客户端的 HTTP MCP 地址栏。
            </li>
            <li className="mb-2">让 Agent 打开项目，开始编辑和编译。</li>
          </ol>
          <p className="small">
            Agent 的修改会同步到编辑器，在 History 中显示为 Your
            agent。项目权限变化后，连接权限也会随之更新。
          </p>
          <p className="small">
            完整链接仅在生成时显示，请保存在客户端个人设置中。需要更换时可重新生成，原链接会立即失效。
          </p>
        </OLCol>
      </OLRow>
      {created && (
        <section id="created" aria-labelledby="created-title" className="my-3">
          <h3 id="created-title">你的 MCP 链接</h3>
          <OLFormGroup controlId="url">
            <OLFormLabel>专属 MCP URL</OLFormLabel>
            <div className="d-flex flex-wrap gap-2">
              <OLFormControl
                ref={urlInput}
                type={reveal ? "text" : "password"}
                value={created.url}
                readOnly
                autoComplete="off"
                className="flex-grow-1"
                style={{ flexBasis: "18rem", width: "auto", minWidth: 0 }}
              />
              <OLButton
                id="copy"
                variant="secondary"
                leadingIcon="content_copy"
                onClick={copyLink}
              >
                复制链接
              </OLButton>
            </div>
          </OLFormGroup>
          <OLFormCheckbox
            id="reveal"
            label="显示完整链接"
            checked={reveal}
            onChange={(e) => setReveal(e.target.checked)}
          />
          <OLButton variant="link" onClick={() => setCreated(null)}>
            已保存，关闭显示
          </OLButton>
        </section>
      )}
      <hr />
      <section aria-labelledby="connections-title">
        <div className="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
          <h3 id="connections-title" className="mb-0">
            我的连接
          </h3>
          <OLButton
            id="refresh"
            variant="secondary"
            size="sm"
            disabled={busy}
            leadingIcon="refresh"
            onClick={() => {
              void refresh().catch(showError);
            }}
          >
            刷新状态
          </OLButton>
        </div>
        <OLFormCheckbox
          id="show-revoked"
          label="显示已停用的连接"
          checked={showRevoked}
          onChange={(e) => setShowRevoked(e.target.checked)}
        />
        {!state ? (
          <p role="status">正在加载连接…</p>
        ) : visibleGrants.length ? (
          <div className="table-responsive" id="links">
            <Table className="align-middle" style={{ minWidth: "38rem" }}>
              <thead>
                <tr>
                  <th>连接</th>
                  <th>访问范围</th>
                  <th>最近使用</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleGrants.map((grant) => (
                  <tr key={grant.id} className="connection">
                    <td>
                      <strong className="text-break">{grant.name}</strong>
                      <div className="mt-1">
                        <OLBadge bg={grant.revokedAt ? "secondary" : "info"}>
                          {grant.revokedAt
                            ? "已停用"
                            : grant.lastUsedAt
                              ? "已使用"
                              : "等待首次连接"}
                        </OLBadge>
                      </div>
                    </td>
                    <td>
                      <div>
                        {grant.projects === null
                          ? "全部本人可访问项目"
                          : grant.projects
                              .map(
                                (id) =>
                                  state.projects.find((p) => p.id === id)
                                    ?.name || "已不可访问的项目",
                              )
                              .join("、")}
                      </div>
                      <div className="small">
                        {grant.actions
                          .map((a) => actionNames[a] || a)
                          .join("、")}
                      </div>
                    </td>
                    <td className="small">
                      {grant.lastUsedAt
                        ? new Date(grant.lastUsedAt).toLocaleString()
                        : "尚无使用记录"}
                    </td>
                    <td>
                      {!grant.revokedAt && (
                        <div className="d-flex gap-2 flex-wrap">
                          <OLButton
                            variant="secondary"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              void changeLink(grant, "rotate");
                            }}
                          >
                            重新生成
                          </OLButton>
                          <OLButton
                            variant="danger-ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              void changeLink(grant, "revoke");
                            }}
                          >
                            停用
                          </OLButton>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        ) : (
          <p className="small">
            暂无启用中的连接。生成新链接，或查看已停用的连接。
          </p>
        )}
        <p className="small">
          停用后，Agent 的后续请求将被拒绝，已提交的编辑会保留。
        </p>
      </section>
    </>
  );
}
