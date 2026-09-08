import type { CompanyOSArtifact } from "../../../companyos-builder/types.ts";
import type { Connector } from "../../../capabilities/contracts.ts";

/** Use the retained Artifact's grants, including its conversational Tools. */
export function createHostedWorkflowConnectors(args: {
  artifact: CompanyOSArtifact;
  enabledWorkflowIds: readonly string[];
  create(capabilities: string[]): Connector[];
}): Connector[] {
  const owners = new Set(args.artifact.workflows?.filter((workflow) => args.enabledWorkflowIds.includes(workflow.id)).map((workflow) => workflow.agentId));
  const capabilities = [...new Set([...owners].flatMap((id) => {
    const agent = args.artifact.agents.find((entry) => entry.id === id);
    if (!agent) throw new Error("A hosted workflow has no retained Agent owner.");
    return agent.tools.flatMap((tool) => tool.contract.capabilities);
  }))].sort();
  const selected = new Set(capabilities);
  for (const entry of args.artifact.connectors ?? []) {
    const required = args.artifact.bindings.some((binding) => selected.has(binding.capability)
      && binding.connector === entry.connector && binding.connectorVersion === entry.connectorVersion);
    if (required && entry.connector === "oregano/company-records" && !entry.configuration.configuration_snapshot) {
      throw new Error("Hosted workflows require a non-secret Company Records configuration_snapshot retained in their Artifact");
    }
  }
  return args.create(capabilities);
}
