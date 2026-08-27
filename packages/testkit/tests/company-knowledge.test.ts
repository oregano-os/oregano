import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCompanyOSArtifact } from "../../companyos-builder/build.ts";
import type { InstanceBuildConfiguration } from "../../companyos-builder/types.ts";
import { KnowledgeProviderConnector } from "../../connectors/knowledge.ts";
import { decideReviewCandidate, inspectCurationInbox, proposeKnowledgePromotion } from "../../knowledge/curation.ts";
import { InMemoryKnowledgeProvider } from "../../knowledge/in-memory-provider.ts";
import { buildKnowledgeBundle, inspectKnowledgeWorkspace } from "../../knowledge/okf.ts";
import { KNOWLEDGE_EMBEDDING_DIMENSIONS, type EmbeddingAdapter } from "../../knowledge/contracts.ts";
import { backlinksFor } from "../../knowledge/graph.ts";
import { runRetrievalRegression } from "../../knowledge/regression.ts";
import { CompanyOSRuntime } from "../../runtime/companyos-runtime.ts";
import { InMemoryStateStore } from "../adapter/in-memory-state.ts";

const document = (type: string, description: string, body: string) => `---\ntype: ${type}\ndescription: ${description}\n---\n${body.trim()}\n`;
const rawDocument = (body: string, personalData = false) => `---\nsource: fictional-meeting\ncaptured_at: 2026-08-25T09:00:00Z\nactor: test:fictional:steward\npersonal_data: ${personalData}\n---\n${body.trim()}\n`;
const ACTIVE_SUBJECT = { principalId: "test:fictional:steward", principalType: "human" as const, status: "active" as const, groupIds: ["company:active"] };

const makeKnowledgeWorkspace = () => {
  const root = mkdtempSync(join(tmpdir(), "company-knowledge-"));
  mkdirSync(join(root, "handbook"), { recursive: true });
  mkdirSync(join(root, "brain", "inbox"), { recursive: true });
  mkdirSync(join(root, "brain", "archive"), { recursive: true });
  writeFileSync(join(root, "handbook", "index.md"), document("index", "Knowledge index.", "# Handbook\n\n- [Sales](sales.md)"));
  writeFileSync(join(root, "handbook", "sales.md"), document("concept", "How the fictional company qualifies sales opportunities.", "# Sales qualification\n\nQualified opportunities have an accountable owner and a confirmed next step.\n\n## Exit\n\nClose stale opportunities after fourteen days."));
  writeFileSync(join(root, "brain", "inbox", "raw.md"), rawDocument("# Meeting note\n\nA raw claim that must not be active."));
  return root;
};

test("OKF validation and Knowledge Bundle construction are deterministic and exclude raw inbox content", () => {
  const root = makeKnowledgeWorkspace();
  try {
    const first = buildKnowledgeBundle({ workspaceRoot: root, workspaceCommit: "1".repeat(40) });
    const second = buildKnowledgeBundle({ workspaceRoot: root, workspaceCommit: "1".repeat(40) });
    assert.equal(first.bundleHash, second.bundleHash);
    assert.equal(first.documentCount, 1);
    assert.ok(first.fragmentCount >= 2);
    assert.equal(JSON.stringify(first).includes("raw claim"), false);
    assert.ok(first.documents[0].fragments.every((fragment) => fragment.path === "sales.md" && fragment.startLine > 0));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OKF validation fails closed for missing index references and broken relative links", () => {
  const root = makeKnowledgeWorkspace();
  try {
    writeFileSync(join(root, "handbook", "index.md"), document("index", "Knowledge index.", "# Handbook"));
    writeFileSync(join(root, "handbook", "sales.md"), document("concept", "Sales.", "# Sales\n\n[Missing](missing.md)"));
    const result = inspectKnowledgeWorkspace({ workspaceRoot: root });
    assert.equal(result.bundle, undefined);
    assert.deepEqual(new Set(result.diagnostics.map((entry) => entry.code)), new Set(["KNOW006", "KNOW007"]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OKF requires an explicit restrictive policy for sensitive data and retrieval preserves status signals", async () => {
  const root = makeKnowledgeWorkspace();
  try {
    const salesPath = join(root, "handbook", "sales.md");
    writeFileSync(salesPath, readFileSync(salesPath, "utf8").replace("description: How", "personal_data: true\ndescription: How"));
    let inspected = inspectKnowledgeWorkspace({ workspaceRoot: root });
    assert.equal(inspected.bundle, undefined);
    assert.ok(inspected.diagnostics.some((entry) => entry.code === "KNOW008"));
    writeFileSync(salesPath, document("concept", "How the fictional company qualifies sales opportunities.", "# Sales qualification\n\nA confirmed next step is required.").replace("description: How", "status: contested\ndescription: How"));
    inspected = inspectKnowledgeWorkspace({ workspaceRoot: root, workspaceCommit: "8".repeat(40) });
    assert.ok(inspected.bundle);
    const provider = new InMemoryKnowledgeProvider();
    await provider.stage(inspected.bundle!);
    await provider.verify(inspected.bundle!.bundleHash);
    await provider.activate(inspected.bundle!.bundleHash);
    const result = await provider.search({ query: "confirmed next step", subject: ACTIVE_SUBJECT });
    assert.deepEqual(result.hits[0].signals, ["contested"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("snapshot lifecycle requires verification and lexical search returns exact citations and gaps", async () => {
  const root = makeKnowledgeWorkspace();
  try {
    const bundle = buildKnowledgeBundle({ workspaceRoot: root, workspaceCommit: "2".repeat(40) });
    const provider = new InMemoryKnowledgeProvider();
    const tampered = structuredClone(bundle);
    tampered.documents[0].body = "tampered\n";
    await assert.rejects(() => provider.stage(tampered), /invalid digest/);
    await provider.stage(bundle);
    await assert.rejects(() => provider.activate(bundle.bundleHash), /verified before activation/);
    await provider.verify(bundle.bundleHash);
    await provider.activate(bundle.bundleHash);
    const found = await provider.search({ query: "confirmed next step", limit: 2, subject: ACTIVE_SUBJECT });
    assert.equal(found.gaps.length, 0);
    assert.equal(found.hits[0].citation.snapshotHash, bundle.bundleHash);
    assert.equal(found.hits[0].citation.path, "sales.md");
    assert.ok(found.hits[0].citation.startLine > 0);
    const missing = await provider.search({ query: "unicorns", subject: ACTIVE_SUBJECT });
    assert.deepEqual(missing.gaps, ["no-results"]);
    const secondRoot = makeKnowledgeWorkspace();
    try {
      writeFileSync(join(secondRoot, "handbook", "sales.md"), document("concept", "Updated sales policy.", "# Sales\n\nEvery opportunity has an owner."));
      const second = buildKnowledgeBundle({ workspaceRoot: secondRoot, workspaceCommit: "6".repeat(40) });
      await provider.stage(second);
      await provider.verify(second.bundleHash);
      await provider.activate(second.bundleHash);
      assert.equal((await provider.activeSnapshot())?.snapshotHash, second.bundleHash);
      await provider.activate(bundle.bundleHash);
      assert.equal((await provider.activeSnapshot())?.snapshotHash, bundle.bundleHash, "rollback reactivates a prior verified snapshot");
    } finally {
      rmSync(secondRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hybrid retrieval is deterministic, policy-bound, document-pooled, and degrades explicitly", async () => {
  const root = makeKnowledgeWorkspace();
  try {
    const bundle = buildKnowledgeBundle({ workspaceRoot: root, workspaceCommit: "9".repeat(40) });
    const provider = new InMemoryKnowledgeProvider();
    await provider.stage(bundle);
    await provider.verify(bundle.bundleHash);
    await provider.activate(bundle.bundleHash);
    const first = await provider.search({ query: "confirmed opportunity owner", mode: "hybrid", subject: ACTIVE_SUBJECT });
    const second = await provider.search({ query: "confirmed opportunity owner", mode: "hybrid", subject: ACTIVE_SUBJECT });
    assert.deepEqual(first, second);
    assert.equal(first.mode, "hybrid");
    assert.equal(new Set(first.hits.map((hit) => hit.citation.path)).size, first.hits.length);

    const failing: EmbeddingAdapter = {
      id: "test/failing-local", version: "1.0.0", dimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS, dataEgress: "none",
      async embed() { throw new Error("offline"); },
    };
    const degraded = new InMemoryKnowledgeProvider({ embeddingAdapter: failing });
    await degraded.stage(bundle); await degraded.verify(bundle.bundleHash); await degraded.activate(bundle.bundleHash);
    const fallback = await degraded.search({ query: "confirmed next step", subject: ACTIVE_SUBJECT });
    assert.equal(fallback.mode, "lexical");
    assert.deepEqual(fallback.degradations, ["embedding-unavailable"]);
    const external: EmbeddingAdapter = { ...failing, id: "test/external", dataEgress: "external" };
    assert.throws(() => new InMemoryKnowledgeProvider({ embeddingAdapter: external }), /external data egress/i);

    const regression = await runRetrievalRegression(provider, { version: 1, subject: ACTIVE_SUBJECT, cases: [{ id: "sales", query: "confirmed next step", expectedPaths: ["sales.md"] }] });
    assert.equal(regression.passed, true);
    assert.equal(regression.meanRecall, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OKF graph exposes deterministic backlinks, orphan diagnostics, and bounded traversal", async () => {
  const root = makeKnowledgeWorkspace();
  try {
    writeFileSync(join(root, "handbook", "sales.md"), document("concept", "Sales policy.", "# Sales\n\nSee [Renewals](renewals.md)."));
    writeFileSync(join(root, "handbook", "renewals.md"), document("playbook", "Renewal process.", "# Renewals\n\nReturn to [Sales](sales.md)."));
    writeFileSync(join(root, "handbook", "orphan.md"), document("note", "An intentionally unlinked note.", "# Orphan\n\nStandalone."));
    writeFileSync(join(root, "handbook", "index.md"), document("index", "Knowledge index.", "# Handbook\n\n- [Sales](sales.md)\n- [Renewals](renewals.md)\n- [Orphan](orphan.md)"));
    const inspected = inspectKnowledgeWorkspace({ workspaceRoot: root, workspaceCommit: "a".repeat(40) });
    assert.ok(inspected.bundle);
    assert.deepEqual(inspected.bundle!.edges, [{ from: "renewals.md", to: "sales.md" }, { from: "sales.md", to: "renewals.md" }]);
    assert.deepEqual(backlinksFor(inspected.bundle!.edges, "sales.md"), ["renewals.md"]);
    assert.ok(inspected.diagnostics.some((entry) => entry.code === "KNOW013" && entry.path === "handbook/orphan.md"));
    const provider = new InMemoryKnowledgeProvider();
    await provider.stage(inspected.bundle!); await provider.verify(inspected.bundle!.bundleHash); await provider.activate(inspected.bundle!.bundleHash);
    const traversal = await provider.traverse({ path: "sales.md", direction: "both", maxDepth: 99, maxNodes: 1, subject: ACTIVE_SUBJECT });
    assert.equal(traversal.paths.length, 1);
    assert.equal(traversal.truncated, true);
    assert.deepEqual((await provider.traverse({ path: "missing.md", subject: ACTIVE_SUBJECT })).gaps, ["unknown-start-path"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("curation is bounded, quarantines credential-like input, deduplicates, and never self-promotes", () => {
  const root = makeKnowledgeWorkspace();
  try {
    const bundle = buildKnowledgeBundle({ workspaceRoot: root, workspaceCommit: "3".repeat(40) });
    writeFileSync(join(root, "brain", "inbox", "a-secret.md"), rawDocument("api_key=sk_12345678901234567890"));
    writeFileSync(join(root, "brain", "inbox", "b-duplicate.md"), rawDocument(bundle.documents[0].body));
    writeFileSync(join(root, "brain", "inbox", "c-steps.md"), rawDocument("# Renewal steps\n\nChecklist and procedure for renewals."));
    writeFileSync(join(root, "brain", "inbox", "d-extra.md"), rawDocument("# Extra\n\nA fourth review item."));
    const candidates = inspectCurationInbox({ workspaceRoot: root, activeBundle: bundle });
    assert.equal(candidates.length, 3);
    assert.equal(candidates[0].status, "quarantined");
    assert.equal(candidates[1].duplicateOf, "sales.md");
    assert.equal(candidates[2].route, "playbook");
    const reviewed = decideReviewCandidate(candidates[2], { decision: "accepted", decidedBy: "human:steward", decidedAt: "2026-08-25T10:00:00Z" });
    assert.equal(reviewed.candidate.status, "accepted");
    const proposal = proposeKnowledgePromotion({ workspaceRoot: root, candidate: reviewed.candidate });
    assert.equal(proposal.operations.some((operation) => operation.operation === "create"), true);
    assert.equal(proposal.operations.some((operation) => operation.operation === "archive"), true);
    assert.match(proposal.warning, /cannot merge/);
    assert.equal(readFileSync(join(root, "handbook", "index.md"), "utf8").includes("Renewal"), false);
    const repeated = inspectCurationInbox({ workspaceRoot: root, activeBundle: bundle, previousCandidateIds: [candidates[2].candidateId] });
    assert.equal(repeated.some((candidate) => candidate.candidateId === candidates[2].candidateId), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("raw knowledge without complete provenance or with personal data remains quarantined for policy review", () => {
  const root = makeKnowledgeWorkspace();
  try {
    const bundle = buildKnowledgeBundle({ workspaceRoot: root, workspaceCommit: "7".repeat(40) });
    writeFileSync(join(root, "brain", "inbox", "raw.md"), rawDocument("# Private note\n\nRestricted facts.", true));
    let candidates = inspectCurationInbox({ workspaceRoot: root, activeBundle: bundle });
    assert.equal(candidates[0].status, "quarantined");
    assert.match(candidates[0].reason, /restrictive access policy/);
    writeFileSync(join(root, "brain", "inbox", "raw.md"), "# Missing provenance\n\nUnverified facts.\n");
    candidates = inspectCurationInbox({ workspaceRoot: root, activeBundle: bundle });
    assert.equal(candidates[0].status, "quarantined");
    assert.match(candidates[0].reason, /requires YAML frontmatter/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit Knowledge grants resolve to standard Tools and replace full Handbook prompt material", async () => {
  const fixture = join(import.meta.dirname, "..", "fixtures", "reference-company");
  const root = mkdtempSync(join(tmpdir(), "company-knowledge-runtime-"));
  cpSync(fixture, root, { recursive: true });
  try {
    writeFileSync(join(root, "handbook", "sales.md"), document("concept", "Sales policy.", "# Sales\n\nEvery opportunity needs a confirmed next step."));
    writeFileSync(join(root, "handbook", "index.md"), readFileSync(join(root, "handbook", "index.md"), "utf8") + "\n- `sales.md` — sales policy.\n");
    const agentPath = join(root, "agents", "growth", "instructions.md");
    writeFileSync(agentPath, readFileSync(agentPath, "utf8").replace("tools:\n", "tools:\n  - oregano:knowledge/search\n  - oregano:knowledge/get\n"));
    const connectionPath = join(root, "connections", "marketing.md");
    writeFileSync(connectionPath, readFileSync(connectionPath, "utf8").replace("capabilities:\n", "capabilities:\n  - knowledge.search\n  - knowledge.get\n"));
    const bindings: InstanceBuildConfiguration["bindings"] = [
      ["artifact.publish", "oregano/artifact-sandbox"],
      ["marketing-campaign.launch", "oregano/marketing-sandbox"],
      ["marketing-campaign.read-report", "oregano/marketing-sandbox"],
      ["marketing-campaign.stop-asset", "oregano/marketing-sandbox"],
      ["conversion.record", "oregano/marketing-sandbox"],
      ["knowledge.search", "oregano/knowledge-postgres"],
      ["knowledge.get", "oregano/knowledge-postgres"],
    ].map(([capability, connector]) => ({
      capability,
      contractVersion: capability.startsWith("knowledge.") ? "3.0.0" : "1.0.0",
      connector,
      connectorVersion: connector === "oregano/knowledge-postgres" ? "3.0.0" : "1.0.0",
    }));
    const artifact = buildCompanyOSArtifact({
      workspaceRoot: root,
      instance: { version: 1, instanceId: "knowledge-test", environment: "test", bindings },
      coreVersion: "0.3.2",
      coreCommit: "4".repeat(40),
      workspaceCommit: "5".repeat(40),
      workbenchVersion: "0.1.0-experimental.7",
      builtAt: "2026-08-25T10:00:00Z",
    });
    const agent = artifact.agents.find((entry) => entry.id === "growth")!;
    assert.ok(agent.tools.some((tool) => tool.contract.runtimeId === "oregano:knowledge/search"));
    assert.equal(agent.materials["handbook/sales.md"], undefined);
    assert.ok(agent.materials["handbook/roster.md"], "authorization roster remains part of the agent definition");
    const provider = new InMemoryKnowledgeProvider();
    const bundle = buildKnowledgeBundle({ workspaceRoot: root, workspaceCommit: "5".repeat(40) });
    await provider.stage(bundle);
    await provider.verify(bundle.bundleHash);
    await provider.activate(bundle.bundleHash);
    const runtime = new CompanyOSRuntime({ artifact, state: new InMemoryStateStore(), connectors: [new KnowledgeProviderConnector(provider)] });
    const denied: any = await runtime.execute({
      runId: "knowledge-run-denied", stepId: "search", agentId: "growth", grantId: "oregano:knowledge/search", input: { query: "confirmed next step" },
    });
    assert.deepEqual(denied.output.hits, [], "a model execution without an attributable active subject receives no Knowledge context");
    const result: any = await runtime.execute({
      runId: "knowledge-run", stepId: "search", agentId: "growth", grantId: "oregano:knowledge/search", input: { query: "confirmed next step" },
      subjectPrincipal: "test:solstice:avery",
    });
    assert.equal(result.output.hits[0].citation.path, "sales.md");
    assert.equal(result.capabilityEvidence[0].snapshot_hash, bundle.bundleHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
