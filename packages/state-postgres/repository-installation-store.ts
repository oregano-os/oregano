import { neon } from "@neondatabase/serverless";
import {
  assertRepositoryInstallationBinding,
  type RepositoryInstallationBinding,
  type RepositoryInstallationStore,
} from "../state-store/repository-installations.ts";
import { ensureCompanyOSSchema } from "./migrate.ts";

function connection() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set — bind the Company Instance StateStore.");
  return neon(url);
}

export function createPostgresRepositoryInstallationStore(): RepositoryInstallationStore {
  return {
    async putVerified(binding) {
      assertRepositoryInstallationBinding(binding);
      await ensureCompanyOSSchema();
      const rows = await connection()`
        insert into companyos.repository_installations (
          binding_id, instance_id, provider_id, service_environment,
          installation_id, provider_repository_id, repository_id,
          owner_name, repository_name, default_branch, status,
          verified_at, updated_at, provider_receipt)
        values (
          ${binding.bindingId}, ${binding.instanceId}, ${binding.providerId},
          ${binding.serviceEnvironment}, ${binding.installationId},
          ${binding.providerRepositoryId}, ${binding.repositoryId}, ${binding.owner},
          ${binding.name}, ${binding.defaultBranch}, ${binding.status},
          ${binding.verifiedAt}, ${binding.updatedAt},
          ${JSON.stringify(binding.providerReceipt)})
        on conflict (binding_id) do update
        set default_branch = excluded.default_branch, status = excluded.status,
            verified_at = excluded.verified_at, updated_at = excluded.updated_at,
            provider_receipt = excluded.provider_receipt
        where companyos.repository_installations.instance_id = excluded.instance_id
          and companyos.repository_installations.provider_id = excluded.provider_id
          and companyos.repository_installations.service_environment = excluded.service_environment
          and companyos.repository_installations.installation_id = excluded.installation_id
          and companyos.repository_installations.provider_repository_id = excluded.provider_repository_id
          and companyos.repository_installations.repository_id = excluded.repository_id
        returning *`;
      if (!rows[0]) {
        throw new Error(`Repository installation binding '${binding.bindingId}' conflicts with verified identity.`);
      }
      return rowToBinding(rows[0]);
    },

    async get(bindingId) {
      await ensureCompanyOSSchema();
      const rows = await connection()`
        select * from companyos.repository_installations where binding_id = ${bindingId} limit 1`;
      return rows[0] ? rowToBinding(rows[0]) : undefined;
    },

    async requireActive(bindingId, repositoryId) {
      await ensureCompanyOSSchema();
      const rows = await connection()`
        select * from companyos.repository_installations
        where binding_id = ${bindingId} and repository_id = ${repositoryId} and status = 'active'
        limit 1`;
      if (!rows[0]) {
        throw new Error(`Repository installation binding '${bindingId}' is unavailable, inactive, or unauthorized.`);
      }
      return rowToBinding(rows[0]);
    },

    async updateStatus(args) {
      await ensureCompanyOSSchema();
      const rows = await connection()`
        update companyos.repository_installations
        set status = ${args.status}, provider_receipt = ${JSON.stringify(args.providerReceipt)},
            updated_at = ${(args.updatedAt ?? new Date()).toISOString()}
        where provider_id = ${args.providerId} and installation_id = ${args.installationId}
        returning binding_id`;
      return rows.length;
    },

    async updateRepositoryStatus(args) {
      await ensureCompanyOSSchema();
      const rows = await connection()`
        update companyos.repository_installations
        set status = ${args.status}, provider_receipt = ${JSON.stringify(args.providerReceipt)},
            updated_at = ${(args.updatedAt ?? new Date()).toISOString()}
        where provider_id = ${args.providerId}
          and installation_id = ${args.installationId}
          and provider_repository_id = ${args.providerRepositoryId}
        returning binding_id`;
      return rows.length;
    },
  };
}

function rowToBinding(row: Record<string, any>): RepositoryInstallationBinding {
  return {
    bindingId: String(row.binding_id),
    instanceId: String(row.instance_id),
    providerId: String(row.provider_id),
    serviceEnvironment: String(row.service_environment),
    installationId: String(row.installation_id),
    providerRepositoryId: String(row.provider_repository_id),
    repositoryId: String(row.repository_id),
    owner: String(row.owner_name),
    name: String(row.repository_name),
    defaultBranch: String(row.default_branch),
    status: row.status,
    verifiedAt: new Date(row.verified_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    providerReceipt: typeof row.provider_receipt === "string"
      ? JSON.parse(row.provider_receipt)
      : row.provider_receipt,
  };
}
