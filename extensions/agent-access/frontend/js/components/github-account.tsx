import { useCallback, useEffect, useState } from "react";
import OLButton from "@/shared/components/ol/ol-button";
import OLBadge from "@/shared/components/ol/ol-badge";
import GitHubLogo from "@/shared/svgs/github-logo-black";
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

type State = {
  configured: boolean;
  link: { login: string; linkedAt: string } | null;
  pending: { id: string; login: string; expiresAt: string } | null;
  canonicalSettingsUrl: string | null;
};
const callbackMessages: Record<string, string> = {
  session: "Your session has expired. Sign in and connect GitHub again.",
  expired:
    "This GitHub connection attempt has expired or was already used. Please start again.",
  denied: "GitHub authorization was cancelled. Your account has not changed.",
  rate_limit: "Too many connection attempts. Please try again later.",
};

export default function GitHubAccount() {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [disconnect, setDisconnect] = useState(false);
  const [notice, setNotice] = useState<{
    type: "success" | "error" | "info";
    text: string;
  } | null>(null);
  const refresh = useCallback(async () => {
    setState(await getJSON<State>("/user/github", { cache: "no-store" }));
  }, []);
  const showError = useCallback((error: unknown) => {
    setNotice({
      type: "error",
      text:
        getUserFacingMessage(
          error instanceof Error
            ? error
            : new Error("Unable to update GitHub connection."),
        ) || "Unable to update GitHub connection.",
    });
  }, []);
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("github");
    if (result) {
      setNotice({
        type: result === "denied" ? "info" : "error",
        text:
          callbackMessages[result] ??
          "GitHub connection could not be completed. Please try again.",
      });
      url.searchParams.delete("github");
      window.history.replaceState(window.history.state, "", url);
    }
    void refresh().catch(showError);
  }, [refresh, showError]);

  async function action(name: "start" | "confirm" | "cancel" | "unlink") {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await postJSON<{ url?: string }>(`/user/github/${name}`, {
        body: { candidateId: state?.pending?.id },
      });
      if (name === "start" && result.url) {
        window.location.assign(result.url);
        return;
      }
      setDisconnect(false);
      await refresh();
      setNotice({
        type: "success",
        text:
          name === "confirm"
            ? "GitHub account connected."
            : name === "unlink"
              ? "GitHub account disconnected. Your email login and projects are unchanged."
              : "Connection cancelled.",
      });
    } catch (error) {
      showError(error);
      // A rejected confirmation may have consumed the candidate.
      await refresh().catch(() => {});
    }
    setBusy(false);
  }

  return (
    <section id="github-account" aria-labelledby="github-account-title">
      <h3 id="github-account-title">GitHub account</h3>
      <p>
        Connect your GitHub identity to your existing account. Repository sync
        will be available in a future update.
      </p>
      {notice && <Notification type={notice.type} content={notice.text} />}
      {!state ? (
        <p role="status">
          {notice?.type === "error" ? (
            <OLButton
              variant="secondary"
              onClick={() => void refresh().catch(showError)}
            >
              Retry
            </OLButton>
          ) : (
            "Loading GitHub connection…"
          )}
        </p>
      ) : (
        <>
          <div className="settings-widget-container">
            <div aria-hidden="true">
              <GitHubLogo size={40} />
            </div>
            <div className="description-container">
              <div className="title-row">
                <h4>GitHub</h4>
                <OLBadge
                  bg={state.link ? "success" : "light"}
                  text={state.link ? undefined : "dark"}
                >
                  {state.link ? "Connected" : "Not connected"}
                </OLBadge>
              </div>
              <p className="small">
                {state.link ? (
                  <>
                    Connected as{" "}
                    <a
                      href={`https://github.com/${encodeURIComponent(state.link.login)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      @{state.link.login}
                    </a>
                    . Continue signing in with your email and password.
                  </>
                ) : (
                  "Your email login, projects and Agent access stay the same."
                )}
              </p>
              {!state.configured && (
                <p className="small">
                  GitHub connection is not configured yet. Please contact the
                  administrator.
                </p>
              )}
            </div>
            <div>
              {state.link ? (
                <OLButton
                  variant="secondary"
                  disabled={busy}
                  onClick={() => setDisconnect(true)}
                >
                  Disconnect
                </OLButton>
              ) : state.canonicalSettingsUrl ? (
                <OLButton variant="secondary" href={state.canonicalSettingsUrl}>
                  Open primary site
                </OLButton>
              ) : (
                <OLButton
                  variant="secondary"
                  disabled={busy || !state.configured || Boolean(state.pending)}
                  onClick={() => void action("start")}
                >
                  Connect GitHub
                </OLButton>
              )}
            </div>
          </div>
          {state.pending && (
            <div role="region" aria-label="Confirm GitHub account">
              <p>
                Link <strong>@{state.pending.login}</strong> to this Overleaf
                account?
              </p>
              <p>
                This authorization expires after 10 minutes. No repository
                access is requested.
              </p>
              <div className="d-flex gap-2">
                <OLButton
                  variant="primary"
                  disabled={busy}
                  onClick={() => void action("confirm")}
                >
                  Confirm connection
                </OLButton>
                <OLButton
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void action("cancel")}
                >
                  Cancel
                </OLButton>
              </div>
            </div>
          )}
        </>
      )}
      <hr />
      <OLModal
        show={disconnect}
        onHide={() => !busy && setDisconnect(false)}
        aria-labelledby="github-disconnect-title"
      >
        <OLModalHeader closeButton>
          <OLModalTitle id="github-disconnect-title">
            Disconnect GitHub?
          </OLModalTitle>
        </OLModalHeader>
        <OLModalBody>
          <p>
            This removes the GitHub connection from your Overleaf account. Your
            email login and projects will stay available.
          </p>
          <p>
            You can also revoke the app authorization in{" "}
            <a
              href="https://github.com/settings/apps/authorizations"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub Settings
            </a>
            .
          </p>
        </OLModalBody>
        <OLModalFooter>
          <OLButton
            variant="secondary"
            disabled={busy}
            onClick={() => setDisconnect(false)}
          >
            Cancel
          </OLButton>
          <OLButton
            variant="danger"
            disabled={busy}
            onClick={() => void action("unlink")}
          >
            Disconnect GitHub
          </OLButton>
        </OLModalFooter>
      </OLModal>
    </section>
  );
}
