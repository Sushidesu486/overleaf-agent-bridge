import { renderInReactLayout } from "@/react";
import "@/utils/meta";
import "@/utils/webpack-public-path";
import "@/i18n";
import AgentPage from "../components/agent-page";
import { UserSettingsProvider } from "@/shared/context/user-settings-context";
import { SplitTestProvider } from "@/shared/context/split-test-context";

renderInReactLayout("agent-page-root", () => (
  <SplitTestProvider>
    <UserSettingsProvider>
      <AgentPage />
    </UserSettingsProvider>
  </SplitTestProvider>
));
