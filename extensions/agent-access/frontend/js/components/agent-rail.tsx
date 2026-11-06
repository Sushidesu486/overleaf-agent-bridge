import { RailElement } from "@/features/ide-react/util/rail-types";
import getMeta from "@/utils/meta";
import AgentChat from "./agent-chat";
const agentRail: RailElement = {
  key: "agent-access",
  icon: "integration_instructions",
  title: "我的 Agent",
  component: <AgentChat />,
  hide: () => getMeta("ol-anonymous"),
};
export default agentRail;
