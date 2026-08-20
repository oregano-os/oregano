import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import type { CapabilityCallContext, CapabilityResult, Connector } from "../capabilities/contracts.ts";
import { ensureCompanyOSSchema } from "../state-postgres/migrate.ts";

const ARTIFACT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const ALLOWED_CONTENT_TYPES = new Set(["text/html", "text/plain"]);

export class ArtifactPostgresConnector implements Connector {
  readonly id = "oregano/artifact-postgres";
  readonly version = "1.0.0";
  readonly capabilities = ["artifact.publish"] as const;

  async invoke(capability: string, input: any, context: CapabilityCallContext): Promise<CapabilityResult> {
    if (capability !== "artifact.publish") throw new Error(`Unsupported Capability '${capability}'.`);
    if (!ARTIFACT_ID.test(input.artifact_id)) throw new Error("artifact_id contains unsupported characters.");
    if (!ALLOWED_CONTENT_TYPES.has(input.content_type)) throw new Error(`Unsupported content type '${input.content_type}'.`);
    const baseUrl = process.env.COMPANYOS_PUBLIC_BASE_URL;
    const databaseUrl = process.env.DATABASE_URL;
    if (!baseUrl || !databaseUrl) throw new Error("The Instance is missing COMPANYOS_PUBLIC_BASE_URL or DATABASE_URL.");
    await ensureCompanyOSSchema();
    const digest = createHash("sha256").update(input.content).digest("hex");
    const sql = neon(databaseUrl);
    const rows = await sql`
      insert into companyos.published_artifacts (artifact_id, content, content_type, digest, run_id)
      values (${input.artifact_id}, ${input.content}, ${input.content_type}, ${digest}, ${context.runId})
      on conflict (artifact_id) do update
        set content = excluded.content, content_type = excluded.content_type,
            digest = excluded.digest, run_id = excluded.run_id, published_at = now()
        where companyos.published_artifacts.digest = excluded.digest
      returning artifact_id`;
    if (rows.length !== 1) throw new Error(`Artifact '${input.artifact_id}' already exists with different content.`);
    const url = `${baseUrl.replace(/\/$/, "")}/artifacts/${encodeURIComponent(input.artifact_id)}`;
    return {
      output: { artifact_id: input.artifact_id, url, digest },
      evidence: { simulated: false, artifact_id: input.artifact_id, digest, url },
    };
  }
}
