import { useEffect, useState } from "react";
import getMeta from "@/utils/meta";
import { useProjectContext } from "@/shared/context/project-context";
import IntegrationCard from "@/features/integrations-panel/integration-card";
import MaterialIcon from "@/shared/components/material-icon";
import OLButton from "@/shared/components/ol/ol-button";
import OLFormControl from "@/shared/components/ol/ol-form-control";
import OLFormSelect from "@/shared/components/ol/ol-form-select";
import OLFormGroup from "@/shared/components/ol/ol-form-group";
import OLFormLabel from "@/shared/components/ol/ol-form-label";
import Notification from "@/shared/components/notification";
import {
  OLModal,
  OLModalHeader,
  OLModalTitle,
  OLModalBody,
  OLModalFooter,
} from "@/shared/components/ol/ol-modal";
import {
  getJSON,
  postJSON,
  getUserFacingMessage,
} from "@/infrastructure/fetch-json";

type Grant = {
  id: string;
  name: string;
  mode: "read" | "write";
  actor: "human" | "agent";
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
};
type State = {
  enabled: boolean;
  pushEnabled: boolean;
  role: string;
  cloneUrl: string;
  grants: Grant[];
};

function GitDialog({
  projectId,
  onHide,
}: {
  projectId: string;
  onHide: () => void;
}) {
  const base = `/user/git/projects/${projectId}`;
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [name, setName] = useState("My laptop"),
    [actor, setActor] = useState("human"),
    [mode, setMode] = useState("read");
  const [token, setToken] = useState<{ id: string; token: string } | null>(
    null,
  );
  const [copied, setCopied] = useState("");
  async function refresh() {
    setState(await getJSON<State>(base, { cache: "no-store" }));
  }
  function failure(error: unknown) {
    setError(
      getUserFacingMessage(
        error instanceof Error
          ? error
          : new Error("Git access is unavailable."),
      ) || "Git access is unavailable.",
    );
  }
  useEffect(() => {
    void refresh().catch(failure);
  }, [projectId]);
  async function action(path: string, body?: object) {
    if (busy) return;
    setBusy(true);
    setError("");
    setCopied("");
    try {
      const result = await postJSON<{ id: string; token: string }>(
        `${base}/${path}`,
        { body },
      );
      if (path === "tokens") setToken(result);
      if (path.includes(token?.id ?? "!")) setToken(null);
      await refresh();
    } catch (error) {
      failure(error);
    } finally {
      setBusy(false);
    }
  }
  async function copy(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
    } catch {
      setError("Select the text and copy it manually.");
    }
  }
  const cloneUrl = state?.cloneUrl.replace("://", "://git@");
  const command = cloneUrl
    ? `git clone --origin overleaf -c credential.useHttpPath=true ${cloneUrl}`
    : "";
  return (
    <OLModal
      show
      onHide={onHide}
      themed
      size="lg"
      className="git-access-modal"
      scrollable
    >
      <OLModalHeader>
        <OLModalTitle>Git access</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        {error && <Notification type="error" content={error} />}
        {!state ? (
          <p>Loading Git settings…</p>
        ) : (
          <>
            {!state.pushEnabled && (
              <Notification
                type="info"
                content="Read-only preview: clone and pull are available. Push is still under development."
              />
            )}
            <p>
              Use your local editor or agent with this project's{" "}
              <code>main</code> branch. Your existing account and project
              permissions apply.
            </p>
            {!state.enabled ? (
              <>
                <p>Git access is disabled for this project.</p>
                {state.role === "owner" ? (
                  <OLButton
                    disabled={busy}
                    onClick={() => void action("enabled", { enabled: true })}
                  >
                    Enable Git access
                  </OLButton>
                ) : (
                  <p>Ask the project owner to enable Git access.</p>
                )}
              </>
            ) : (
              <>
                <OLFormGroup controlId="git-clone-command">
                  <OLFormLabel>Clone command</OLFormLabel>
                  <OLFormControl
                    type="text"
                    readOnly
                    value={command}
                    onFocus={(e) => e.target.select()}
                  />
                </OLFormGroup>
                <OLButton
                  variant="secondary"
                  onClick={() => void copy(command, "command")}
                >
                  {copied === "command" ? "Copied" : "Copy clone command"}
                </OLButton>
                <p className="mt-3">
                  Use <code>git</code> as the username and a Git token as the
                  password. Save it in your system's Git credential manager.
                </p>
                <fieldset disabled={busy}>
                  <OLFormGroup controlId="git-token-name">
                    <OLFormLabel>Token name</OLFormLabel>
                    <OLFormControl
                      type="text"
                      value={name}
                      maxLength={80}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </OLFormGroup>
                  <OLFormGroup controlId="git-token-actor">
                    <OLFormLabel>Client</OLFormLabel>
                    <OLFormSelect
                      value={actor}
                      onChange={(e) => setActor(e.target.value)}
                    >
                      <option value="human">My Git client</option>
                      <option value="agent">My agent</option>
                    </OLFormSelect>
                  </OLFormGroup>
                  <OLFormGroup controlId="git-token-mode">
                    <OLFormLabel>Access</OLFormLabel>
                    <OLFormSelect
                      value={mode}
                      onChange={(e) => setMode(e.target.value)}
                    >
                      <option value="read">Read only</option>
                      {state.pushEnabled && state.role !== "readOnly" && (
                        <option value="write">Read and write</option>
                      )}
                    </OLFormSelect>
                  </OLFormGroup>
                  <OLButton
                    disabled={!name.trim()}
                    onClick={() => void action("tokens", { name, actor, mode })}
                  >
                    Create Git token
                  </OLButton>
                </fieldset>
                {token && (
                  <div className="mt-3">
                    <Notification
                      type="info"
                      content="Copy this token now. It is only shown once and expires in 90 days."
                    />
                    <OLFormGroup controlId="git-new-token">
                      <OLFormLabel>New Git token</OLFormLabel>
                      <OLFormControl
                        type="text"
                        readOnly
                        value={token.token}
                        autoComplete="off"
                        onFocus={(e) => e.target.select()}
                      />
                    </OLFormGroup>
                    <OLButton
                      variant="secondary"
                      onClick={() => void copy(token.token, "token")}
                    >
                      {copied === "token" ? "Copied" : "Copy token"}
                    </OLButton>
                  </div>
                )}
              </>
            )}
            <h3 className="mt-4">Your project tokens</h3>
            {state.grants.filter((g) => !g.revokedAt).length === 0 && (
              <p>No active Git tokens.</p>
            )}
            {state.grants
              .filter((g) => !g.revokedAt)
              .map((g) => (
                <div key={g.id} className="mb-3">
                  <strong>{g.name}</strong> ·{" "}
                  {g.actor === "agent" ? "Agent" : "Git client"} ·{" "}
                  {g.mode === "write" ? "Read and write" : "Read only"}
                  <div className="small">
                    Expires {new Date(g.expiresAt).toLocaleDateString()} · Last
                    used{" "}
                    {g.lastUsedAt
                      ? new Date(g.lastUsedAt).toLocaleString()
                      : "Never"}
                  </div>
                  <OLButton
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void action(`tokens/${g.id}/revoke`)}
                  >
                    Revoke
                  </OLButton>
                </div>
              ))}
            {state.enabled && state.role === "owner" && (
              <OLButton
                variant="secondary"
                disabled={busy}
                onClick={() => void action("enabled", { enabled: false })}
              >
                Disable project Git access
              </OLButton>
            )}
          </>
        )}
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={onHide}>
          Close
        </OLButton>
      </OLModalFooter>
    </OLModal>
  );
}

export default function GitIntegration() {
  const { projectId } = useProjectContext();
  const [open, setOpen] = useState(false);
  if (!getMeta("ol-gitBridgeEnabled") || getMeta("ol-anonymous")) return null;
  return (
    <>
      <IntegrationCard
        title="Git"
        description="Work locally with Git and your own agent."
        icon={<MaterialIcon type="account_tree" />}
        showPaywallBadge={false}
        onClick={() => setOpen(true)}
      />
      {open && (
        <GitDialog projectId={projectId} onHide={() => setOpen(false)} />
      )}
    </>
  );
}
