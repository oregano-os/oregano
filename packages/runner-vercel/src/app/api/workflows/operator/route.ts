import { handleWorkflowOperator } from "../../../../lib/workflow-http.ts";
export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const POST = handleWorkflowOperator;
