import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { buildCompanyOSArtifact } from "../../companyos-builder/build.ts";
import type { InstanceBuildConfiguration } from "../../companyos-builder/types.ts";
import { BRAIN_READ_CAPABILITIES } from "../../brain/tools.ts";
import { BrainReads } from "../../brain/reads.ts";
import { BrainConnector } from "../../connectors/brain.ts";
import { InMemoryBrainStore } from "../adapter/in-memory-brain.ts";
import { brainConfig, brainFiles } from "../fixtures/brain.ts";
import { checkBrainCorpus } from "../../brain/documents.ts";
import { sha256 } from "../../runtime/canonical.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "brain-adoption-"));
  cpSync(new URL("../fixtures/reference-company/", import.meta.url), root, { recursive: true });
  const instance: InstanceBuildConfiguration = { version: 1, instanceId: "example-test", environment: "test", agentBindings: [],
    bindings: [["artifact.publish", "oregano/artifact-sandbox"], ...["marketing-campaign.launch", "marketing-campaign.read-report", "marketing-campaign.stop-asset", "conversion.record"].map(id => [id, "oregano/marketing-sandbox"])]
      .map(([capability, connector]) => ({ capability, connector, contractVersion: "1.0.0", connectorVersion: "1.0.0" })) };
  const build = () => buildCompanyOSArtifact({ workspaceRoot: root, instance, coreVersion: "0.15.0", coreCommit: "1".repeat(40), workspaceCommit: "2".repeat(40), workbenchVersion: "0.1.0-experimental.23" });
  const adopt = (grants = BRAIN_READ_CAPABILITIES.map(contract => `oregano:brain/${contract.id.slice(6)}`)) => {
    const policy = YAML.parse(readFileSync(join(root, ".companyos/governance.yaml"), "utf8"));
    policy.runtime = { common_tool_grants: grants, brain_reading: "company-wide" };
    writeFileSync(join(root, ".companyos/governance.yaml"), YAML.stringify(policy));
    writeFileSync(join(root, ".companyos/brain.yaml"), YAML.stringify(brainConfig));
    writeFileSync(join(root, "connections/brain.md"), `---\ncapabilities: ${JSON.stringify(BRAIN_READ_CAPABILITIES.map(contract => contract.id))}\n---\nBrain capability allowlist.\n`);
    instance.bindings.push(...BRAIN_READ_CAPABILITIES.map(contract => ({ capability: contract.id, contractVersion: contract.version, connector: "oregano/brain", connectorVersion: "0.1.0" })));
  };
  return { root, instance, build, adopt, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("reviewed common grants reach current and future Agents and retain normal provenance", () => {
  const f = fixture();
  try {
    f.adopt();
    f.instance.defaultAgentId = "growth";
    cpSync(join(f.root, "agents/growth"), join(f.root, "agents/research"), { recursive: true });
    const artifact = f.build();
    for (const agent of artifact.agents) {
      const tools = agent.toolSet.tools.filter(tool => tool.runtimeId.startsWith("oregano:brain/"));
      assert.equal(tools.length, 4); assert.ok(tools.every(tool => tool.grantSources?.includes("workspace-common")));
      assert.equal(agent.toolSet.grantPolicy?.path, ".companyos/governance.yaml");
      assert.ok(agent.instructions.includes("retrieved reference data"));
    }
  } finally { f.cleanup(); }
});

test("enablement grants nothing and missing or unsupported content policy fails closed", () => {
  const f = fixture();
  try {
    assert.equal(f.build().brain, undefined);
    f.adopt([]); const artifact = f.build();
    assert.ok(artifact.agents.every(agent => !agent.toolSet.tools.some(tool => tool.runtimeId.startsWith("oregano:brain/"))));
    assert.ok(artifact.agents.every(agent => !agent.instructions.includes("retrieved reference data")));
    const path = join(f.root, ".companyos/governance.yaml"), policy = YAML.parse(readFileSync(path, "utf8"));
    delete policy.runtime.brain_reading; writeFileSync(path, YAML.stringify(policy)); assert.throws(f.build, /explicit company-wide/);
    policy.runtime.brain_reading = "per-page"; writeFileSync(path, YAML.stringify(policy)); assert.throws(f.build, /company-wide/);
  } finally { f.cleanup(); }
});

test("Brain content never becomes frozen scoped instructions, even with an explicit broad glob", () => {
  const f = fixture();
  try {
    f.adopt();
    cpSync(new URL("../fixtures/reference-company/agents/growth/", import.meta.url), join(f.root, "brain"), { recursive: true });
    const file = join(f.root, "agents/growth/instructions.md"), text = readFileSync(file, "utf8");
    const parts = text.split("---"), metadata = YAML.parse(parts[1]); metadata.scope = { read: ["**"] };
    writeFileSync(file, `---\n${YAML.stringify(metadata)}---${parts.slice(2).join("---")}`);
    assert.ok(Object.keys(f.build().agents.find(agent => agent.id === "growth")!.materials).every(path => !path.startsWith("brain/")));
  } finally { f.cleanup(); }
});

test("runtime Brain reads enforce Instance, active roster subject and effective Tool authority", async () => {
  const f = fixture();
  try {
    f.adopt(["oregano:brain/entity"]); const artifact = f.build(), store = new InMemoryBrainStore();
    assert.ok(!artifact.agents.find(agent => agent.id === "growth")!.instructions.includes("use synthesize"));
    const scope = { instance_id: artifact.instance.id, repository_id: "example/company" };
    store.snapshots.set(store.key(scope), { revision: { git_commit: "3".repeat(40), configuration_digest: sha256(brainConfig), generation: "fixture-generation", sequence: 1, indexed_at: "2030-01-01T00:00:00Z" }, pages: checkBrainCorpus(brainFiles, brainConfig).pages });
    const connector = new BrainConnector({ artifact, reads: new BrainReads(store, scope) });
    const context = { instanceId: artifact.instance.id, agentId: "growth", toolId: "oregano:brain/entity", runId: "run", stepId: "step", subject: { principalId: "fixture-member", principalType: "human" as const, status: "active" as const, groupIds: ["company:active"] } };
    const result = await connector.invoke("brain.entity", { name: "Alex" }, context); assert.equal((result.output as { found: boolean }).found, true);
    for (const changed of [{ ...context, subject: undefined }, { ...context, subject: { ...context.subject, status: "inactive" as const } }, { ...context, instanceId: "other" }, { ...context, agentId: "unknown" }, { ...context, toolId: "oregano:brain/recall" }]) await assert.rejects(connector.invoke("brain.entity", { name: "Alex" }, changed), /authenticated company subject/);
    await assert.rejects(connector.invoke("brain.recall", { query: "Alex" }, context), /Tool grant/);
    await assert.rejects(connector.invoke("brain.entity", { name: "Alex", repository_id: "foreign" }, context), /not allowed/);
  } finally { f.cleanup(); }
});

test("the normal Agent runtime resolves existing roster identity, executes a granted Brain Tool and records evidence", async () => {
  const { CompanyOSRuntime } = await import("../../runtime/companyos-runtime.ts");
  const { InMemoryStateStore } = await import("../adapter/in-memory-state.ts");
  const f = fixture();
  try {
    f.adopt(["oregano:brain/entity", "oregano:brain/synthesize"]);
    const artifact = f.build(), store = new InMemoryBrainStore(), state = new InMemoryStateStore();
    const scope = { instance_id: artifact.instance.id, repository_id: "example/company" };
    const snapshot = { revision: { git_commit: "3".repeat(40), configuration_digest: sha256(brainConfig), generation: "fixture-generation", sequence: 1, indexed_at: "2030-01-01T00:00:00Z" }, pages: checkBrainCorpus(brainFiles, brainConfig).pages };
    store.snapshots.set(store.key(scope), snapshot);
    let preparations = 0;
    const connector = new BrainConnector({ artifact, reads: new BrainReads(store, scope), model: { prepare() { preparations++; throw new Error("Model not configured"); } } });
    const runtime = new CompanyOSRuntime({ artifact, state, connectors: [connector] });
    const request = { runId: "brain-agent-read", stepId: "lookup", agentId: "growth", grantId: "oregano:brain/entity", input: { name: "Alex" }, subjectPrincipal: "test:solstice:morgan" };
    const result = await runtime.execute(request) as { output: { found: boolean; page: { slug: string } } };
    assert.equal(result.output.found, true); assert.equal(result.output.page.slug, "people/alex");
    assert.ok(state.events.some(event => event.event === "tool.read-succeeded" && JSON.stringify(event.evidence).includes("indexed_revision")));
    await assert.rejects(runtime.execute({ ...request, stepId: "unknown-member", subjectPrincipal: "not-in-roster" }), /active authenticated/);
    await assert.rejects(runtime.execute({ ...request, stepId: "ungranted", grantId: "oregano:brain/recall", input: { query: "Alex" } }), /resolved ToolSet/);
    snapshot.revision.configuration_digest = "0".repeat(64);
    await assert.rejects(runtime.execute({ ...request, stepId: "stale-config", grantId: "oregano:brain/synthesize", input: { question: "What is known about Alex?" } }), /deployed configuration/);
    assert.equal(preparations, 0, "Configuration drift must fail before model preparation or invocation");
  } finally { f.cleanup(); }
});

test("Brain material changes do not alter compiled operating material or its content hash", () => {
  const f = fixture();
  try {
    f.adopt(); const before = f.build();
    cpSync(new URL("../fixtures/reference-company/agents/growth/", import.meta.url), join(f.root, "brain"), { recursive: true });
    const after = f.build();
    assert.deepEqual(after.agents, before.agents); assert.equal(after.provenance.workspaceHash, before.provenance.workspaceHash);
    assert.equal(after.artifactHash, before.artifactHash, "The same explicit source pins and operating content produce identical Artifacts");
    f.instance.connectors = [{ id: "brain", connector: "oregano/brain", connectorVersion: "0.1.0", configuration: { repository_binding_id: "workspace", repository_id: "example/workspace", branch: "main" } }];
    assert.doesNotThrow(f.build);
    f.instance.connectors[0].configuration.token = "forbidden";
    assert.throws(f.build, /Unsupported Brain connector/);
  } finally { f.cleanup(); }
});
