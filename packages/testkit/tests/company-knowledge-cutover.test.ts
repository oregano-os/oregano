import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { createBrainExportLedger, qualifyCompanyKnowledgeCutover } from "../../knowledge/cutover.ts";
import { sha256 } from "../../runtime/canonical.ts";

const now = "2026-08-26T16:03:01.739Z";

test("database preparation detects bootstrap, upgrade, or verify before applying schema", () => {
  const source = readFileSync(join(import.meta.dirname, "../../state-postgres/database-bootstrap.ts"), "utf8");
  assert.match(source, /to_regnamespace\('companyos'\)/);
  assert.match(source, /to_regnamespace\('companyos_knowledge'\)/);
  assert.match(source, /to_regclass\('companyos\.schema_manifests'\)/);
  assert.match(source, /hasExistingState \? "upgrade" : "bootstrap"/);
  assert.match(source, /previousManifestVersions\.includes\(COMPANY_DATABASE_MANIFEST\.version\)[\s\S]*\? "verify"/);
  const setup = readFileSync(join(import.meta.dirname, "../../cli/src/live-setup.mjs"), "utf8");
  assert.match(setup, /"database", "prepare"/);
  assert.match(setup, /\["bootstrap", "upgrade", "verify"\]/);
});

test("deterministic export and cutover receipts bind complete non-secret evidence", () => {
  const ledger = createBrainExportLedger({
    manifestId: "companyos-postgres", manifestVersion: "1.3.0", schemaDigest: sha256("schema"), handbookCommit: "a".repeat(40),
    objectIdentities: ["page:1", "claim:1"], receiptIdentities: ["receipt:1"], policyIdentities: ["policy:company"], sourceIdentities: ["source:github"], exportedAt: now,
  });
  const evidence = {
    databaseQualificationReceiptId: "database:qualification", databaseManifestDigest: sha256("schema"), aclRegressionReceiptId: "acl:regression",
    retrievalRegressionReceiptId: "retrieval:regression", sourceQualificationReceiptIds: ["source:qualification"], modelProfileQualificationReceiptIds: ["model:qualification"],
    handbookCommit: "a".repeat(40), handbookSnapshotDigest: sha256("handbook"), backupReceiptId: "backup:1", rollbackTestReceiptId: "rollback:1", exportLedgerId: ledger.exportId,
  };
  const cutover = qualifyCompanyKnowledgeCutover({ evidence, exportLedger: ledger, activatedAt: now });
  assert.equal(cutover.status, "qualified");
  assert.match(cutover.receiptId, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(cutover), /DATABASE_URL|postgres(?:ql)?:\/\//i);
  assert.throws(() => qualifyCompanyKnowledgeCutover({ evidence: { ...evidence, backupReceiptId: "" }, exportLedger: ledger, activatedAt: now }), /backupReceiptId.*missing/i);
  assert.throws(() => qualifyCompanyKnowledgeCutover({ evidence: { ...evidence, sourceQualificationReceiptIds: [] }, exportLedger: ledger, activatedAt: now }), /qualified Source/i);
  assert.throws(() => qualifyCompanyKnowledgeCutover({ evidence: { ...evidence, handbookCommit: "b".repeat(40) }, exportLedger: ledger, activatedAt: now }), /does not match/i);
});

test("export identity ordering is deterministic and duplicate identities fail closed", () => {
  const input = { manifestId: "companyos-postgres", manifestVersion: "1.3.0", schemaDigest: sha256("schema"), handbookCommit: "a".repeat(40), objectIdentities: ["page:b", "page:a"], receiptIdentities: ["receipt:b", "receipt:a"], policyIdentities: ["policy:b", "policy:a"], sourceIdentities: ["source:b", "source:a"], exportedAt: now };
  const first = createBrainExportLedger(input);
  const second = createBrainExportLedger({ ...input, objectIdentities: [...input.objectIdentities].reverse(), receiptIdentities: [...input.receiptIdentities].reverse(), policyIdentities: [...input.policyIdentities].reverse(), sourceIdentities: [...input.sourceIdentities].reverse() });
  assert.equal(first.exportId, second.exportId);
  assert.throws(() => createBrainExportLedger({ ...input, objectIdentities: ["page:a", "page:a"] }), /distinct non-empty/i);
});
