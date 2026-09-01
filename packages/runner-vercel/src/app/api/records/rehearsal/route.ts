import { createHash } from "node:crypto";
import {
  authorizeCompanyRecordsRehearsal,
  CompanyRecordsRehearsalError,
  decodeCompanyRecordsRehearsalConfiguration,
  executeCompanyRecordsRehearsal,
  parseCompanyRecordsRehearsalRequest,
} from "../../../../lib/company-records-rehearsal.ts";

export const runtime = "nodejs";
export const maxDuration = 300;

const errorDigest = (value: unknown): string => createHash("sha256")
  .update(value instanceof Error ? value.message : String(value))
  .digest("hex");

export async function POST(request: Request) {
  if (!authorizeCompanyRecordsRehearsal(request)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > 4_096) return Response.json({ ok: false, error: "request-too-large" }, { status: 413 });
    const input = parseCompanyRecordsRehearsalRequest(JSON.parse(raw));
    const configuration = decodeCompanyRecordsRehearsalConfiguration();
    const result = await executeCompanyRecordsRehearsal(input, configuration);
    return Response.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    if (error instanceof CompanyRecordsRehearsalError) {
      console.error(JSON.stringify({ event: "company-records.rehearsal.rejected", reason: error.code, errorDigest: errorDigest(error) }));
      return Response.json({ ok: false, error: error.code, errorDigest: errorDigest(error) }, { status: error.status });
    }
    console.error(JSON.stringify({ event: "company-records.rehearsal.failed", errorDigest: errorDigest(error) }));
    return Response.json({ ok: false, error: "rehearsal-failed", errorDigest: errorDigest(error) }, { status: 503 });
  }
}
