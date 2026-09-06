import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import { engineArtifact, engineFixture, ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { workflowDecisionId } from "../../runtime/workflow-engine/decision-notice.ts";
import type { WorkflowRun } from "../../state-store/workflow-engine.ts";

export const fixtureReply = (id: string, member: string, tasks: string[], at: string, valid = true) => ({ record_id: id,
  values: { participant_id: member, content_participant_id: member, task_ids: tasks, accepted_at: at, well_formed: valid } });

/** A synthetic cohort with one approved absence and both open and closed work.
 * The provider stub has no deduplication. Records coverage is synthetic test data.
 */
export function closeParityFixture() {
  const directory = mkdtempSync(join(tmpdir(), "workflow-conformance-"));
  try {
    cpSync(resolve(import.meta.dirname, "lindenhof-studio"), directory, { recursive: true });
    const path = join(directory, "workflows/sprint/config.yaml"), config = YAML.parse(readFileSync(path, "utf8"));
    config.participants.excluded_ids = ["tim-contributor"];
    writeFileSync(path, YAML.stringify(config));
    const h = engineFixture({ artifact: engineArtifact(undefined, directory) });
    h.items.splice(0, h.items.length, ...[
      { work_item_id: "item-a", title: "Alpha", assignee_ids: ["lea-contributor"], status: "Working", provider_version: "v1" },
      { work_item_id: "item-b", title: "Beta", assignee_ids: ["jonas-owner"], status: "Done", provider_version: "v1" },
      { work_item_id: "item-c", title: "Gamma", assignee_ids: ["tim-contributor"], status: "Working", provider_version: "v1" },
    ].map((value) => ({ record_id: value.work_item_id, values: { ...value, group: "in_sprint", url: `https://example.test/items/${value.work_item_id}` } })));
    h.submissions.push(fixtureReply("reply-a", "lea-contributor", ["item-a"], "2030-01-04T15:30:00.000Z"),
      fixtureReply("reply-b", "jonas-owner", [], "2030-01-04T15:10:00.000Z", false));
    return h;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function openParityClose(h: ReturnType<typeof engineFixture>) {
  const run = await h.engine().openOperator({ workflowId: "friday-close", requestId: randomUUID(), principal: ENGINE_OPERATOR,
    fields: { sprint_id: "test-one", next_sprint_id: "test-two" } });
  return (await h.engine().advance(run.runId))!;
}
export async function wakeParity(h: ReturnType<typeof engineFixture>, runId: string, now: string) {
  h.now = now; await h.engine().timers(); return (await h.engine().advance(runId))!;
}
export async function approveParity(h: ReturnType<typeof engineFixture>, run: WorkflowRun) {
  const decision = run.state.decisions[run.state.cursor!]!;
  await h.engine().decide({ principal: ENGINE_OWNER, conversation: h.conversation("direct-jonas-owner", decision.deliveries["jonas-owner"]!),
    eventId: randomUUID(), requestId: workflowDecisionId(run.runId, decision.stepId, decision.boundDigest), decision: "approved" });
  return (await h.engine().advance(run.runId))!;
}
