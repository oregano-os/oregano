import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../../runtime/canonical.ts";
import { createHandbookPromotionCandidate, decideHandbookPromotion, materializeHandbookPromotion } from "../../knowledge/handbook-promotion.ts";

const now = "2026-08-26T12:00:00.000Z";
const base = "# Launch policy\n\nDraft.\n";
const candidate = () => createHandbookPromotionCandidate({
  files: [
    { path: "handbook/policies/launch.md", baseContent: base, proposedContent: "# Launch policy\n\nProject owners must complete readiness review.\n" },
    { path: "handbook/roles/project-owner.md", proposedContent: "# Project owner\n\nThe role owns launch readiness review and access grants.\n" },
  ],
  evidenceClaimIds: ["claim:decision"], evidenceDigests: [sha256("meeting evidence")], conflicts: ["One team requested a shorter review."], consequences: ["Project owner role changes."], accessPolicyId: "policy:leadership", createdBy: "human:knowledge-steward", createdAt: now,
});

const authority = { principalId: "human:ceo", principalType: "human" as const, status: "active" as const, role: "company-authority", scope: ["handbook/policies/launch.md", "handbook/roles/project-owner.md"], authorizationDecisionId: "access-decision:1", canPromote: true };

test("focused Handbook candidates bind exact evidence, conflict, consequence, and file effects", () => {
  const value = candidate();
  assert.equal(value.files.length, 2);
  assert.match(value.sourceDigest, /^[a-f0-9]{64}$/);
  assert.match(value.effectDigest, /^[a-f0-9]{64}$/);
  assert.ok(value.files.some((file) => file.effectKinds.includes("policy")));
  assert.ok(value.files.some((file) => file.effectKinds.includes("grant")));
});

test("only active human promote authority can decide and receipts bind exact materialization", () => {
  const proposed = candidate();
  assert.throws(() => decideHandbookPromotion({ candidate: proposed, decision: "accepted", authority: { ...authority, principalType: "agent" }, decidedAt: now }), /active attributable human/i);
  assert.throws(() => decideHandbookPromotion({ candidate: proposed, decision: "accepted", authority: { ...authority, canPromote: false }, decidedAt: now }), /promote authority/i);
  const decided = decideHandbookPromotion({ candidate: proposed, decision: "accepted", authority, decidedAt: now, note: "Approved in leadership review." });
  const materialized = materializeHandbookPromotion({ candidate: decided.candidate, receipt: decided.receipt, currentFiles: { "handbook/policies/launch.md": base } });
  assert.equal(Object.keys(materialized.files).length, 2);
  assert.match(materialized.materializationDigest, /^[a-f0-9]{64}$/);
  assert.equal(materialized.evidenceArchive.receiptId, decided.receipt.receiptId);
  assert.throws(() => materializeHandbookPromotion({ candidate: { ...decided.candidate, effectDigest: sha256("changed") }, receipt: decided.receipt, currentFiles: { "handbook/policies/launch.md": base } }), /does not bind/i);
  assert.throws(() => materializeHandbookPromotion({ candidate: decided.candidate, receipt: decided.receipt, currentFiles: { "handbook/policies/launch.md": "changed" } }), /base changed/i);
});

test("cross-document effects fail closed and rejected outcomes retain evidence identities", () => {
  const incomplete = createHandbookPromotionCandidate({ files: [{ path: "handbook/policies/security.md", proposedContent: "# Security policy\n\nEveryone receives an access grant." }], evidenceClaimIds: ["claim:1"], evidenceDigests: [sha256("evidence")], accessPolicyId: "policy:leadership", createdBy: "human:steward", createdAt: now });
  const accepted = decideHandbookPromotion({ candidate: incomplete, decision: "accepted", authority: { ...authority, scope: ["handbook/policies/security.md"] }, decidedAt: now });
  assert.throws(() => materializeHandbookPromotion({ candidate: accepted.candidate, receipt: accepted.receipt, currentFiles: {} }), /Cross-document grant effects/i);
  const rejected = decideHandbookPromotion({ candidate: candidate(), decision: "rejected", authority, decidedAt: now });
  assert.equal(rejected.candidate.status, "rejected");
  assert.equal(rejected.candidate.evidenceClaimIds[0], "claim:decision");
  assert.throws(() => materializeHandbookPromotion({ candidate: rejected.candidate, receipt: rejected.receipt, currentFiles: {} }), /Only an accepted/i);
});
