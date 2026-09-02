import { loadArtifact, selectedAgent } from "../../../lib/artifact.ts";
import { resolveModelExecution } from "../../../lib/model-execution.ts";
import { qualifyCompanyDatabase } from "../../../../../state-postgres/database-bootstrap.ts";
import { decodeModelRuntimeConfiguration } from "../../../../../runner/model-execution.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const artifact = loadArtifact();
    const primaryAgent = selectedAgent();
    const modelExecution = resolveModelExecution({ profile: "agent", task: "agent.chat", requiredCapability: "tools" });
    const knowledgeAnswerModelExecution = resolveModelExecution({
      profile: "deep",
      task: "knowledge.cited-synthesis",
      requiredCapability: "tools",
      configuration: decodeModelRuntimeConfiguration(process.env.COMPANYOS_KNOWLEDGE_MODEL_CONFIG_BASE64),
    });
    const database = await qualifyCompanyDatabase();
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
      meta: "disabled-until-real-connector-binding",
    });
  } catch (error) {
    return Response.json({ ok: false, status: "not-ready", error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}
