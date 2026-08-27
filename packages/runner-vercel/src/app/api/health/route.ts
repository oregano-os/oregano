import { loadArtifact, selectedAgent } from "../../../lib/artifact.ts";
import { resolveModelExecution } from "../../../lib/model-execution.ts";
import { qualifyCompanyDatabase } from "../../../../../state-postgres/database-bootstrap.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const artifact = loadArtifact();
    const agent = selectedAgent();
    const modelExecution = resolveModelExecution({ profile: "agent", task: "agent.chat", requiredCapability: "tools" });
    const database = await qualifyCompanyDatabase();
    return Response.json({
      ok: true,
      status: "ready",
      instance: artifact.instance,
      company: artifact.company,
      agent: agent.id,
      artifactHash: artifact.artifactHash,
      coreVersion: artifact.provenance.coreVersion,
      coreCommit: artifact.provenance.coreCommit,
      workspaceVersion: artifact.provenance.workspaceVersion,
      workspaceCommit: artifact.provenance.workspaceCommit,
      resolvedToolSetHash: artifact.provenance.resolvedToolSetHash,
      tools: agent.toolSet.tools.map((item) => ({ grantId: item.grantId, risk: item.risk })),
      modelRoute: modelExecution.selection.route,
      modelProvider: modelExecution.selection.provider,
      model: modelExecution.selection.model,
      databaseManifestId: database.manifestId,
      databaseManifestVersion: database.manifestVersion,
      databaseManifestDigest: database.manifestDigest,
      databaseFeatures: database.features,
      meta: "disabled-until-real-connector-binding",
    });
  } catch (error) {
    return Response.json({ ok: false, status: "not-ready", error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}
