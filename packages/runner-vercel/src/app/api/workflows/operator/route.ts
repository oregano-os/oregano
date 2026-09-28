import { handleWorkflowOperator } from "../../../../lib/workflow-http.ts";
export const runtime = "nodejs";
export const maxDuration = 600;
export const dynamic = "force-dynamic";
export const POST = handleWorkflowOperator;
