import { protectProductionWorker } from "../../../../lib/production-worker-gate.ts";
import { handleWorkflowWorker } from "../../../../lib/workflow-http.ts";
export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const GET = protectProductionWorker((request: Request) => handleWorkflowWorker(request, "records"));
