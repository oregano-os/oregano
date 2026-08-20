import { neon } from "@neondatabase/serverless";
import { ensureCompanyOSSchema } from "../../../../../state-postgres/migrate.ts";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ artifactId: string }> }) {
  const { artifactId } = await context.params;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(artifactId)) return new Response("Not found", { status: 404 });
  await ensureCompanyOSSchema();
  const sql = neon(process.env.DATABASE_URL!);
  const rows = await sql`select content, content_type, digest from companyos.published_artifacts where artifact_id = ${artifactId}`;
  const artifact = rows[0];
  if (!artifact) return new Response("Not found", { status: 404 });
  return new Response(artifact.content as string, {
    headers: {
      "Content-Type": artifact.content_type === "text/html" ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; font-src https: data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "ETag": `\"${artifact.digest}\"`,
      "Cache-Control": "public, max-age=60, stale-while-revalidate=300",
    },
  });
}
