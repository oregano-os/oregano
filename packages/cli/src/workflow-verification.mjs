import { readFileSync, statSync } from "node:fs";
import { sha256 } from "../../runtime/canonical.ts";
import { scanCredentialIndicators } from "../../security/credential-scanner.ts";

const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const exact = (value, keys) => { if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Workflow verification configuration contains unsupported fields."); };
const text = (value, pattern) => typeof value === "string" && pattern.test(value);
const hash = /^[a-f0-9]{64}$/, commit = /^[a-f0-9]{40}$/;
const principal = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,254}$/;
const secretRef = /^env:([A-Z][A-Z0-9_]{0,127})$/;

export function parseWorkflowVerificationState(raw) {
  const value = object(raw);
  exact(value, ["schema_version", "scope", "instance_id", "workflow_id", "run_id", "artifact_hash", "manifest_hash", "core_commit", "workspace_commit", "deployment", "operator_secret_ref", "expected_approvers"]);
  if (value.schema_version !== 1 || value.scope !== "workflow" || !text(value.instance_id, /^[a-z][a-z0-9-]{1,62}$/)
    || !text(value.workflow_id, /^[a-z][a-z0-9-]{1,62}$/) || !text(value.run_id, /^workflow:[a-f0-9]{64}$/)
    || !text(value.artifact_hash, hash) || !text(value.manifest_hash, hash) || !text(value.core_commit, commit) || !text(value.workspace_commit, commit)
    || !text(value.operator_secret_ref, secretRef)) throw new Error("Workflow verification requires exact run, Artifact, manifest and source identities plus an operator SecretRef.");
  if (!Array.isArray(value.expected_approvers) || !value.expected_approvers.length || value.expected_approvers.length > 100
    || value.expected_approvers.some((entry) => !text(entry, principal)) || new Set(value.expected_approvers).size !== value.expected_approvers.length) throw new Error("Expected approvers must be a bounded exact principal set.");
  const deployment = object(value.deployment);
  exact(deployment, ["id", "url", "environment", "protection_secret_ref"]);
  if (!text(deployment.id, /^dpl_[A-Za-z0-9]{1,128}$/) || !["preview", "production"].includes(deployment.environment)) throw new Error("The maintained workflow verification profile requires an exact Vercel deployment identity.");
  let url;
  try { url = new URL(deployment.url); } catch { throw new Error("Deployment URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port) throw new Error("Deployment URL must be an exact HTTPS origin without credentials or query parameters.");
  if (deployment.protection_secret_ref !== undefined && (!text(deployment.protection_secret_ref, secretRef) || !url.hostname.endsWith(".vercel.app"))) throw new Error("Vercel protection credentials require an exact vercel.app deployment origin and a SecretRef.");
  if (scanCredentialIndicators(JSON.stringify(value)).length) throw new Error("Workflow verification state must not contain credentials.");
  return structuredClone(value);
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Workflow verification endpoint returned no response body.");
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_048_576) { await reader.cancel(); throw new Error("Workflow verification response exceeds one MiB."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("Workflow verification endpoint did not return JSON."); }
}

export function verifyWorkflowResponse(state, body) {
  const proof = object(body.verification), deployment = object(body.deployment);
  exact(body, ["ok", "verification", "deployment"]);
  exact(deployment, ["id", "coreCommit", "artifactHash", "environment"]);
  exact(proof, ["schemaVersion", "scope", "instanceId", "workflowId", "runId", "artifactHash", "manifestHash", "coreCommit", "workspaceCommit",
    "revision", "environment", "checks", "counts", "approvingPrincipals", "syntheticEvidence", "receipts", "sourceProofs", "ok", "evidenceDigest"]);
  if (scanCredentialIndicators(JSON.stringify(body)).length) throw new Error("Workflow verification response contains credential indicators.");
  const matches = { instanceId: state.instance_id, workflowId: state.workflow_id, runId: state.run_id, artifactHash: state.artifact_hash,
    manifestHash: state.manifest_hash, coreCommit: state.core_commit, workspaceCommit: state.workspace_commit, environment: state.deployment.environment };
  if (body.ok !== true || proof.ok !== true || proof.schemaVersion !== 1 || proof.scope !== "workflow-run-evidence"
    || Object.entries(matches).some(([key, value]) => proof[key] !== value) || deployment.id !== state.deployment.id
    || deployment.coreCommit !== state.core_commit || deployment.artifactHash !== state.artifact_hash || deployment.environment !== state.deployment.environment) throw new Error("The live workflow or deployment no longer matches the exact candidate, or its evidence verification failed.");
  if (proof.syntheticEvidence !== false) throw new Error("Synthetic or unidentified evidence cannot establish live workflow acceptance.");
  const { ok, evidenceDigest, ...content } = proof;
  if (!text(evidenceDigest, hash) || sha256(content) !== evidenceDigest) throw new Error("Workflow verification evidence digest is invalid.");
  const required = ["pinned-run-identity", "completed-run", "bounded-audit", "opening-receipt", "complete-state-journal", "durable-wait", "human-decision",
    "record-source-completeness", "successful-effect", "guard-receipt", "publication-receipt", "consumed-bound-approval", "complete-batch-receipts", "distinct-effect-and-approval-identities"];
  if (!Array.isArray(proof.checks) || proof.checks.length > 10000 || proof.checks.some((entry) => entry.passed !== true)
    || required.some((code) => !proof.checks.some((entry) => entry.code === code))) throw new Error("Workflow verification lacks a required successful evidence check.");
  if (["waits", "decisions", "batches", "effects", "sourceProofs"].some((key) => !Number.isSafeInteger(proof.counts?.[key]) || proof.counts[key] < 1)
    || !Array.isArray(proof.receipts) || proof.receipts.length !== proof.counts.effects || !Array.isArray(proof.sourceProofs) || proof.sourceProofs.length !== proof.counts.sourceProofs) throw new Error("Workflow verification evidence counts are incomplete.");
  exact(proof.counts, ["waits", "decisions", "batches", "effects", "sourceProofs"]);
  const step = /^[a-z][a-z0-9-]{0,62}(?::[a-f0-9]{64})?$/;
  for (const entry of proof.checks) {
    exact(object(entry), ["code", "passed", "stepId"]);
    if (!text(entry.code, /^[a-z][a-z0-9-]{1,63}$/) || (entry.stepId !== undefined && !text(entry.stepId, step))) throw new Error("Workflow verification check metadata is invalid.");
  }
  for (const receipt of proof.receipts) {
    exact(object(receipt), ["stepId", "effectKey", "inputDigest", "outputDigest", "approvalId"]);
    if (!text(receipt.stepId, step) || !text(receipt.effectKey, /^workflow:[a-f0-9]{64}$/) || !text(receipt.inputDigest, hash) || !text(receipt.outputDigest, hash)
      || (receipt.approvalId !== undefined && !text(receipt.approvalId, /^[A-Za-z0-9._:-]{1,128}$/))) throw new Error("Workflow effect receipt metadata is invalid.");
  }
  for (const source of proof.sourceProofs) {
    exact(object(source), ["stepId", "digest"]);
    if (!text(source.stepId, step) || !text(source.digest, hash)) throw new Error("Workflow source proof metadata is invalid.");
  }
  if (!Array.isArray(proof.approvingPrincipals) || JSON.stringify([...proof.approvingPrincipals].sort()) !== JSON.stringify([...state.expected_approvers].sort())) throw new Error("The run was not approved by the exact expected human principal set.");
  return proof;
}

export async function verifyLiveWorkflow({ statePath, fetchImpl = globalThis.fetch, environment = process.env }) {
  const diagnostics = [];
  let state, proof;
  try {
    if (statSync(statePath).size > 32768) throw new Error("Workflow verification state exceeds 32 KiB.");
    state = parseWorkflowVerificationState(JSON.parse(readFileSync(statePath, "utf8")));
    const resolveSecret = (ref) => {
      const value = environment[secretRef.exec(ref)[1]];
      if (typeof value !== "string" || value.length < 32 || value.length > 8192 || /[\r\n]/.test(value)) throw new Error("A required verification SecretRef is missing or invalid in the local environment.");
      return value;
    };
    const headers = { "content-type": "application/json", authorization: `Bearer ${resolveSecret(state.operator_secret_ref)}` };
    if (state.deployment.protection_secret_ref) headers["x-vercel-protection-bypass"] = resolveSecret(state.deployment.protection_secret_ref);
    let response;
    try { response = await fetchImpl(new URL("/api/workflows/operator", state.deployment.url), { method: "POST", headers,
      body: JSON.stringify({ action: "verify", runId: state.run_id }), redirect: "error", signal: AbortSignal.timeout(35000) }); }
    catch { throw new Error("The protected workflow endpoint could not be reached; verify the exact URL, credentials and deployment protection."); }
    if (!response.ok && response.status !== 409) throw new Error(`Workflow verification endpoint refused the read (HTTP ${response.status}).`);
    const body = await boundedJson(response);
    if (!response.ok) {
      const checks = object(body.verification).checks;
      const failed = Array.isArray(checks) ? [...new Set(checks.filter((entry) => object(entry).passed === false && text(object(entry).code, /^[a-z][a-z0-9-]{1,63}$/)).map((entry) => entry.code))].slice(0,20) : [];
      throw new Error(failed.length ? `Workflow evidence checks failed: ${failed.join(", ")}.` : "Workflow verification endpoint refused the read (HTTP 409).");
    }
    proof = verifyWorkflowResponse(state, body);
  } catch (error) {
    // Only locally generated diagnostics are exposed; provider response bodies and fetch errors are never echoed.
    const allowed = error instanceof SyntaxError ? "Workflow verification state is not valid JSON." : error instanceof Error ? error.message : "Workflow verification failed.";
    diagnostics.push({ code: "WVERIFY001", severity: "error", message: allowed });
  }
  const ok = diagnostics.length === 0;
  return { verification: { ok, scope: "live-workflow-instance", readiness: ok ? "validated" : "not-validated",
    statement: "Verification covers one exact deployed workflow run, its wait, Records completeness claims, human decision, consumed approval and batch receipts. Source qualification, provider-state comparison, restart and rollback rehearsals, pilot weeks and production authorization remain separate acceptance evidence." },
    ...(proof ? { proof } : {}), diagnostics };
}
