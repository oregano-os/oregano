import { CORE_CAPABILITY_CATALOG } from "../capabilities/catalog.ts";
import { assertValidJsonSchema } from "../capabilities/validation.ts";
import { sha256 } from "../runtime/canonical.ts";
import { resolveToolSet } from "../toolset-resolver/resolver.ts";
import { requireExactSemanticVersion } from "../runtime/semantic-version.ts";
import { buildKnowledgeBundle } from "../knowledge/okf.ts";
import { STANDARD_KNOWLEDGE_TOOLS } from "../standard-tools/knowledge.ts";
import { STANDARD_RECORDS_TOOLS } from "../standard-tools/records.ts";
import { STANDARD_WORK_ITEM_TOOLS } from "../standard-tools/work-items.ts";
import { STANDARD_COMMUNICATION_TOOLS } from "../standard-tools/communication.ts";
import type { CompanyOSArtifact, InstanceBuildConfiguration } from "./types.ts";
import { loadCompanyWorkspace, scopedMaterials } from "./workspace-loader.ts";
import { validateAgentRouting } from "../runtime/agent-resolver.ts";

export function buildCompanyOSArtifact(args: {
  workspaceRoot: string;
  instance: InstanceBuildConfiguration;
  coreVersion: string;
  coreCommit: string;
  workspaceCommit: string;
  workbenchVersion: string;
  builtAt?: string;
}): CompanyOSArtifact {
  const standardTools = [
    ...STANDARD_KNOWLEDGE_TOOLS,
    ...STANDARD_RECORDS_TOOLS,
    ...STANDARD_WORK_ITEM_TOOLS,
    ...STANDARD_COMMUNICATION_TOOLS,
  ];
  for (const [label, value] of [["coreCommit", args.coreCommit], ["workspaceCommit", args.workspaceCommit]] as const) {
    if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${label} must be an immutable 40-character Git SHA.`);
  }
  const coreVersion = requireExactSemanticVersion(args.coreVersion, "coreVersion");
  const workbenchVersion = requireExactSemanticVersion(args.workbenchVersion, "workbenchVersion");
  for (const contract of CORE_CAPABILITY_CATALOG) {
    assertValidJsonSchema(contract.inputSchema, `${contract.id} input schema`);
    assertValidJsonSchema(contract.outputSchema, `${contract.id} output schema`);
  }
  const workspace = loadCompanyWorkspace(args.workspaceRoot, { includeBuilder: args.instance.builder?.enabled === true });
  const knowledgeBundle = buildKnowledgeBundle({ workspaceRoot: args.workspaceRoot, workspaceCommit: args.workspaceCommit });
  const agents = workspace.agents.map((agent) => {
    const toolSet = resolveToolSet({
      agentId: agent.id,
      grants: agent.grants,
      companyTools: agent.tools.map((tool) => tool.contract),
      standardTools: standardTools.map((tool) => tool.contract),
      capabilityCatalog: CORE_CAPABILITY_CATALOG,
      allowedCapabilities: workspace.allowedCapabilities,
      bindings: args.instance.bindings,
    });
    const resolvedIds = new Set(toolSet.tools.map((tool) => tool.runtimeId));
    return {
      id: agent.id,
      instructions: agent.instructions,
      materials: scopedMaterials(workspace, agent.scopeRead, {
        excludeKnowledgeDocuments: agent.grants.some((grant) => grant.startsWith("oregano:knowledge/")),
      }),
      toolSet,
      tools: [...agent.tools, ...standardTools].filter((tool) => resolvedIds.has(tool.contract.runtimeId)),
    };
  });
  const resolvedToolSetHash = sha256(agents.map((agent) => ({ id: agent.id, hash: agent.toolSet.hash })));
  const agentRouting = {
    bindings: [...args.instance.agentBindings].sort((a, b) => a.id.localeCompare(b.id)),
    handoffs: workspace.agents.flatMap((agent) => agent.handoffs).sort((a, b) => a.id.localeCompare(b.id)),
    defaultAgentId: args.instance.defaultAgentId,
  };
  validateAgentRouting(agentRouting, agents.map((agent) => agent.id));
  const withoutHash = {
    schemaVersion: 1 as const,
    company: workspace.company,
    instance: { id: args.instance.instanceId, environment: args.instance.environment },
    provenance: {
      coreVersion,
      coreCommit: args.coreCommit,
      workspaceVersion: workspace.version,
      workspaceCommit: args.workspaceCommit,
      workbenchVersion,
      workspaceHash: workspace.workspaceHash,
      capabilityCatalogHash: sha256(CORE_CAPABILITY_CATALOG),
      resolvedToolSetHash,
      builtAt: args.builtAt ?? new Date().toISOString(),
    },
    capabilityCatalog: [...CORE_CAPABILITY_CATALOG],
    bindings: [...args.instance.bindings].sort((a, b) => a.capability.localeCompare(b.capability)),
    knowledge: {
      bundleSchemaVersion: knowledgeBundle.schemaVersion,
      okfVersion: knowledgeBundle.okfVersion,
      bundleHash: knowledgeBundle.bundleHash,
      policyHash: knowledgeBundle.policyHash,
      documentCount: knowledgeBundle.documentCount,
      fragmentCount: knowledgeBundle.fragmentCount,
    },
    roster: workspace.roster,
    agents,
    agentRouting,
    builder: args.instance.builder,
  };
  const hashInput = {
    ...withoutHash,
    provenance: { ...withoutHash.provenance, builtAt: undefined },
  };
  return { ...withoutHash, artifactHash: sha256(hashInput) };
}
