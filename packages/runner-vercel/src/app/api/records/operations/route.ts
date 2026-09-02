import { createHash } from "node:crypto";
import { CompanyRecordsRehearsalError } from "../../../../lib/company-records-rehearsal.ts";
import {
  authorizeCompanyRecordsProductionOperator,
  decodeCompanyRecordsProductionConfiguration,
  executeCompanyRecordsProduction,
  parseCompanyRecordsProductionRequest,
} from "../../../../lib/company-records-production.ts";

export const runtime = "nodejs";
export const maxDuration = 300;

const errorDigest = (value: unknown): string => createHash("sha256")
  .update(value instanceof Error ? value.message : String(value))
  .digest("hex");

export async function POST(request: Request) {
  if (!authorizeCompanyRecordsProductionOperator(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > 4_096) return Response.json({ ok: false, error: "request-too-large" }, { status: 413 });
    const input = parseCompanyRecordsProductionRequest(JSON.parse(raw));
    const configuration = decodeCompanyRecordsProductionConfiguration();
    const result = await executeCompanyRecordsProduction(input, configuration);
    return Response.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    if (error instanceof CompanyRecordsRehearsalError) {
      console.error(JSON.stringify({ event: "company-records.production.rejected", reason: error.code, errorDigest: errorDigest(error) }));
      return Response.json({ ok: false, error: error.code, errorDigest: errorDigest(error) }, { status: error.status });
    }
    console.error(JSON.stringify({ event: "company-records.production.failed", errorDigest: errorDigest(error) }));
    return Response.json({ ok: false, error: "records-operation-failed", errorDigest: errorDigest(error) }, { status: 503 });
  }
}
