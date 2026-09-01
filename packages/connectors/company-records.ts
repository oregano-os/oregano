import type { CapabilityCallContext, CapabilityResult, Connector, JsonValue } from "../capabilities/contracts.ts";
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
    const query = input as { projection_id: string; filters?: Record<string, unknown>; limit?: number; cursor?: string };
    const result = await this.service.query({
      query: {
        projection_id: query.projection_id,
        filters: query.filters as Record<string, JsonValue> | undefined,
        limit: query.limit,
        cursor: query.cursor,
      },
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
        access_decision: result.access_decision,
      },
    };
  }
}
