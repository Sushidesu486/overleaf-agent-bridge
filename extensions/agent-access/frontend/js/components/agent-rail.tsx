import RailPanelHeader from "@/features/ide-react/components/rail/rail-panel-header";
import { RailElement } from "@/features/ide-react/util/rail-types";
import { useProjectContext } from "@/shared/context/project-context";
import OLButton from "@/shared/components/ol/ol-button";
import getMeta from "@/utils/meta";

function AgentPanel() {
  const { projectId, name } = useProjectContext();
  return (
    <>
      <RailPanelHeader title="我的 Agent" />
      <div className="p-3">
        <p className="small mb-1">当前项目</p>
        <h5 className="text-break">{name}</h5>
        <p>让你的 Agent 读取、编辑并编译这个项目。</p>
        <OLButton
          href={`/user/agent?project=${projectId}`}
          target="_blank"
          rel="noopener noreferrer"
          variant="primary"
          leadingIcon="link"
          className="w-100"
        >
          连接此项目
        </OLButton>
        <p className="small mt-3">
          新链接默认只允许访问当前项目。Agent 的编辑会在 History 中标为 Your
          agent。
        </p>
        <a href="/user/agent" target="_blank" rel="noopener noreferrer">
          管理我的全部连接
        </a>
      </div>
    </>
  );
}

const agentRail: RailElement = {
  key: "agent-access",
  icon: "integration_instructions",
  title: "我的 Agent",
  component: <AgentPanel />,
  hide: () => getMeta("ol-anonymous"),
};
export default agentRail;
