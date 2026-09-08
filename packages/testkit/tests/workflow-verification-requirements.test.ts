import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { completedVerificationFixture } from "../fixtures/workflow-verification-fixture.ts";
import { engineArtifact, ENGINE_OPERATOR } from "../workflow-engine-fixture.ts";
import { workspaceDocument } from "../../companyos-builder/workspace-files.ts";
import { parseWorkflowOperatorRequest } from "../../runner-vercel/src/lib/workflow-http.ts";
import { parseWorkflowVerificationRequirements } from "../../runtime/workflow-engine/verification-requirements.ts";
import type { InMemoryStateStore } from "../../runtime/memory-state.ts";

async function fixtureWithout(remove: "batch" | "waits") {
  const root = mkdtempSync(join(tmpdir(), "workflow-required-proof-"));
  try {
    cpSync(resolve(import.meta.dirname, "../fixtures/lindenhof-studio"), root, { recursive: true });
    const relative = "workflows/friday-close.compact.md", path = join(root, relative);
    const document = workspaceDocument({ [relative]: readFileSync(path, "utf8") }, relative);
    const omitted = remove === "batch" ? ["apply-rollover"] : ["await-chase", "await-report"];
    document.data.steps = document.data.steps.filter((step: any) => !omitted.some((id) => id in step));
    if (remove === "batch") document.data.steps.find((step: any) => "approve-rollover" in step).approve = "end";
    let content = `---\n${YAML.stringify(document.data)}---\n${document.body.split("\n").filter((line) => !omitted.some((id) => line.includes(`<!-- step:${id} -->`))).join("\n")}`;
    if (remove === "waits") content = content.replaceAll("$steps.await-chase.instant", "$trigger.instant").replaceAll("$steps.await-report.instant", "$trigger.instant")
      .replaceAll(": await-report", ": work-items-at-report");
    writeFileSync(path, content);
    return await completedVerificationFixture({ artifact: engineArtifact(`proof-without-${remove}`, root) });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("a completed review with no provider write proves selected controls but cannot claim batch acceptance", async () => {
  const { h, run } = await fixtureWithout("batch");
  assert.equal(run.state.status, "done");
  assert.equal(h.calls.some((call) => call.capability === "work-item.batch-update"), false);
  const before = h.calls.length;
  const proof = await h.engine().verify(run.runId, ENGINE_OPERATOR, ["record-source", "human-decision", "wait"]);
  assert.equal(proof.ok, true, JSON.stringify(proof.checks.filter((check) => !check.passed)));
  assert.deepEqual(proof.requirements, ["wait", "human-decision", "record-source"]);
  assert.equal(proof.counts.batches, 0);
  assert.equal(proof.syntheticEvidence, true);
  const strict = await h.engine().verify(run.runId, ENGINE_OPERATOR);
  assert.equal(strict.ok, false);
  assert.equal(strict.checks.find((entry) => entry.code === "required-approved-batch")?.passed, false);
  assert.notEqual(strict.evidenceDigest, proof.evidenceDigest);
  assert.equal(h.calls.length, before);
});

test("an immediate approved batch needs no artificial wait and still checks every consumed approval", async () => {
  const { h, run } = await fixtureWithout("waits");
  const proof = await h.engine().verify(run.runId, ENGINE_OPERATOR, ["human-decision", "record-source", "approved-batch"]);
  assert.equal(proof.ok, true, JSON.stringify(proof.checks.filter((check) => !check.passed)));
  assert.equal(proof.counts.waits, 0);
  assert.equal(proof.counts.batches, 1);
  assert.equal((await h.engine().verify(run.runId, ENGINE_OPERATOR)).ok, false);
  const effect = proof.receipts.find((entry) => entry.approvalId)!;
  const control = h.control as InMemoryStateStore, approval = control.approvals.get(effect.approvalId!)!;
  control.approvals.set(effect.approvalId!, { ...approval, consumed: false });
  const invalid = await h.engine().verify(run.runId, ENGINE_OPERATOR, ["record-source"]);
  assert.equal(invalid.ok, false, "omitting a requirement never skips an executed control");
  assert.equal(invalid.checks.find((entry) => entry.code === "consumed-bound-approval")?.passed, false);
});

test("verification requirements are bounded, explicit, nonempty and read-only", () => {
  const runId = `workflow:${"a".repeat(64)}`;
  assert.deepEqual(parseWorkflowVerificationRequirements(), ["wait", "human-decision", "record-source", "approved-batch"]);
  assert.deepEqual(parseWorkflowOperatorRequest({ action: "verify", runId, requirements: ["record-source", "wait"] }),
    { action: "verify", runId, requirements: ["wait", "record-source"] });
  for (const requirements of [[], null, "wait", ["all"], ["wait", "wait"], ["wait", "human-decision", "record-source", "approved-batch", "wait"]]) {
    assert.throws(() => parseWorkflowVerificationRequirements(requirements), /evidence requirements/);
    assert.throws(() => parseWorkflowOperatorRequest({ action: "verify", runId, requirements }), /evidence requirements/);
  }
  assert.throws(() => parseWorkflowOperatorRequest({ action: "resume", runId, requirements: ["wait"] }), /Unsupported/);
});
