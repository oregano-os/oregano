import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { engineArtifact, engineFixture, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";
import { completedVerificationFixture } from "../fixtures/workflow-verification-fixture.ts";
import { verifyCompletedWorkflow } from "../../runtime/workflow-engine/verification.ts";
import { validateWorkflowFiles } from "../../companyos-builder/workflow-authoring.ts";
import { readWorkspaceFiles, workspaceDocument } from "../../companyos-builder/workspace-files.ts";
import { RecordScanPendingError } from "../../records/current-scan.ts";
import { CapabilityEffectOutcomeUnknownError } from "../../capabilities/contracts.ts";
import { sha256 } from "../../runtime/canonical.ts";

const closePath = "workflows/friday-close.compact.md";
async function pendingFixture(root: string, error?: Error) {
  const path = join(root, closePath), { data } = workspaceDocument(readWorkspaceFiles(root), closePath);
  data.steps = [{ inventory: "oregano:records/query", input: { projection_id: "sprint-work-items" }, all_pages: true, require_scan_started_after: "$trigger.instant" }];
  writeFileSync(path, `---\n${YAML.stringify(data)}---\n# Pending inventory\n\n1. [sprint, R0] Read the complete inventory. <!-- step:inventory -->\n`);
  let ready = false;
  const h = engineFixture({ artifact: engineArtifact("pending-scan", root), recordsConnector: {
    id: "test/engine", version: "1.0.0", capabilities: ["records.query"], async invoke(_, raw) {
      const input = raw as Record<string, string>;
      if (!ready) throw error ?? new RecordScanPendingError(input.projection_id!, input.require_scan_started_after!, "A complete current scan is pending");
      const rows: [] = [], digest = sha256(rows);
      return { output: { projection_id: input.projection_id!, rows, observed_at: h.now, fresh_until: h.now,
        snapshot_id: digest, scan_started_at: input.require_scan_started_after!, source_proofs: [],
        source_scan_proofs: [{ source_id: "synthetic", source_digest: digest, run_id: "synthetic-sync",
          scan_started_at: input.require_scan_started_after!, scan_completed_at: h.now, inventory_digest: digest, watermark: "synthetic" }],
        access_decision: { allowed: true, projection_id: input.projection_id!, principal_id: ENGINE_OPERATOR, policy_digest: "synthetic", reason: "role-allowed", decided_at: h.now },
      }, evidence: { synthetic: true } };
    },
  } });
  const opened = await h.engine().openOperator({ workflowId: "friday-close", requestId: "pending-scan", principal: ENGINE_OPERATOR, fields: { sprint_id: "one", next_sprint_id: "two" } });
  return { h, opened, ready: () => { ready = true; } };
}

test("pending complete scans survive restart and timer repair, preserving the original read exactly once", async () => withCurrentWorkspace(async root => {
  const { h, opened, ready } = await pendingFixture(root);
  let run = (await h.engine().advance(opened.runId))!;
  assert.equal(run.state.blocked, undefined); assert.equal(run.state.wait?.kind, "records");
  const input = structuredClone(h.calls[0]!.input), digest = run.state.steps.inventory!.inputDigest;
  assert.equal(h.calls.length, 1);
  // Simulate the host losing the schedule write after the durable run commit.
  (h.timerStore as any).rows.clear();
  await h.engine().repairTimers();
  h.now = run.state.wait!.dueAt;
  assert.equal((await h.engine().timers()).completed, 1);
  run = (await h.engine().advance(opened.runId))!;
  assert.equal(run.state.wait?.kind, "records");
  assert.deepEqual(h.calls[1]!.input, input);
  ready(); h.now = run.state.wait!.dueAt;
  await h.engine().timers(); run = (await h.engine().advance(opened.runId))!;
  assert.equal(run.state.status, "done"); assert.equal(run.state.logicalInstant, opened.state.logicalInstant);
  assert.equal(run.state.steps.inventory!.inputDigest, digest);
  assert.deepEqual(h.calls[2]!.input, input);
  await h.engine().timers(); await h.engine().advance(opened.runId);
  assert.equal(h.calls.length, 3, "duplicate ticks do not repeat the successful read");
  assert.ok(h.calls.every(call => call.capability === "records.query"), "waiting never dispatches a provider effect");
}));

test("pending complete scans stop after a bounded wait without inventing evidence", async () => withCurrentWorkspace(async root => {
  const { h, opened } = await pendingFixture(root);
  await h.engine().advance(opened.runId);
  h.now = "2030-01-04T14:45:00.000Z";
  await h.engine().timers();
  const run = (await h.engine().advance(opened.runId))!;
  assert.equal(run.state.blocked?.code, "step-failed"); assert.equal(run.state.wait, undefined);
  assert.equal(run.state.steps.inventory!.output, undefined);
}));

for (const error of [
  new Error("A complete current scan is pending"),
  new Error("Reader cannot access this projection"),
  new Error("Current scan immutable inventory membership is incomplete"),
  new CapabilityEffectOutcomeUnknownError("Provider outcome requires review", { synthetic: true }),
]) test("only the trusted pending-read class is retryable: " + error.message, async () => withCurrentWorkspace(async root => {
  const { h, opened } = await pendingFixture(root, error);
  const run = (await h.engine().advance(opened.runId))!;
  assert.ok(run.state.blocked); assert.equal(run.state.wait, undefined);
  h.now = "2030-01-04T14:31:00.000Z"; await h.engine().timers(); await h.engine().advance(opened.runId);
  assert.equal(h.calls.length, 1);
}));
async function withCurrentWorkspace<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "workflow-current-scan-"));
  try {
    cpSync(resolve(import.meta.dirname, "../fixtures/lindenhof-studio"), root, { recursive: true });
    const path = join(root, closePath);
    writeFileSync(path, readFileSync(path, "utf8").replaceAll("require_synced_through:", "require_scan_started_after:"));
    return await run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("reviewed current-scan requirements reach the actual Runtime and retained workflow verifier", async () => withCurrentWorkspace(async (root) => {
  const artifact = engineArtifact("current-scan-fixture", root);
  const workflow = artifact.workflows!.find((entry) => entry.id === "friday-close")!;
  const steps = workflow.steps.filter((step) => step.requireScanStartedAfter !== undefined);
  assert.equal(steps.length, 5);
  assert.ok(steps.every((step) => step.requireSyncedThrough === undefined));
  const { h, run } = await completedVerificationFixture({ artifact });
  const calls = h.calls.filter((call) => call.capability === "records.query");
  assert.equal(calls.length, 5);
  assert.ok(calls.every((call) => typeof call.input.require_scan_started_after === "string" && call.input.require_synced_through === undefined));
  const proof = await h.engine().verify(run.runId, ENGINE_OPERATOR);
  assert.equal(proof.ok, true, JSON.stringify(proof.checks.filter((check) => !check.passed)));
  assert.equal(proof.syntheticEvidence, true, "synthetic providers never establish live acceptance");
  assert.equal(proof.counts.sourceProofs, 5);
  assert.ok(proof.sourceProofs.every((entry) => "requirement" in entry && entry.requirement === "current-scan" && !("requiredThrough" in entry)));
  assert.equal(proof.counts.decisions, 1);
  assert.equal(proof.counts.batches, 1);
  const callCount = h.calls.length;
  assert.deepEqual(await h.engine().verify(run.runId, ENGINE_OPERATOR), proof);
  assert.equal(h.calls.length, callCount);
}));

test("a late workflow worker retains the original required scan-start deadline", async () => withCurrentWorkspace(async (root) => {
  const h = engineFixture({ artifact: engineArtifact("late-current-scan", root) });
  const run = await h.engine().openOperator({ workflowId: "friday-close", requestId: "late-current-scan", principal: ENGINE_OPERATOR,
    fields: { sprint_id: "current-one", next_sprint_id: "current-two" } });
  await h.engine().advance(run.runId);
  h.now = "2030-01-04T16:30:00.000Z";
  await h.engine().timers(); await h.engine().advance(run.runId);
  await h.engine().timers(); await h.engine().advance(run.runId);
  const calls = h.calls.filter((call) => call.capability === "records.query" && call.input.projection_id === "sprint-close-submissions");
  assert.deepEqual(calls.map((call) => call.input.require_scan_started_after), ["2030-01-04T15:20:00.000Z", "2030-01-04T16:00:00.000Z"]);
  assert.ok(calls.every((call) => call.input.require_scan_started_after !== h.now));
}));

test("workflow authoring rejects conflicting coverage modes and invalid scan references", async () => withCurrentWorkspace(async (root) => {
  const original = readWorkspaceFiles(root);
  assert.deepEqual(validateWorkflowFiles(original), []);
  for (const change of [
    (step: any) => { step.require_synced_through = step.require_scan_started_after; },
    (step: any) => { step.input.require_synced_through = "2030-01-04T16:00:00Z"; },
    (step: any) => { step.require_scan_started_after = "$steps.not-declared.result"; },
    (step: any) => { step.require_scan_started_after = 123; },
  ]) {
    const files = { ...original }, { data, body } = workspaceDocument(files, closePath);
    const step = data.steps.find((entry: any) => entry.require_scan_started_after);
    change(step); files[closePath] = `---\n${YAML.stringify(data)}---\n${body}`;
    assert.ok(validateWorkflowFiles(files).length > 0);
  }
  const files = { ...original }, { data, body } = workspaceDocument(files, closePath);
  data.steps.find((entry: any) => Object.values(entry).includes("wait")).require_scan_started_after = "2030-01-04T16:00:00Z";
  files[closePath] = `---\n${YAML.stringify(data)}---\n${body}`;
  assert.match(JSON.stringify(validateWorkflowFiles(files)), /unknown option/);
}));

test("current workflow verification rejects old, incomplete, repeated and historical-only source evidence", async () => withCurrentWorkspace(async (root) => {
  const { h, run } = await completedVerificationFixture({ artifact: engineArtifact("current-scan-negative", root) });
  for (const change of [
    (output: any) => { output.source_scan_proofs = []; },
    (output: any) => { output.source_scan_proofs[0].scan_started_at = "2030-01-04T15:59:59.999999999Z"; },
    (output: any) => { output.source_scan_proofs[0].scan_completed_at = "2030-01-04T15:59:59.999999999Z"; },
    (output: any) => { output.source_scan_proofs.push(structuredClone(output.source_scan_proofs[0])); },
    (output: any) => { output.source_scan_proofs[0].inventory_digest = "not-a-digest"; },
    (output: any) => { delete output.scan_started_at; output.synced_through = "2099-01-01T00:00:00Z"; },
  ]) {
    const changed = structuredClone(run), output = changed.state.steps["read-submissions-at-report"]!.output;
    change(output);
    const proof = await verifyCompletedWorkflow({ artifact: h.artifact, run: changed, control: h.control });
    assert.equal(proof.checks.find((check) => check.code === "record-current-scan" && check.stepId === "read-submissions-at-report")?.passed, false);
    assert.equal(proof.ok, false);
  }
}));
