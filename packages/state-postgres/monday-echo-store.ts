import { neon } from "@neondatabase/serverless";
import type { MondayEchoReceipt, MondayEchoStore } from "../connectors/monday/contracts.ts";
import { postgresTimestampToIso } from "./postgres-values.ts";
import { ensureCompanyRecordsSchema } from "./records-migrate.ts";

const connection = () => {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set — Connector echo receipts use the existing Company Instance database.");
  return neon(value);
};

const fromRow = (row: Record<string, any>): MondayEchoReceipt => ({
  instanceId: String(row.instance_id),
  resourceBinding: String(row.resource_binding),
  workItemId: String(row.object_id),
  providerVersion: String(row.provider_version),
  actorId: String(row.actor_id),
  idempotencyKey: String(row.idempotency_key),
  expiresAt: postgresTimestampToIso(row.expires_at),
});

export function createPostgresMondayEchoStore(): MondayEchoStore {
  return {
    async remember(receipt) {
      await ensureCompanyRecordsSchema();
      await connection()`insert into companyos_records.connector_echo_receipts
        (instance_id, connector_id, resource_binding, object_id, provider_version, actor_id, idempotency_key, expires_at)
        values (${receipt.instanceId}, 'oregano/monday-work-items', ${receipt.resourceBinding},
          ${receipt.workItemId}, ${receipt.providerVersion}, ${receipt.actorId},
          ${receipt.idempotencyKey}, ${receipt.expiresAt})
        on conflict (instance_id, connector_id, resource_binding, object_id, provider_version, actor_id)
        do update set idempotency_key = excluded.idempotency_key, expires_at = excluded.expires_at`;
    },

    async consumeMatch(args) {
      await ensureCompanyRecordsSchema();
      const rows = await connection()`delete from companyos_records.connector_echo_receipts
        where instance_id = ${args.instanceId} and connector_id = 'oregano/monday-work-items'
          and resource_binding = ${args.resourceBinding} and object_id = ${args.workItemId}
          and provider_version = ${args.providerVersion} and actor_id = ${args.actorId}
          and expires_at > ${args.now} returning *`;
      return rows[0] ? fromRow(rows[0]) : undefined;
    },
  };
}
