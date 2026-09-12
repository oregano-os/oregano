import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { neon } from "@neondatabase/serverless";

export const retirementSql = readFileSync(new URL("../packages/state-postgres/migrations/retire-knowledge.sql", import.meta.url), "utf8");

export function retirementTarget(databaseUrl) {
  const url = new URL(databaseUrl);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("A PostgreSQL DATABASE_URL is required.");
  const target = { host: url.hostname, port: url.port || "5432", database: decodeURIComponent(url.pathname.slice(1)), schema: "companyos_knowledge" };
  if (!target.host || !target.database) throw new Error("The retirement target requires an exact host and database.");
  const confirmation = createHash("sha256").update(JSON.stringify({ target, migration: retirementSql })).digest("hex");
  return { ...target, confirmation };
}

export async function retireKnowledge({ databaseUrl, confirmation, writersStopped, sql = neon(databaseUrl) }) {
  const target = retirementTarget(databaseUrl);
  if (confirmation !== target.confirmation || writersStopped !== true) {
    throw new Error("Review --preview, then supply its exact --confirm hash and --writers-stopped after stopping the old runtime and source jobs.");
  }
  await sql.query(retirementSql, []);
  const rows = await sql`select to_regnamespace('companyos_knowledge')::text as retired_schema`;
  if (rows[0]?.retired_schema != null) throw new Error("The retired schema is still present; check for an old writer.");
  return { status: "retired", ...target, completedAt: new Date().toISOString() };
}

async function main() {
  const args = process.argv.slice(2);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("Bind the exact Instance DATABASE_URL through the existing secret transport.");
  if (args.length === 1 && args[0] === "--preview") {
    process.stdout.write(`${JSON.stringify({ operation: "retire-knowledge", target: retirementTarget(databaseUrl), atomic: true, preserves: ["companyos", "companyos_records"] }, null, 2)}\n`);
    return;
  }
  if (args.length !== 3 || args[0] !== "--confirm" || args[2] !== "--writers-stopped") throw new Error("Use --preview or --confirm <hash> --writers-stopped.");
  const receipt = await retireKnowledge({ databaseUrl, confirmation: args[1], writersStopped: true });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Provider errors can contain connection details; keep them out of logs.
    process.stderr.write(`Knowledge retirement failed (${error?.code ?? "check-target-and-dependencies"}). No success receipt was produced.\n`);
    process.exitCode = 1;
  });
}
