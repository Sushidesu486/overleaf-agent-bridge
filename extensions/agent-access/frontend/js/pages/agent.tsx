import { renderInReactLayout } from "@/react";
import "@/utils/meta";
import "@/utils/webpack-public-path";
import "@/i18n";
import AgentPage from "../components/agent-page";

renderInReactLayout("agent-page-root", () => <AgentPage />);
