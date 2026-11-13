import { useEffect, useRef, useState } from "react";
import { Tab, TabContainer, TabContent, Nav, NavLink } from "react-bootstrap";
import {
  OLModal,
  OLModalHeader,
  OLModalTitle,
  OLModalBody,
} from "@/shared/components/ol/ol-modal";
import OLButton from "@/shared/components/ol/ol-button";
import OLFormSelect from "@/shared/components/ol/ol-form-select";
import { runtimes, type RuntimeId } from "../../../shared/runtimes";
import OLFormControl from "@/shared/components/ol/ol-form-control";
import OLFormGroup from "@/shared/components/ol/ol-form-group";
import OLFormLabel from "@/shared/components/ol/ol-form-label";
import OLFormCheckbox from "@/shared/components/ol/ol-form-checkbox";
import Notification from "@/shared/components/notification";
import { postJSON } from "@/infrastructure/fetch-json";
import { AgentSettings } from "./agent-page";
import type { PublicConnection } from "../../../shared/chat";
export default function AgentConnectionModal({
  projectId,
  projectName,
  connections,
  onHide,
  onConnected,
  refresh,
}: {
  projectId: string;
  projectName: string;
  connections: PublicConnection[];
  onHide: () => void;
  onConnected: (id: string) => void;
  refresh: () => void;
}) {
  const [runtime, setRuntime] = useState<RuntimeId>("codex");
  const [name, setName] = useState("My Agent");
  const [edit, setEdit] = useState(true),
    [compile, setCompile] = useState(true);
  const [pairing, setPairing] = useState<{
    code: string;
    server: string;
    expiresAt: string;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const selectedPairing = useRef("");
  const pairedConnection =
    pairing &&
    connections.find(
      (c) =>
        c.pairingId === pairing.code.split(".")[0] &&
        c.availableInProject !== false &&
        c.online &&
        !c.revoked,
    );
  useEffect(() => {
    if (pairedConnection && selectedPairing.current !== pairedConnection.id) {
      selectedPairing.current = pairedConnection.id;
      onConnected(pairedConnection.id);
    }
  }, [pairedConnection, onConnected]);
  const projectConnections = connections.filter(
    (c) => c.availableInProject !== false && !c.revoked,
  );
  const elsewhere = connections.filter(
    (c) => c.availableInProject === false && c.online && !c.revoked,
  );
  async function pair() {
    setBusy(true);
    setError("");
    try {
      setPairing(
        await postJSON("/user/agent/chat/pairings", {
          body: {
            name,
            projects: [projectId],
            actions: [
              "read",
              ...(edit ? ["edit"] : []),
              ...(compile ? ["compile"] : []),
            ],
          },
        }),
      );
      setCopied(false);
    } catch {
      setError(
        "Unable to generate a pairing code. Check that you are signed in and try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    setError("");
    try {
      await postJSON(`/user/agent/chat/connections/${id}/revoke`);
      refresh();
    } catch {
      setError("Unable to disable the connection. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <OLModal
      show
      onHide={onHide}
      themed
      size="lg"
      className="agent-connect-modal"
    >
      <OLModalHeader>
        <OLModalTitle>Connect my agent</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        <p>
          Current project: <strong>{projectName}</strong>
        </p>
        <TabContainer
          defaultActiveKey="chat"
          id="agent-connect-tabs"
          transition={false}
        >
          <Nav className="d-flex flex-row gap-2 mb-3">
            <NavLink
              as="button"
              eventKey="chat"
              className="ide-settings-tab-link ide-settings-tab-link-button"
            >
              Sidebar chat
            </NavLink>
            <NavLink
              as="button"
              eventKey="mcp"
              className="ide-settings-tab-link ide-settings-tab-link-button"
            >
              Personal MCP links
            </NavLink>
          </Nav>
          <TabContent>
            <Tab.Pane eventKey="chat">
              <p>
                Run the connector on your device to use your own agent and model
                account.
              </p>
              {error && <Notification type="error" content={error} />}
              <fieldset disabled={busy}>
                <OLFormGroup controlId="chat-runtime">
                  <OLFormLabel>Agent runtime</OLFormLabel>
                  <OLFormSelect
                    value={runtime}
                    onChange={(e) => setRuntime(e.target.value as RuntimeId)}
                  >
                    {Object.entries(runtimes).map(([id, item]) => (
                      <option key={id} value={id}>
                        {item.label}
                      </option>
                    ))}
                  </OLFormSelect>
                </OLFormGroup>
                <p className="small">
                  {runtimes[runtime].login} Your model credentials stay on your
                  device.
                </p>
                <OLFormGroup controlId="chat-connection-name">
                  <OLFormLabel>Connection name</OLFormLabel>
                  <OLFormControl
                    type="text"
                    value={name}
                    maxLength={60}
                    onChange={(e) => setName(e.target.value)}
                  />
                </OLFormGroup>
                <p className="small">
                  Only the current project is authorized by default. Read access
                  is required.
                </p>
                <OLFormCheckbox
                  id="chat-edit"
                  label="Allow document editing"
                  checked={edit}
                  onChange={(e) => setEdit(e.target.checked)}
                />
                <OLFormCheckbox
                  id="chat-compile"
                  label="Allow compilation"
                  checked={compile}
                  onChange={(e) => setCompile(e.target.checked)}
                />
                <OLButton
                  className="mt-3"
                  variant="primary"
                  disabled={!name.trim()}
                  onClick={pair}
                >
                  Generate pairing code
                </OLButton>
              </fieldset>
              {pairedConnection && (
                <Notification
                  type="success"
                  content="Connected. Start a new conversation, or select this agent for an existing conversation."
                />
              )}
              {pairing && !pairedConnection && (
                <div className="agent-pairing mt-3 p-3 border rounded">
                  <OLButton
                    href="/user/agent/connector"
                    download
                    variant="secondary"
                  >
                    Download connector
                  </OLButton>
                  <p className="mt-3">
                    After downloading, run this command in the same directory
                    (Node.js 22+ required):
                  </p>
                  <pre className="agent-command">
                    <code>
                      node overleaf-agent-connector.mjs --server{" "}
                      {pairing.server} --runtime {runtime} --pair
                    </code>
                  </pre>
                  <p className="small">
                    Paste the pairing code below when prompted. It expires in 10
                    minutes and can be used once. A pinned adapter is downloaded
                    on first launch. The first message creates a session; later
                    messages reuse it.
                  </p>
                  <OLFormGroup controlId="agent-pair-code">
                    <OLFormLabel>One-time pairing code</OLFormLabel>
                    <OLFormControl
                      type="password"
                      readOnly
                      value={pairing.code}
                    />
                  </OLFormGroup>
                  <OLButton
                    variant="secondary"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(pairing.code);
                        setCopied(true);
                      } catch {
                        setError(
                          "Automatic copying failed. Select and copy the pairing code manually.",
                        );
                      }
                    }}
                  >
                    {copied ? "Copied" : "Copy pairing code"}
                  </OLButton>
                </div>
              )}
              <h4 className="mt-4">Connections for this project</h4>
              {projectConnections.length ? (
                projectConnections.map((c) => (
                  <div
                    key={c.id}
                    className="d-flex align-items-center justify-content-between gap-3 border-bottom py-2"
                  >
                    <div>
                      <strong>{c.name}</strong>
                      <div className="small">
                        {c.runtime} · {c.online ? "Online" : "Offline"}
                      </div>
                    </div>
                    <div className="d-flex gap-2">
                      <OLButton
                        variant="secondary"
                        size="sm"
                        disabled={busy || !c.online}
                        onClick={() => onConnected(c.id)}
                      >
                        Select this agent
                      </OLButton>
                      <OLButton
                        variant="danger-ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => revoke(c.id)}
                      >
                        Disable
                      </OLButton>
                    </div>
                  </div>
                ))
              ) : (
                <p>
                  No connections yet. Status updates automatically after pairing
                  in the terminal.
                </p>
              )}
              {elsewhere.length > 0 && (
                <p className="small" role="status">
                  A local connection is online for other projects:
                  {elsewhere
                    .map((c) => c.projectNames?.join("、") || c.name)
                    .join("; ")}
                  . Use the pairing code above to connect this project.
                </p>
              )}
              <p className="small mt-3">
                Disabling a connection revokes its MCP access and stops new
                tasks.
              </p>
            </Tab.Pane>
            <Tab.Pane eventKey="mcp">
              <AgentSettings projectId={projectId} embedded />
            </Tab.Pane>
          </TabContent>
        </TabContainer>
      </OLModalBody>
    </OLModal>
  );
}
