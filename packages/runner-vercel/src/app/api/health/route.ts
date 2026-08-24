import { neon } from "@neondatabase/serverless";
import { loadArtifact, selectedAgent } from "../../../lib/artifact.ts";
import { resolveModelExecution } from "../../../lib/model-execution.ts";
import { ensureCompanyOSSchema } from "../../../../../state-postgres/migrate.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const artifact = loadArtifact();
    const agent = selectedAgent();
    const modelExecution = resolveModelExecution();
    await ensureCompanyOSSchema();
    const sql = neon(process.env.DATABASE_URL!);
    await sql`select 1`;
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
      meta: "disabled-until-real-connector-binding",
    });
  } catch (error) {
    return Response.json({ ok: false, status: "not-ready", error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}
