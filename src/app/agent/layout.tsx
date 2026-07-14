import AgentShell from "@/components/layout/agent/AgentShell";

/**
 * /agent module layout: applies the new sidebar shell.
 * This path is already marked as hidden in `isHiddenLayout()`, so the global legacy sidebar is not stacked on top.
 */
export default function AgentLayout({ children }: { children: React.ReactNode }) {
  return <AgentShell>{children}</AgentShell>;
}
