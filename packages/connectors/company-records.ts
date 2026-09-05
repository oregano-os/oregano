import type { CapabilityCallContext, CapabilityResult, Connector } from "../capabilities/contracts.ts";
import type { RecordQuery } from "../records/contracts.ts";
import type { CompanyRecordsService } from "../records/service.ts";

export class CompanyRecordsConnector implements Connector {
  readonly id = "oregano/company-records";
  readonly version = "0.1.0";
  readonly capabilities = ["records.query"] as const;
  readonly service: CompanyRecordsService;

  constructor(service: CompanyRecordsService) {
    this.service = service;
  }

  async invoke(capability: string, input: unknown, context: CapabilityCallContext): Promise<CapabilityResult> {
    if (capability !== "records.query") throw new Error(`Company Records Connector does not implement '${capability}'`);
    if (!context.subject) throw new Error("Company Records queries require an authenticated subject");
    const query = input as RecordQuery;
    const result = await this.service.query({
      query,
      subject: {
        principal_id: context.subject.principalId,
        status: context.subject.status,
        roles: [],
        group_ids: context.subject.groupIds,
      },
    });
    return {
      output: result,
      evidence: {
        projection_id: result.projection_id,
        row_count: result.rows.length,
        observed_at: result.observed_at,
        fresh_until: result.fresh_until,
        snapshot_id: result.snapshot_id,
        source_proofs: result.source_proofs,
        ...(result.synced_through ? { synced_through: result.synced_through } : {}),
        access_decision: result.access_decision,
      },
    };
  }
}
