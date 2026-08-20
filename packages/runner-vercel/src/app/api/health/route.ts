import { neon } from "@neondatabase/serverless";
import { loadArtifact, selectedAgent } from "../../../lib/artifact.ts";
import { ensureCompanyOSSchema } from "../../../../../state-postgres/migrate.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const artifact = loadArtifact();
    const agent = selectedAgent();
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
      model: process.env.COMPANYOS_MODEL ?? "openai/gpt-5.4-nano",
      meta: "disabled-until-real-connector-binding",
    });
  } catch (error) {
    return Response.json({ ok: false, status: "not-ready", error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}
