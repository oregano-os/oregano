import { randomUUID } from "node:crypto";
import type { CompanyOSArtifact } from "../../../companyos-builder/types.ts";
import type { JsonValue } from "../../../capabilities/contracts.ts";
import type { CompanyRecordsStore } from "../../../state-store/records.ts";
import { synchronizeRecordSnapshot } from "../../../records/synchronization.ts";
import { createPostgresCompanyRecordsStore, inspectPostgresCompanyRecordSyncReceipt } from "../../../state-postgres/records-store.ts";
import { resolveCompanyRecordsConfiguration } from "./runtime-connectors.ts";
import { validatedCompanyRecordsSelection } from "./company-records-rehearsal.ts";

export function selectWorkflowRecordSource(artifact: CompanyOSArtifact, sourceId: string, environment: NodeJS.ProcessEnv = process.env) {
  const configurations = (artifact.connectors ?? []).filter((entry) => entry.connector === "oregano/company-records").map((entry) => {
    if (!entry.configuration.configuration_snapshot) throw new Error("Workflow source synchronization requires the retained non-secret Records snapshot");
    return resolveCompanyRecordsConfiguration(entry, artifact, environment);
  });
  const matching = configurations.filter((configuration) => configuration.sources.some((source) => source.id === sourceId));
  if (matching.length !== 1) throw new Error("Workflow source must resolve to exactly one retained Records configuration");
  return validatedCompanyRecordsSelection(matching[0]!, sourceId);
}

export function createWorkflowRecordSynchronizer(dependencies: {
  store?: CompanyRecordsStore;
  inspectReceipt?: typeof inspectPostgresCompanyRecordSyncReceipt;
  select?: typeof selectWorkflowRecordSource;
  clock?: () => Date;
} = {}) {
  const store = dependencies.store ?? createPostgresCompanyRecordsStore();
  const inspectReceipt = dependencies.inspectReceipt ?? inspectPostgresCompanyRecordSyncReceipt;
  return async (artifact: CompanyOSArtifact, sourceId: string, jobId: string): Promise<JsonValue> => {
    const selected = (dependencies.select ?? selectWorkflowRecordSource)(artifact, sourceId);
    const runId = `workflow-records:${jobId}`, instanceId = artifact.instance.id;
    const prior = await inspectReceipt(instanceId, selected.registry.sourceStorageId(sourceId), runId);
    if (prior) {
      if (prior.errors !== 0) throw new Error("Previous workflow source synchronization did not complete successfully");
      return { source_id: sourceId, source_digest: selected.registry.sourceDigest(sourceId), run_id: runId, reused: true, watermark: prior.watermark ?? null };
    }
    const connector = selected.connectors.resolve(selected.binding);
    const inventory = await connector.readCompleteInventory({ source: selected.source, binding: selected.binding, qualification: selected.qualification });
    const now = dependencies.clock?.() ?? new Date();
    const receipt = await synchronizeRecordSnapshot({ instanceId, source: selected.source, inventory, registry: selected.registry, store, runId,
      leaseOwner: "workflow-records", leaseToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + 300_000).toISOString() });
    return { source_id: sourceId, source_digest: receipt.source_digest, run_id: runId, watermark: receipt.watermark,
      observed: receipt.observed, errors: receipt.errors, ...(receipt.synced_through ? { synced_through: receipt.synced_through } : {}) };
  };
}
