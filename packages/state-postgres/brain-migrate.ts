import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

/** Explicit database bootstrap/upgrade only. Runtime reads never invoke migration. */
export async function ensureBrainSchema(): Promise<void> {
  if (!process.env.DATABASE_URL) throw new Error("Brain migration requires the bound Company Instance database.");
  const sql = neon(process.env.DATABASE_URL);
  const ddl = readFileSync(new URL("./brain-schema.sql", import.meta.url), "utf8");
  for (const statement of ddl.split(";").map(value => value.trim()).filter(Boolean)) await sql.query(statement);
}
