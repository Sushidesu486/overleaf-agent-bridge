import { RailElement } from "@/features/ide-react/util/rail-types";
import getMeta from "@/utils/meta";
import AgentChat from "./agent-chat";
import { AgentRailIcon } from "./project-icons";
const agentRail: RailElement = {
  key: "agent-access",
  icon: AgentRailIcon,
  title: "My Agent",
  component: <AgentChat />,
  hide: () => getMeta("ol-anonymous"),
};
export default agentRail;
