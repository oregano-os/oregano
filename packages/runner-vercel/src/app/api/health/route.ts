import { releaseContinuityDigest } from "../../../../../connectors/release-continuity.ts";
import { loadArtifact, selectedAgent } from "../../../lib/artifact.ts";
import { builderConfigurationDigest } from "../../../lib/builder/release-provider.ts";
import { getBot } from "../../../lib/bot.ts";
import { resolveModelExecution } from "../../../lib/model-execution.ts";
import { qualifyCompanyDatabase } from "../../../../../state-postgres/database-bootstrap.ts";
import { decodeModelRuntimeConfiguration } from "../../../../../runner/model-execution.ts";

import { decodeWorkflowHostingConfiguration, workflowHostingEnabled } from "../../../lib/workflow-configuration.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const artifact = loadArtifact();
    const primaryAgent = selectedAgent();
    const modelExecution = resolveModelExecution({ profile: "agent", task: "agent.chat", requiredCapability: "tools" });
    const database = await qualifyCompanyDatabase();
    const workflowsEnabled = workflowHostingEnabled();
    const workflowConfig = workflowsEnabled ? decodeWorkflowHostingConfiguration(artifact) : undefined;
    // Validate Connector configuration without initializing provider clients.
    getBot();
    const sprintMode = process.env.COMPANYOS_SPRINT_RUNTIME_MODE ?? "disabled";
    if (!["disabled", "shadow", "active"].includes(sprintMode)) throw new Error("Invalid Sprint runtime mode.");
    const sprintRuntimes = (artifact.sprints ?? []).map((sprint) => {
      const model = resolveModelExecution({ profile: "reasoning", task: sprint.modelTask, requiredCapability: "tools" });
      return {
        definitionId: sprint.definitionId,
        agentId: sprint.agentId,
        modelTask: sprint.modelTask,
        modelRoute: model.selection.route,
        modelProvider: model.selection.provider,
        model: model.selection.model,
        scheduleActivation: sprint.schedule.activation,
        scheduleDigest: sprint.schedule.sourceDigest,
      };
    });
    return Response.json({
      ok: true,
      status: "ready",
      instance: artifact.instance,
      company: artifact.company,
      agent: primaryAgent.id,
      agents: artifact.agents.map((agent) => ({
        id: agent.id,
        toolCount: agent.toolSet.tools.length,
      })),
      agentRouting: {
        bindingCount: artifact.agentRouting?.bindings.length ?? 0,
        defaultAgentId: artifact.agentRouting?.defaultAgentId ?? null,
      },
      artifactHash: artifact.artifactHash,
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      sourceCoreCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      configurationDigest: builderConfigurationDigest() ?? null,
      releaseContinuityDigest: releaseContinuityDigest(process.env),
      builder: {
        desired: artifact.agents.some((agent) => agent.id === "builder"),
        codingConfigured: Boolean(artifact.builder),
        releaseConfigured: Boolean(artifact.builderReleasePolicy && process.env.COMPANYOS_BUILDER_RELEASE_BINDING_BASE64),
      },
      coreVersion: artifact.provenance.coreVersion,
      coreCommit: artifact.provenance.coreCommit,
      workspaceVersion: artifact.provenance.workspaceVersion,
      workspaceCommit: artifact.provenance.workspaceCommit,
      resolvedToolSetHash: artifact.provenance.resolvedToolSetHash,
      tools: primaryAgent.toolSet.tools.map((item) => ({ grantId: item.grantId, risk: item.risk })),
      modelRoute: modelExecution.selection.route,
      modelProvider: modelExecution.selection.provider,
      model: modelExecution.selection.model,
      databaseManifestId: database.manifestId,
      databaseManifestVersion: database.manifestVersion,
      databaseManifestDigest: database.manifestDigest,
      databaseFeatures: database.features,
      companyRecords: {
        configured: Boolean(process.env.COMPANYOS_RECORDS_CONFIG_GZIP_BASE64),
        enabled: process.env.COMPANYOS_RECORDS_ENABLED === "true",
        schedulerEnabled: process.env.COMPANYOS_RECORDS_SCHEDULER_ENABLED === "true",
        schemaTableCount: database.schemas.companyosRecords.tableCount,
      },
      workflows: {
        enabled: workflowsEnabled,
        enabledWorkflowIds: workflowConfig?.enabledWorkflowIds ?? [],
        autoOpenWorkflowIds: workflowConfig?.autoOpenWorkflowIds ?? [],
        compiledCount: artifact.workflows?.length ?? 0,
        activatedAt: workflowConfig?.activatedAt ?? null,
      },
      sprint: {
        mode: sprintMode,
        runtimeCount: sprintRuntimes.length,
        runtimes: sprintRuntimes,
      },
      meta: "disabled-until-real-connector-binding",
    });
  } catch (error) {
    return Response.json({ ok: false, status: "not-ready", error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}
