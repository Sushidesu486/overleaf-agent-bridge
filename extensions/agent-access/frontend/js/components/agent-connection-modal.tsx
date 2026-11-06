import { useState } from "react";
import { Tab, TabContainer, TabContent, Nav, NavLink } from "react-bootstrap";
import {
  OLModal,
  OLModalHeader,
  OLModalTitle,
  OLModalBody,
} from "@/shared/components/ol/ol-modal";
import OLButton from "@/shared/components/ol/ol-button";
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
  refresh,
}: {
  projectId: string;
  projectName: string;
  connections: PublicConnection[];
  onHide: () => void;
  refresh: () => void;
}) {
  const [name, setName] = useState("我的 Agent");
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
      setError("生成配对码失败，请检查登录状态后重试。");
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
      setError("停用失败，请重试。");
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
        <OLModalTitle>连接我的 Agent</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        <p>
          当前项目：<strong>{projectName}</strong>
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
              侧栏聊天
            </NavLink>
            <NavLink
              as="button"
              eventKey="mcp"
              className="ide-settings-tab-link ide-settings-tab-link-button"
            >
              个人 MCP 链接
            </NavLink>
          </Nav>
          <TabContent>
            <Tab.Pane eventKey="chat">
              <p>在自己的设备上运行连接器，继续使用自己的 Agent 和模型账号。</p>
              {error && <Notification type="error" content={error} />}
              <fieldset disabled={busy}>
                <OLFormGroup controlId="chat-connection-name">
                  <OLFormLabel>连接名称</OLFormLabel>
                  <OLFormControl
                    type="text"
                    value={name}
                    maxLength={60}
                    onChange={(e) => setName(e.target.value)}
                  />
                </OLFormGroup>
                <p className="small">
                  默认只授权当前项目；读取项目为必需权限。
                </p>
                <OLFormCheckbox
                  id="chat-edit"
                  label="允许编辑文档"
                  checked={edit}
                  onChange={(e) => setEdit(e.target.checked)}
                />
                <OLFormCheckbox
                  id="chat-compile"
                  label="允许编译项目"
                  checked={compile}
                  onChange={(e) => setCompile(e.target.checked)}
                />
                <OLButton
                  className="mt-3"
                  variant="primary"
                  disabled={!name.trim()}
                  onClick={pair}
                >
                  生成配对码
                </OLButton>
              </fieldset>
              {pairing && (
                <div className="agent-pairing mt-3 p-3 border rounded">
                  <OLButton
                    href="/user/agent/connector"
                    download
                    variant="secondary"
                  >
                    下载连接器
                  </OLButton>
                  <p className="mt-3">
                    下载后，在文件所在目录运行（需要 Node.js 20.19+）：
                  </p>
                  <pre className="agent-command">
                    <code>
                      node overleaf-agent-connector.mjs --server{" "}
                      {pairing.server} --pair
                    </code>
                  </pre>
                  <p className="small">
                    按终端提示粘贴下面的配对码。10
                    分钟内有效，只能使用一次。默认启动 OpenCode；其他 ACP Agent
                    可通过启动参数选择。
                  </p>
                  <OLFormGroup controlId="agent-pair-code">
                    <OLFormLabel>一次性配对码</OLFormLabel>
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
                        setError("自动复制失败，请选中配对码手动复制。");
                      }
                    }}
                  >
                    {copied ? "已复制" : "复制配对码"}
                  </OLButton>
                </div>
              )}
              <h4 className="mt-4">此项目的连接</h4>
              {connections.filter((c) => !c.revoked).length ? (
                connections
                  .filter((c) => !c.revoked)
                  .map((c) => (
                    <div
                      key={c.id}
                      className="d-flex align-items-center justify-content-between gap-3 border-bottom py-2"
                    >
                      <div>
                        <strong>{c.name}</strong>
                        <div className="small">
                          {c.runtime} · {c.online ? "在线" : "离线"}
                        </div>
                      </div>
                      <OLButton
                        variant="danger-ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => revoke(c.id)}
                      >
                        停用
                      </OLButton>
                    </div>
                  ))
              ) : (
                <p>暂时没有连接。完成终端配对后，在线状态会自动更新。</p>
              )}
              <p className="small mt-3">
                停用会撤销此连接的 MCP 授权，并停止接收新的任务。
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
