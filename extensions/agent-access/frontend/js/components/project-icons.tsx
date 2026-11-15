import type { CustomRailTabIcon } from "@/features/ide-react/util/rail-types";

export function GitBranchIcon({ active = false }: { active?: boolean }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M5 6.5v7M15 6.5v1A5 5 0 0 1 10 12.5H5" />
      <g fill={active ? "currentColor" : "none"}>
        <circle cx="5" cy="4.25" r="2.25" />
        <circle cx="5" cy="15.75" r="2.25" />
        <circle cx="15" cy="4.25" r="2.25" />
      </g>
    </svg>
  );
}

export function BotIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M10 3v3M2 9.5v4M18 9.5v4M8 14h4" />
      <rect x="4" y="6" width="12" height="11" rx="3" />
      <g fill="currentColor" stroke="none">
        <circle cx="10" cy="2.5" r="1.25" />
        <circle cx="7.5" cy="10.5" r="1" />
        <circle cx="12.5" cy="10.5" r="1" />
      </g>
    </svg>
  );
}

export const GitRailIcon: CustomRailTabIcon = ({ open, title }) => (
  <>
    <span className="ide-rail-tab-link-icon project-rail-icon">
      <GitBranchIcon active={open} />
    </span>
    <span className="visually-hidden">{title}</span>
  </>
);

export const AgentRailIcon: CustomRailTabIcon = ({ title }) => (
  <>
    <span className="ide-rail-tab-link-icon project-rail-icon">
      <BotIcon />
    </span>
    <span className="visually-hidden">{title}</span>
  </>
);
