import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fixtureCompanyTools } from "../company-tool-fixture.ts";

// Synthetic acceptance cases preserved from the reviewed reference Workspace.
const execute = fixtureCompanyTools(resolve(import.meta.dirname, "lindenhof-studio/agents/sprint/tools"));

const regressions = JSON.parse(readFileSync(resolve(import.meta.dirname, "workflow-computation-regressions.json"), "utf8"));
for (const [index, fixture] of regressions.cases.entries()) {
  test(`frozen computation regression ${index + 1}: ${fixture.tool_id}`, async () => {
    assert.deepEqual(await execute(fixture.tool_id, fixture.input), fixture.expected);
  });
}

const row = (values: any, id = values.work_item_id ?? values.participant_id ?? "record") => ({ record_id: id, values });
const person = (id: string, name = id, included = true) => row({ participant_id: id, display_name: name, included });
const item = (id: string, owners = ["a"], extra = {}) => row({ work_item_id: id, assignee_ids: owners, title: id,
  url: `https://example.com/items/${id}`, provider_version: "v1", status: "Planned", fields: { brief: "Ready", estimate: 0 }, ...extra });
const closeInput = (submissions: any[] = []) => ({ participants: [person("a"), person("absent", "Absent", false)],
  work_items: [item("one")], submissions, cutoff: "2030-01-04T17:00:00Z", closed_statuses: ["Done"], thread_reference: "test-thread" });
const submission = (id: string, tasks: string[], instant = "2030-01-04T16:00:00Z", wellFormed = true) => row({
  participant_id: "a", content_participant_id: "a", task_ids: tasks, accepted_at: instant, well_formed: wellFormed }, id);

test("close: missing response preserves the actual thread and excludes an approved absence", async () => {
  const result = await execute("close-classification", closeInput());
  assert.deepEqual(result.states, { a: "missing" });
  assert.equal(result.thread_reference, "test-thread");
  assert.deepEqual(result.incomplete, ["a"]);
});
test("close: exact task-set equality rejects extra or omitted tasks", async () => {
  for (const tasks of [["one", "extra"], []]) {
    assert.equal((await execute("close-classification", closeInput([submission("s", tasks)]))).states.a, "needs-reformat");
  }
  assert.equal((await execute("close-classification", closeInput([submission("s", ["one", "one"])]))).states.a, "complete");
});
test("close: latest timely response wins; late corrections cannot rewrite the cutoff", async () => {
  const input = closeInput([submission("first", []), submission("second", ["one"], "2030-01-04T17:00:00Z"),
    submission("late", [], "2030-01-04T17:00:01Z")]);
  assert.equal((await execute("close-classification", input)).states.a, "complete");
  input.submissions = [submission("bad-format", ["one"], "2030-01-04T16:00:00Z", false)];
  assert.equal((await execute("close-classification", input)).states.a, "needs-reformat");
});
test("close: no committed tasks still require a well-formed empty submission; closed work does not roll over", async () => {
  const input = closeInput([submission("s", [])]);
  input.work_items = [item("closed", ["other"], { status: "Done" })];
  const result = await execute("close-classification", input);
  assert.equal(result.states.a, "complete");
  assert.deepEqual(result.open_work_items, []);
});

test("close preserves provider precision at the cutoff and between same-millisecond replies", async () => {
  const afterCutoff = closeInput([submission("late", ["one"], "2030-01-04T17:00:00.000001Z")]);
  assert.equal((await execute("close-classification", afterCutoff)).states.a, "missing");
  const latest = closeInput([submission("z-earlier", [], "2030-01-04T16:00:00.000001Z"), submission("a-later", ["one"], "2030-01-04T17:00:00.000002+01:00")]);
  assert.equal((await execute("close-classification", latest)).states.a, "complete");
});
test("rollover: freezes every expected version and target in a deterministic complete batch", async () => {
  const result = await execute("rollover-changes", { target_sprint_id: "next", open_work_items: [
    { work_item_id: "b", provider_version: "v2" }, { work_item_id: "a", provider_version: "v1" }] });
  assert.deepEqual(result, { outcome: "some", updates: [
    { work_item_id: "a", expected_version: "v1", changes: { sprint: "next" } },
    { work_item_id: "b", expected_version: "v2", changes: { sprint: "next" } }] });
  assert.deepEqual(await execute("rollover-changes", { target_sprint_id: "next", open_work_items: [] }), { outcome: "none", updates: [] });
});
test("readiness: unchanged incomplete candidates, zero values, invalidation, and one question per owner", async () => {
  const result = await execute("readiness-view", { ready_status: "Ready", planned_status: "Planned", required_fields: ["brief", "estimate"],
    work_items: [item("b", ["a"], { fields: {} }), item("a", ["a"], { fields: {}, status: "Ready" }),
      item("c"), item("d", [], { status: "Ready" }), item("e", ["a", "b"])] });
  assert.deepEqual(result.summary, { candidate_count: 5, ready_count: 1, missing_count: 4 });
  assert.deepEqual(result.questions, [{ participant_id: "a", work_item_id: "a", missing_fields: ["brief", "estimate"], question: "Please complete item a: brief, estimate." }]);
  assert.deepEqual(result.updates, [
    { work_item_id: "a", expected_version: "v1", changes: { status: "Planned" } },
    { work_item_id: "c", expected_version: "v1", changes: { status: "Ready" } },
    { work_item_id: "d", expected_version: "v1", changes: { status: "Planned" } }]);
});
test("readiness: an already correct label produces no batch; empty array is a missing field", async () => {
  const base = { ready_status: "Ready", planned_status: "Planned", required_fields: ["brief"] };
  assert.equal((await execute("readiness-view", { ...base, work_items: [item("a", ["a"], { status: "Ready" })] })).outcome, "none");
  assert.equal((await execute("readiness-view", { ...base, work_items: [item("a", ["a"], { fields: { brief: [] } })] })).summary.missing_count, 1);
});
test("handoff: current board only; stable shared, empty and unmatched sections, unique counts", async () => {
  const input = { participants: [person("b", "Bob"), person("c", "Cara"), person("a", "Alice"), person("excluded", "Excluded", false)],
    work_items: [item("shared", ["b", "a"]), item("unassigned", []), item("single", ["a"]), item("unmatched", ["excluded"])] };
  const result = await execute("monday-handoff-view", input);
  assert.deepEqual(result.groups.map((group: any) => [group.participant_id, group.work_items.map((work: any) => [work.work_item_id, work.shared])]),
    [["a", [["shared", true], ["single", false]]], ["b", [["shared", true]]], ["c", []]]);
  assert.deepEqual(result.unassigned_work_items.map((work: any) => work.work_item_id), ["unassigned", "unmatched"]);
  assert.equal(result.unique_work_item_count, 4);
  assert.equal(result.participant_count, 3);
  assert.equal(result.unassigned_count, 2);
  assert.match(result.work_items_by_contributor, /### Cara\n\nNo current Sprint items/);
  assert.deepEqual(await execute("monday-handoff-view", { participants: [...input.participants].reverse(), work_items: [...input.work_items].reverse() }), result);
});
test("handoff: missing required row data fails; unsafe provider URLs and duplicate identities fail closed", async () => {
  await assert.rejects(execute("monday-handoff-view", { participants: [row({ participant_id: "a", included: true })], work_items: [] }), /display_name/);
  await assert.rejects(execute("monday-handoff-view", { participants: [], work_items: [item("a", [], { url: "javascript:alert(1)" })] }), /invalid values/);
  await assert.rejects(execute("monday-handoff-view", { participants: [person("a"), person("a")], work_items: [] }), /Duplicate participant/);
  assert.equal((await execute("monday-handoff-view", { participants: [], work_items: [] })).work_items_by_contributor, "No current Sprint items");
});
test("triage: groups single owners once and preserves candidate ids through the grace recheck", async () => {
  const result = await execute("stale-item-triage", { planned_status: "Planned", work_items: [item("b"), item("a"), item("c", [], { status: "Ready" })] });
  assert.deepEqual(result.nudges, [{ participant_id: "a", work_item_ids: ["a", "b"], items_text: "a, b" }]);
  assert.deepEqual(result.candidate_ids, ["a", "b", "c"]);
  assert.deepEqual(result.updates, [{ work_item_id: "c", expected_version: "v1", changes: { status: "Planned" } }]);
});
test("typed rows and duplicate versions cannot be silently dropped by computation", async () => {
  await assert.rejects(execute("readiness-view", { ready_status: "Ready", planned_status: "Planned", required_fields: [],
    work_items: [row({ work_item_id: "a", status: "Ready", provider_version: "v1", assignee_ids: ["a"] })] }), /fields/);
  await assert.rejects(execute("rollover-changes", { target_sprint_id: "next", open_work_items: [
    { work_item_id: "a", provider_version: "v1" }, { work_item_id: "a", provider_version: "v2" }] }), /Duplicate work item/);
});


test("close presentation is factual, uses display names and handles equivalent timestamp offsets", async () => {
  const input = closeInput([submission("answer", ["one"], "2030-01-04T18:00:00+01:00")]);
  input.participants = [person("a", "Alex & Sam")];
  const result = await execute("close-classification", input);
  assert.equal(result.states.a, "complete");
  assert.equal(result.report_text, "- Alex &amp; Sam: complete");
  assert.equal(result.open_items_text, "- one");
  assert.doesNotMatch(result.report_text, /provider_version|record_id/);
  await assert.rejects(execute("close-classification", { ...input, participants: [person("a"), person("a")] }), /Duplicate participant/);
});

test("the handoff grouping Tool also renders the selected activity rows without inventing current scope", async () => {
  const result = await execute("monday-handoff-view", { participants: [person("a", "Alex")], work_items: [], empty_message: "No changed Sprint items" });
  assert.equal(result.work_items_by_contributor, "### Alex\n\nNo changed Sprint items");
  assert.equal(result.unique_work_item_count, 0);
});

const directoryMember = (id: string, extra = {}) => ({ member_id: id, display_name: id, type: "human", status: "active", group_ids: ["contributors"], principals: [`chat:fixture:${id}`], ...extra });
const participantInput = () => ({
  directory: { directory_digest: "a".repeat(64), members: [directoryMember("b"), directoryMember("a"),
    directoryMember("retired", { status: "inactive" }), directoryMember("robot", { type: "agent" }), directoryMember("outside", { group_ids: [] })] },
  roles: [row({ person_ids: ["a", "b", "unresolved:monday:fixture:unknown"], role: "Delivery", lifecycle_state: "active" }, "role-one"),
    row({ person_ids: ["a"], role: "Design", lifecycle_state: "active" }, "role-two")],
  group_id: "contributors", communication_prefix: "chat:fixture:", excluded_ids: ["b"],
});
test("participants: reviewed cohort, exact identity joins, role aggregation and explicit absence", async () => {
  const input = participantInput();
  const result = await execute("participant-view", input);
  assert.deepEqual(result.rows.map((value: any) => value.values.participant_id), ["a", "b"]);
  assert.deepEqual(result.rows[0].values.roles, ["Delivery", "Design"]);
  assert.deepEqual(result.rows[0].values.role_record_ids, ["role-one", "role-two"]);
  assert.equal(result.rows[0].values.communication_principal, "chat:fixture:a");
  assert.equal(result.rows[0].values.included, true);
  assert.equal(result.rows[1].values.included, false);
  assert.equal(result.rows[1].values.approved_absence, true);
  assert.equal(result.directory_digest, input.directory.directory_digest);
  assert.deepEqual((await execute("participant-view", { ...input, roles: [...input.roles].reverse(), directory: { ...input.directory, members: [...input.directory.members].reverse() } })), result);
  const close = await execute("close-classification", { ...closeInput(), participants: result.rows });
  assert.deepEqual(close.states, { a: "missing" });
  const handoff = await execute("monday-handoff-view", { participants: result.rows, work_items: [item("one")] });
  assert.equal(handoff.participant_count, 1);
});
test("participants: missing role, ambiguous contact, unknown exclusion and malformed role rows fail", async () => {
  const noRoles = participantInput(); noRoles.roles = [];
  await assert.rejects(() => execute("participant-view", noRoles), /no verified role/);
  const noContact = participantInput(); noContact.directory.members[0].principals = [];
  await assert.rejects(() => execute("participant-view", noContact), /exactly one configured communication/);
  const ambiguous = participantInput(); ambiguous.directory.members[0].principals.push("chat:fixture:second");
  await assert.rejects(() => execute("participant-view", ambiguous), /exactly one configured communication/);
  const unknown = participantInput(); unknown.excluded_ids.push("not-in-roster");
  await assert.rejects(() => execute("participant-view", unknown), /not an eligible participant/);
  const malformed = participantInput(); delete (malformed.roles[0].values as any).person_ids;
  await assert.rejects(() => execute("participant-view", malformed), /Input participant-view/);
});


test("close rejects content changed by another or unidentified editor", async () => {
  for (const editor of ["another-member", "unresolved:slack-unknown:fixture:editor"]) {
    const answer = submission("edited", ["one"]);
    answer.values.content_participant_id = editor;
    assert.equal((await execute("close-classification", closeInput([answer]))).states.a, "needs-reformat");
  }
});

test("close effort uses the explicitly selected basis, excludes absences from totals and preserves unknown evidence", async () => {
  const input = { ...closeInput(), participants: [person("a"), person("b"), person("absent", "Absent", false)],
    work_items: [item("one", ["a"], { actual_hours: 3.5, planned_effort: 4 }), item("two", ["b"], { actual_hours: 2, planned_effort: 6 }),
      item("three", ["absent"], { actual_hours: 8, planned_effort: 10 })] };
  const actual = await execute("close-classification", { ...input, effort: "actual-hours" });
  assert.equal(actual.effort_basis, "actual-hours"); assert.equal(actual.total_effort_hours, 5.5);
  assert.deepEqual(actual.participant_effort_hours, { a: 3.5, b: 2, absent: 8 });
  const planned = await execute("close-classification", { ...input, effort: "planned-effort" });
  assert.equal(planned.effort_basis, "planned-effort"); assert.equal(planned.total_effort_hours, 10);
  const samePlannedValues = await execute("close-classification", { ...input, effort: "planned-effort",
    work_items: input.work_items.map((row: any) => ({ ...row, values: { ...row.values, planned_effort: row.values.actual_hours } })) });
  assert.equal(samePlannedValues.total_effort_hours, 5.5);
  for (const effort of [undefined, "unavailable"]) {
    const unavailable = await execute("close-classification", { ...input, ...(effort ? { effort } : {}) });
    assert.equal(unavailable.effort_basis, "unavailable");
    assert.equal(unavailable.total_effort_hours, null);
    assert.deepEqual(unavailable.participant_effort_hours, { a: null, b: null, absent: null });
    assert.equal(unavailable.effort_text, "unavailable");
  }
  delete input.work_items[0].values.actual_hours;
  const missing = await execute("close-classification", { ...input, effort: "actual-hours" });
  assert.equal(missing.participant_effort_hours.a, null); assert.equal(missing.total_effort_hours, null);
  assert.equal(missing.effort_text, "actual-hours: unavailable");
});

test("close effort keeps measured zero separate from missing input and validates its explicit numeric evidence", async () => {
  const input = { ...closeInput(), work_items: [item("one", ["a"], { actual_hours: 0, planned_effort: null })] };
  assert.equal((await execute("close-classification", { ...input, effort: "actual-hours" })).total_effort_hours, 0);
  assert.equal((await execute("close-classification", { ...input, effort: "planned-effort" })).total_effort_hours, null);
  for (const actual_hours of ["3.5", {}, []]) {
    await assert.rejects(execute("close-classification", { ...input, effort: "actual-hours", work_items: [item("one", ["a"], { actual_hours })] }), /actual_hours|number/);
  }
  await assert.rejects(execute("close-classification", { ...input, effort: "estimate" }), /effort|enum/);
  assert.equal((await execute("close-classification", { ...input, participants: [], work_items: [] })).total_effort_hours, null);
  assert.equal((await execute("close-classification", { ...input, participants: [], work_items: [], effort: "actual-hours" })).total_effort_hours, 0);
});
