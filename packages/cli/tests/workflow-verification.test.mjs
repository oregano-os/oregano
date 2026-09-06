import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../runtime/canonical.ts";
import { parseWorkflowVerificationState, verifyWorkflowResponse, verifyLiveWorkflow } from "../src/workflow-verification.mjs";

const state = () => ({ schema_version: 1, scope: "workflow", instance_id: "example-preview", workflow_id: "review-items", run_id: `workflow:${"1".repeat(64)}`,
  artifact_hash: "2".repeat(64), manifest_hash: "3".repeat(64), core_commit: "4".repeat(40), workspace_commit: "5".repeat(40),
  deployment: { id: "dpl_example", url: "https://example-preview.vercel.app", environment: "preview", protection_secret_ref: "env:TEST_PROTECTION" },
  operator_secret_ref: "env:TEST_OPERATOR", expected_approvers: ["slack:T10001:U10002"] });
const response = () => {
  const value = state();
  const codes = ["pinned-run-identity", "completed-run", "bounded-audit", "opening-receipt", "complete-state-journal", "durable-wait", "human-decision",
    "record-source-completeness", "successful-effect", "guard-receipt", "publication-receipt", "consumed-bound-approval", "complete-batch-receipts", "distinct-effect-and-approval-identities"];
  const proof = { schemaVersion: 1, scope: "workflow-run-evidence", instanceId: value.instance_id, workflowId: value.workflow_id, runId: value.run_id,
    artifactHash: value.artifact_hash, manifestHash: value.manifest_hash, coreCommit: value.core_commit, workspaceCommit: value.workspace_commit,
    environment: "preview", revision: 5, checks: codes.map((code) => ({ code, passed: true })), counts: { waits: 1, decisions: 1, batches: 1, effects: 1, sourceProofs: 1 },
    approvingPrincipals: value.expected_approvers, syntheticEvidence: false, receipts: [{ stepId: "apply", effectKey: `workflow:${"6".repeat(64)}`, inputDigest: "7".repeat(64), outputDigest: "8".repeat(64), approvalId: "example-approval" }],
    sourceProofs: [{ stepId: "read", digest: "9".repeat(64), requiredThrough: "2030-01-04T16:00:00.000Z", snapshotId: "a".repeat(64),
      sources: [{ sourceId: "example-source", sourceDigest: "b".repeat(64), syncRunId: "example-sync", syncedThrough: "2030-01-04T16:00:00.000Z", watermarkDigest: "c".repeat(64) }] }] };
  return { ok: true, verification: { ...proof, ok: true, evidenceDigest: sha256(proof) }, deployment: { id: value.deployment.id, coreCommit: value.core_commit, artifactHash: value.artifact_hash, environment: "preview" } };
};
const resign = (body) => { const { ok, evidenceDigest, ...value } = body.verification; body.verification.evidenceDigest = sha256(value); return body; };

test("workflow live verification sends only an authenticated read to the exact protected origin", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-verification-")), path = join(directory, "state.json");
  try {
    writeFileSync(path, JSON.stringify(state()));
    const result = await verifyLiveWorkflow({ statePath: path, environment: { TEST_OPERATOR: "x".repeat(48), TEST_PROTECTION: "y".repeat(48) },
      fetchImpl: async (url, options) => {
        assert.equal(String(url), "https://example-preview.vercel.app/api/workflows/operator");
        assert.equal(options.method, "POST"); assert.equal(options.redirect, "error");
        assert.deepEqual(JSON.parse(options.body), { action: "verify", runId: state().run_id });
        assert.equal(options.headers.authorization, `Bearer ${"x".repeat(48)}`);
        assert.equal(options.headers["x-vercel-protection-bypass"], "y".repeat(48));
        return Response.json(response());
      } });
    assert.equal(result.verification.ok, true);
    assert.equal(result.verification.scope, "live-workflow-instance");
    assert.equal(JSON.stringify(result).includes("x".repeat(48)), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("fresh proof must match source, run, deployment and exact human identities", () => {
  for (const field of ["instanceId", "workflowId", "runId", "artifactHash", "manifestHash", "coreCommit", "workspaceCommit", "environment"]) {
    const body = response(); body.verification[field] = "different"; resign(body);
    assert.throws(() => verifyWorkflowResponse(state(), body), /exact candidate/);
  }
  const otherDeployment = response(); otherDeployment.deployment.id = "dpl_other";
  assert.throws(() => verifyWorkflowResponse(state(), otherDeployment), /exact candidate/);
  const human = response(); human.verification.approvingPrincipals = ["slack:T10001:U99999"]; resign(human);
  assert.throws(() => verifyWorkflowResponse(state(), human), /expected human/);
});

test("synthetic, missing and tampered checks cannot become live acceptance", () => {
  const synthetic = response(); synthetic.verification.syntheticEvidence = true; resign(synthetic);
  assert.throws(() => verifyWorkflowResponse(state(), synthetic), /Synthetic/);
  const tampered = response(); tampered.verification.counts.waits = 2;
  assert.throws(() => verifyWorkflowResponse(state(), tampered), /digest/);
  const extra = response(); extra.verification.receipts[0].provider_body = "unreviewed provider content"; resign(extra);
  assert.throws(() => verifyWorkflowResponse(state(), extra), /unsupported fields/);
  for (const code of ["durable-wait", "record-source-completeness", "consumed-bound-approval", "complete-batch-receipts"]) {
    const missing = response(); missing.verification.checks = missing.verification.checks.filter((entry) => entry.code !== code); resign(missing);
    assert.throws(() => verifyWorkflowResponse(state(), missing), /required successful evidence check/);
  }
});

test("failed live evidence reports bounded check codes without echoing provider payloads", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-verification-")), path = join(directory, "state.json");
  try {
    writeFileSync(path, JSON.stringify(state()));
    const result = await verifyLiveWorkflow({ statePath: path, environment: { TEST_OPERATOR: "x".repeat(48), TEST_PROTECTION: "y".repeat(48) },
      fetchImpl: async () => Response.json({ verification: { checks: [{ code: "consumed-bound-approval", passed: false }, { code: "private provider body!", passed: false }] }, private_body: "private provider body" }, { status: 409 }) });
    assert.equal(result.verification.ok, false);
    assert.match(result.diagnostics[0].message, /consumed-bound-approval/);
    assert.equal(JSON.stringify(result).includes("private provider body"), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("verification state rejects credential URLs, alternate action fields and unscoped protection secrets", () => {
  for (const url of ["http://example-preview.vercel.app", "https://person:password@example-preview.vercel.app", "https://example-preview.vercel.app/?token=secret", "https://example-preview.vercel.app/elsewhere"]) {
    const value = state(); value.deployment.url = url;
    assert.throws(() => parseWorkflowVerificationState(value), /HTTPS origin/);
  }
  const external = state(); external.deployment.url = "https://unrelated.example";
  assert.throws(() => parseWorkflowVerificationState(external), /protection credentials/);
  const action = { ...state(), action: "resume" };
  assert.throws(() => parseWorkflowVerificationState(action), /unsupported fields/);
});

test("provider failures and oversized responses disclose no credential or raw provider body", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-verification-")), path = join(directory, "state.json");
  try {
    writeFileSync(path, JSON.stringify(state()));
    for (const fetchImpl of [async () => { throw new Error(`private provider message ${"x".repeat(48)}`); }, async () => new Response("private provider body", { status: 401 }), async () => new Response("x".repeat(1_048_577))]) {
      const result = await verifyLiveWorkflow({ statePath: path, environment: { TEST_OPERATOR: "x".repeat(48), TEST_PROTECTION: "y".repeat(48) }, fetchImpl });
      assert.equal(result.verification.ok, false);
      assert.equal(JSON.stringify(result).includes("private provider"), false);
      assert.equal(JSON.stringify(result).includes("x".repeat(48)), false);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
