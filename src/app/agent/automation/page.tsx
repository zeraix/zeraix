import { Workflow } from "lucide-react";
import AgentPlaceholder from "@/components/layout/agent/AgentPlaceholder";

export default function AgentAutomationPage() {
  return (
    <AgentPlaceholder
      icon={Workflow}
      title="Automation"
      description="Create automated workflows to run tasks automatically on a schedule or in response to events."
      emptyText="No automation workflows yet"
    />
  );
}
