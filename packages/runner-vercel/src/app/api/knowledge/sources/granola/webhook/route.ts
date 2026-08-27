import { after } from "next/server";
import { createHash } from "node:crypto";
import { GranolaKnowledgeSourceRuntime } from "../../../../../../lib/knowledge-source-runtime.ts";

export const runtime = "nodejs";
export const maxDuration = 300;

const errorDigest = (value: string) => createHash("sha256").update(value).digest("hex");

export async function POST(request: Request) {
  try {
    const source = new GranolaKnowledgeSourceRuntime();
    const rawBody = new Uint8Array(await request.arrayBuffer());
    const accepted = await source.acceptWebhook({ rawBody, headers: Object.fromEntries(request.headers), observedAt: new Date().toISOString() });
    after(async () => { await source.processEvents({ eventIds: accepted.eventIds, requirement: accepted.requirement, connector: accepted.connector }); });
    return Response.json({ ok: true, accepted: accepted.accepted, duplicate: accepted.duplicate, receiptId: accepted.receiptId }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /signature|webhook|replay|timestamp|body/i.test(message) ? 400 : 503;
    return Response.json({ ok: false, error: status === 400 ? "invalid-delivery" : "webhook-unavailable", errorDigest: errorDigest(message) }, { status });
  }
}
