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
  read: "Read",
  edit: "Edit",
  compile: "Compile",
};

export default function AgentPage() {
  useThemedPage();
  const { isReady } = useWaitForI18n();
  return (
    <div className="container">
      <OLRow>
        <OLCol xl={{ span: 10, offset: 1 }}>
          <OLPageContentCard>
            {isReady ? <AgentSettings /> : <p role="status">Loading…</p>}
          </OLPageContentCard>
        </OLCol>
      </OLRow>
    </div>
  );
}

export function AgentSettings({
  projectId,
  embedded = false,
}: { projectId?: string; embedded?: boolean } = {}) {
  const [requestedProject] = useState(
    () =>
      projectId ?? new URLSearchParams(window.location.search).get("project"),
  );
  const [state, setState] = useState<State | null>(null);
  const [name, setName] = useState("My Agent");
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
          ? "Your session has expired. Sign in to Overleaf again."
          : getUserFacingMessage(
              error instanceof Error
                ? error
                : new Error("The request failed. Please try again later."),
            ) || "The request failed. Please try again later.",
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
      text: "Link created. Copy it to the MCP settings in your agent client.",
    });
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || invalidProject || !state) return;
    if (limited && !selected.length) {
      setNotice({ type: "error", text: "Select at least one project." });
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
        setNotice({
          type: "success",
          text: `${grant.name} has been disabled.`,
        });
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
        text: "Copied. Paste it into the MCP settings in your agent client.",
      });
    } catch {
      setReveal(true);
      setNotice({
        type: "info",
        text: "The browser blocked automatic copying. Select and copy the link manually.",
      });
      urlInput.current?.focus();
      urlInput.current?.select();
    }
  }

  return (
    <>
      {!embedded && (
        <div className="page-header">
          <div className="d-flex flex-wrap align-items-center justify-content-between gap-3">
            <h1>My Agent</h1>
            <div className="agent-theme-toggle">
              <ThemeToggle />
            </div>
          </div>
          <p>
            Manage MCP connections so your agent can collaborate on LaTeX using
            your account.
          </p>
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
              Back to {project.name}
            </OLButton>
          )}
        </div>
      )}
      {invalidProject && (
        <Notification
          type="error"
          content="This project no longer exists or is no longer accessible. Return to your project list and select another project."
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
          <h3>Connect my agent</h3>
          {project && (
            <p>
              Current project: <strong>{project.name}</strong>
            </p>
          )}
          <form id="create" onSubmit={create}>
            <fieldset disabled={busy || !state || invalidProject}>
              <OLFormGroup controlId="name">
                <OLFormLabel>Connection name</OLFormLabel>
                <OLFormControl
                  value={name}
                  maxLength={60}
                  required
                  onChange={(e) => setName(e.target.value)}
                />
              </OLFormGroup>
              <OLFormGroup>
                <fieldset>
                  <legend className="h6">Project scope</legend>
                  <OLFormCheckbox
                    id="scope-all"
                    type="radio"
                    name="scope"
                    label="All projects I can access"
                    checked={!limited}
                    onChange={() => setLimited(false)}
                  />
                  <OLFormCheckbox
                    id="limited"
                    type="radio"
                    name="scope"
                    label="Selected projects only"
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
                        <p className="small mb-0">No accessible projects.</p>
                      )}
                    </div>
                  )}
                </fieldset>
              </OLFormGroup>
              <OLFormGroup>
                <fieldset>
                  <legend className="h6">Permissions</legend>
                  <OLFormCheckbox
                    id="read"
                    label="Read projects (required)"
                    checked
                    disabled
                  />
                  <OLFormCheckbox
                    id="edit"
                    label="Edit, create and delete files"
                    checked={edit}
                    onChange={(e) => setEdit(e.target.checked)}
                  />
                  <OLFormCheckbox
                    id="compile"
                    label="Compile projects"
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
                  Generate personal link
                </OLButton>
              </OLFormGroup>
            </fieldset>
          </form>
        </OLCol>
        <OLCol lg={{ span: 5, offset: 1 }}>
          <h3>How to connect</h3>
          <ol className="ps-3">
            <li className="mb-2">
              Name the connection, then choose its projects and permissions.
            </li>
            <li className="mb-2">
              Generate a personal link and paste it into the HTTP MCP URL field
              in your agent client.
            </li>
            <li className="mb-2">
              Ask your agent to open a project, then edit and compile.
            </li>
          </ol>
          <p className="small">
            Agent edits appear in the editor and are labeled Your agent in
            History. Connection permissions follow changes to your project
            access.
          </p>
          <p className="small">
            The full link is shown only when generated. Save it in your client
            settings. Regenerating a link immediately invalidates the previous
            one.
          </p>
        </OLCol>
      </OLRow>
      {created && (
        <section id="created" aria-labelledby="created-title" className="my-3">
          <h3 id="created-title">Your MCP link</h3>
          <OLFormGroup controlId="url">
            <OLFormLabel>Personal MCP URL</OLFormLabel>
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
                Copy link
              </OLButton>
            </div>
          </OLFormGroup>
          <OLFormCheckbox
            id="reveal"
            label="Show full link"
            checked={reveal}
            onChange={(e) => setReveal(e.target.checked)}
          />
          <OLButton variant="link" onClick={() => setCreated(null)}>
            Saved, hide link
          </OLButton>
        </section>
      )}
      <hr />
      <section aria-labelledby="connections-title">
        <div className="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
          <h3 id="connections-title" className="mb-0">
            My connections
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
            Refresh status
          </OLButton>
        </div>
        <OLFormCheckbox
          id="show-revoked"
          label="Show disabled connections"
          checked={showRevoked}
          onChange={(e) => setShowRevoked(e.target.checked)}
        />
        {!state ? (
          <p role="status">Loading connections…</p>
        ) : visibleGrants.length ? (
          <div className="table-responsive" id="links">
            <Table className="align-middle" style={{ minWidth: "38rem" }}>
              <thead>
                <tr>
                  <th>Connection</th>
                  <th>Access scope</th>
                  <th>Last used</th>
                  <th>Actions</th>
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
                            ? "Disabled"
                            : grant.lastUsedAt
                              ? "Used"
                              : "Awaiting first connection"}
                        </OLBadge>
                      </div>
                    </td>
                    <td>
                      <div>
                        {grant.projects === null
                          ? "All projects I can access"
                          : grant.projects
                              .map(
                                (id) =>
                                  state.projects.find((p) => p.id === id)
                                    ?.name || "Inaccessible project",
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
                        : "Not used yet"}
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
                            Regenerate
                          </OLButton>
                          <OLButton
                            variant="danger-ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              void changeLink(grant, "revoke");
                            }}
                          >
                            Disable
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
            No active connections. Generate a new link, or show disabled
            connections.
          </p>
        )}
        <p className="small">
          Disabling a connection blocks future agent requests. Edits already
          submitted are preserved.
        </p>
      </section>
    </>
  );
}
