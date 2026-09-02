import { createHash } from "node:crypto";
import { CompanyRecordsRehearsalError } from "../../../../lib/company-records-rehearsal.ts";
import {
  authorizeCompanyRecordsScheduler,
  decodeCompanyRecordsProductionConfiguration,
  runCompanyRecordsScheduledReconciliation,
} from "../../../../lib/company-records-production.ts";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const errorDigest = (value: unknown): string => createHash("sha256")
  .update(value instanceof Error ? value.message : String(value))
  .digest("hex");

export async function GET(request: Request) {
  if (!authorizeCompanyRecordsScheduler(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const configuration = decodeCompanyRecordsProductionConfiguration();
    const result = await runCompanyRecordsScheduledReconciliation({ configuration });
    return Response.json(result, { status: result.ok ? 200 : 503 });
  } catch (error) {
    if (error instanceof CompanyRecordsRehearsalError) {
      console.error(JSON.stringify({ event: "company-records.reconciliation.rejected", reason: error.code, errorDigest: errorDigest(error) }));
      return Response.json({ ok: false, error: error.code, errorDigest: errorDigest(error) }, { status: error.status });
    }
    console.error(JSON.stringify({ event: "company-records.reconciliation.failed", errorDigest: errorDigest(error) }));
    return Response.json({ ok: false, error: "records-reconciliation-failed", errorDigest: errorDigest(error) }, { status: 503 });
  }
}
