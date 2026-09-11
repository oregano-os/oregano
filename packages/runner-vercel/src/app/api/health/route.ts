import { releaseContinuityDigest } from "../../../../../connectors/release-continuity.ts";
import { loadArtifact, selectedAgent } from "../../../lib/artifact.ts";
import { builderConfigurationDigest } from "../../../lib/builder/release-provider.ts";
import { getBot } from "../../../lib/bot.ts";
import { resolveModelExecution } from "../../../lib/model-execution.ts";
import { agentModelTask } from "../../../lib/agent-model-task.ts";
import { qualifyCompanyDatabase } from "../../../../../state-postgres/database-bootstrap.ts";
import { decodeModelRuntimeConfiguration } from "../../../../../runner/model-execution.ts";
import { createPostgresKnowledgeProvider } from "../../../../../state-postgres/knowledge-store.ts";

import { decodeWorkflowHostingConfiguration, workflowHostingEnabled } from "../../../lib/workflow-configuration.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const artifact = loadArtifact();
    const primaryAgent = selectedAgent();
    const primaryTask = agentModelTask(primaryAgent, { kind: "auto" });
    const modelExecution = resolveModelExecution({ profile: primaryTask.profile, task: primaryTask.task, requiredCapability: "tools" });
    const knowledgeAnswerModelExecution = resolveModelExecution({
      profile: "deep",
      task: "knowledge.cited-synthesis",
      requiredCapability: "tools",
      configuration: decodeModelRuntimeConfiguration(process.env.COMPANYOS_KNOWLEDGE_MODEL_CONFIG_BASE64),
    });
    const database = await qualifyCompanyDatabase();
    // Construction checks Connector configuration and registers handlers. It
    // does not initialize provider clients, send messages or invoke a model.
    getBot();
    const workflowsEnabled = workflowHostingEnabled();
    const workflowConfig = workflowsEnabled ? decodeWorkflowHostingConfiguration(artifact) : undefined;
    const knowledgeSnapshot = process.env.COMPANYOS_BUILDER_RELEASE_BINDING_BASE64
      ? await createPostgresKnowledgeProvider({ snapshotHash: artifact.knowledge!.bundleHash }).activeSnapshot() : undefined;
    if (process.env.COMPANYOS_BUILDER_RELEASE_BINDING_BASE64 && (!knowledgeSnapshot
      || knowledgeSnapshot.bundle.workspaceCommit !== artifact.provenance.workspaceCommit)) throw new Error("The release Knowledge snapshot is not available for the exact Workspace.");
    return Response.json({
      ok: true,
      status: "ready",
      instance: artifact.instance,
      company: artifact.company,
      agent: primaryAgent.id,
      agents: artifact.agents.map((agent) => {
        const task = agentModelTask(agent, { kind: "auto" });
        const { selection } = resolveModelExecution({ profile: task.profile, task: task.task, requiredCapability: "tools" });
        return { id: agent.id, toolCount: agent.toolSet.tools.length,
          modelTask: task.task, modelProfile: task.profile, model: selection.model, modelRoute: selection.route };
      }),
      agentRouting: {
        bindingCount: artifact.agentRouting?.bindings.length ?? 0,
        defaultAgentId: artifact.agentRouting?.defaultAgentId ?? null,
      },
      artifactHash: artifact.artifactHash,
      deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? null,
      sourceCoreCommit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
      configurationDigest: builderConfigurationDigest() ?? null,
      releaseContinuityDigest: releaseContinuityDigest(process.env),
      knowledgeSnapshotHash: knowledgeSnapshot?.snapshotHash ?? null,
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
      knowledgeAnswerModelRoute: knowledgeAnswerModelExecution.selection.route,
      knowledgeAnswerModelProvider: knowledgeAnswerModelExecution.selection.provider,
      knowledgeAnswerModel: knowledgeAnswerModelExecution.selection.model,
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
      meta: "disabled-until-real-connector-binding",
    });
  } catch (error) {
    return Response.json({ ok: false, status: "not-ready", error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}
