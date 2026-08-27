import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  COMPANY_KNOWLEDGE_POLICY,
  InMemoryKnowledgeAccessAuditor,
  KNOWLEDGE_ADMIN_GROUP_ID,
  KnowledgeAuthorizer,
  QUARANTINE_POLICY,
  assertNarrowingPolicy,
} from "../../knowledge/access-control.ts";
import type { KnowledgeAccessPolicy, KnowledgeAccessSubject } from "../../knowledge/contracts.ts";
import { InMemoryKnowledgeProvider } from "../../knowledge/in-memory-provider.ts";
import { buildKnowledgeBundle } from "../../knowledge/okf.ts";
import { COMPANY_BRAIN_PHASE_TWO_SCHEMA_STATEMENTS } from "../../state-postgres/knowledge-schema-phase-two.ts";

const subject = (principalId: string, groupIds: string[] = [], status: KnowledgeAccessSubject["status"] = "active"): KnowledgeAccessSubject => ({
  principalId, principalType: "human", status, groupIds: [...groupIds, ...(status === "active" ? ["company:active"] : [])],
});

const workspace = () => {
  const root = mkdtempSync(join(tmpdir(), "company-brain-auth-"));
  mkdirSync(join(root, "handbook"), { recursive: true });
  writeFileSync(join(root, "handbook", "index.md"), "---\ntype: index\ndescription: Index.\n---\n# Index\n\n- [Company](company.md)\n- [Payroll](payroll.md)\n");
  writeFileSync(join(root, "handbook", "company.md"), "---\ntype: concept\ndescription: Shared company policy.\n---\n# Company\n\nThe launch color is oregano. See [Payroll](payroll.md).\n");
  writeFileSync(join(root, "handbook", "payroll.md"), "---\ntype: concept\ndescription: Restricted payroll policy.\ndata_class: personnel\npersonal_data: true\nvisibility: restricted_group\nallowed_groups: [group:people]\ndenied_principals: [test:blocked]\n---\n# Payroll\n\nThe confidential payroll marker is heliotrope. Return to [Company](company.md).\n");
  return root;
};

test("authorization filters lexical, vector, citation, get, and graph paths before protected output", async () => {
  const root = workspace();
  try {
    const bundle = buildKnowledgeBundle({ workspaceRoot: root, workspaceCommit: "c".repeat(40) });
    const auditor = new InMemoryKnowledgeAccessAuditor();
    const provider = new InMemoryKnowledgeProvider({ accessAuditor: auditor });
    await provider.stage(bundle); await provider.verify(bundle.bundleHash); await provider.activate(bundle.bundleHash);

    const ordinary = subject("test:ordinary");
    const people = subject("test:people", ["group:people"]);
    const blocked = subject("test:blocked", ["group:people"]);

    const deniedSearch = await provider.search({ query: "heliotrope confidential", mode: "lexical", subject: ordinary });
    assert.deepEqual(deniedSearch.hits, []);
    assert.deepEqual(deniedSearch.gaps, ["no-results"]);
    assert.equal(await provider.get({ path: "payroll.md", subject: ordinary }), undefined);
    assert.equal(await provider.get({ path: "does-not-exist.md", subject: ordinary }), undefined, "unknown and unauthorized exact identities are indistinguishable");

    const permittedSearch = await provider.search({ query: "heliotrope confidential", mode: "lexical", subject: people });
    assert.equal(permittedSearch.hits[0].citation.path, "payroll.md");
    assert.match(permittedSearch.hits[0].excerpt, /heliotrope/);
    assert.equal((await provider.get({ path: "payroll.md", subject: people }))?.document.path, "payroll.md");
    assert.equal(await provider.get({ path: "payroll.md", subject: blocked }), undefined, "a matching principal deny overrides a matching group allow");

    const graph = await provider.traverse({ path: "company.md", direction: "outbound", maxDepth: 5, maxNodes: 100, subject: ordinary });
    assert.deepEqual(graph.paths, [{ path: "company.md", depth: 0 }]);
    assert.equal(graph.truncated, false);
    assert.deepEqual((await provider.traverse({ path: "payroll.md", subject: ordinary })).gaps, ["unknown-start-path"]);

    const auditJson = JSON.stringify(auditor.decisions);
    assert.ok(auditor.decisions.some((entry) => entry.outcome === "deny" && entry.reason === "no-matching-allow"));
    assert.ok(auditor.decisions.some((entry) => entry.outcome === "permit"));
    assert.doesNotMatch(auditJson, /heliotrope|confidential payroll|launch color/i, "access evidence never contains protected payload or queries");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("missing, inactive, and unresolved subjects fail closed", async () => {
  const root = workspace();
  try {
    const bundle = buildKnowledgeBundle({ workspaceRoot: root, workspaceCommit: "d".repeat(40) });
    const provider = new InMemoryKnowledgeProvider();
    await provider.stage(bundle); await provider.verify(bundle.bundleHash); await provider.activate(bundle.bundleHash);
    for (const accessSubject of [undefined, subject("test:inactive", [], "inactive"), subject("test:unknown", [], "unresolved")]) {
      assert.deepEqual((await provider.search({ query: "oregano", subject: accessSubject })).hits, []);
      assert.equal(await provider.get({ path: "company.md", subject: accessSubject }), undefined);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("policy inheritance is narrowing-only, intersection-based, and quarantine is administrator-only", async () => {
  const restrictedParent: KnowledgeAccessPolicy = {
    policyId: "policy:parent", policyVersion: 1, visibility: "restricted_group", sourceRoot: true, status: "active",
    entries: [{ subjectKind: "group", subjectId: "group:legal", permission: "read", effect: "allow" }],
  };
  const wideningChild: KnowledgeAccessPolicy = {
    policyId: "policy:child", policyVersion: 1, visibility: "company", parentPolicyId: restrictedParent.policyId,
    sourceRoot: false, status: "active", entries: [],
  };
  assert.throws(() => assertNarrowingPolicy(wideningChild, restrictedParent), /widens parent/);

  const child: KnowledgeAccessPolicy = {
    ...wideningChild, visibility: "individual",
    entries: [{ subjectKind: "principal", subjectId: "test:counsel", permission: "read", effect: "allow" }],
  };
  const authorizer = new KnowledgeAuthorizer([COMPANY_KNOWLEDGE_POLICY, restrictedParent, child, QUARANTINE_POLICY]);
  assert.equal(await authorizer.authorize({ subject: subject("test:counsel", ["group:legal"]), permission: "read", policyIds: [child.policyId], objectType: "document", objectId: "legal" }), true);
  assert.equal(await authorizer.authorize({ subject: subject("test:counsel"), permission: "read", policyIds: [child.policyId], objectType: "document", objectId: "legal" }), false, "the child cannot bypass its parent");
  assert.equal(await authorizer.authorize({ subject: subject("test:admin", [KNOWLEDGE_ADMIN_GROUP_ID]), permission: "review", policyIds: [QUARANTINE_POLICY.policyId], objectType: "review-candidate", objectId: "candidate" }), true);
  assert.equal(await authorizer.authorize({ subject: subject("test:ordinary"), permission: "review", policyIds: [QUARANTINE_POLICY.policyId], objectType: "review-candidate", objectId: "candidate" }), false);
});

test("the Phase 2 schema is additive, payload-free, and mirrored by standalone SQL", () => {
  const schema = readFileSync(join(import.meta.dirname, "../../state-postgres/knowledge-schema.sql"), "utf8");
  const runtime = COMPANY_BRAIN_PHASE_TWO_SCHEMA_STATEMENTS.join("\n");
  for (const table of ["principal_groups", "principal_group_members", "access_decision_events"]) {
    const statement = `create table if not exists companyos_knowledge.${table}`;
    assert.ok(schema.includes(statement));
    assert.ok(runtime.includes(statement));
  }
  for (const source of [schema, runtime]) {
    assert.match(source, /companyos:knowledge-admin/);
    assert.match(source, /object_id_hash text not null/);
    assert.doesNotMatch(source, /access_decision_events[\s\S]+(?:payload|query|excerpt|body|content) text/i);
    assert.doesNotMatch(source, /\b(?:drop|truncate|delete\s+from)\b/i);
  }
});
