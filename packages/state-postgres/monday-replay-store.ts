import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import type { MondayReplayStore } from "../connectors/monday/webhook.ts";
import { ensureCompanyRecordsSchema } from "./records-migrate.ts";

const connection = () => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set — callback replay claims use the existing Company Instance database.");
  return neon(value);
};

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Atomically claim a verified callback without retaining its provider signature. */
export function createPostgresMondayReplayStore(): MondayReplayStore {
  return {
    async claim(key, expiresAt) {
      await ensureCompanyRecordsSchema();
      const sql = connection();
      await sql`delete from companyos_records.callback_replay_claims where expires_at <= now()`;
      const rows = await sql`insert into companyos_records.callback_replay_claims (claim_digest, expires_at)
        values (${digest(key)}, ${expiresAt}) on conflict (claim_digest) do nothing returning claim_digest`;
      return rows.length === 1;
    },
  };
}
