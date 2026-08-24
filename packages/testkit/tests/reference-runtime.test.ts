import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCompanyOSArtifact } from "../../companyos-builder/build.ts";
import type { InstanceBuildConfiguration } from "../../companyos-builder/types.ts";
import { ArtifactSandboxConnector, MarketingSandboxConnector } from "../../connectors/sandbox.ts";
import { CompanyOSRuntime } from "../../runtime/companyos-runtime.ts";
import { InMemoryStateStore } from "../adapter/in-memory-state.ts";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "reference-company");
const CORE_COMMIT = "1".repeat(40);
const WORKSPACE_COMMIT = "2".repeat(40);
const instance: InstanceBuildConfiguration = {
  version: 1,
  instanceId: "solstice-demo",
  environment: "test",
  bindings: [
    ["artifact.publish", "oregano/artifact-sandbox"],
    ["marketing-campaign.launch", "oregano/marketing-sandbox"],
    ["marketing-campaign.read-report", "oregano/marketing-sandbox"],
    ["marketing-campaign.stop-asset", "oregano/marketing-sandbox"],
    ["conversion.record", "oregano/marketing-sandbox"],
  ].map(([capability, connector]) => ({
    capability,
    contractVersion: "1.0.0",
    connector,
    connectorVersion: "1.0.0",
  })),
};

const build = (root = FIXTURE) => buildCompanyOSArtifact({
  workspaceRoot: root,
  instance,
  coreVersion: "0.3.2",
  coreCommit: CORE_COMMIT,
  workspaceCommit: WORKSPACE_COMMIT,
  workbenchVersion: "0.1.0-experimental.7",
  builtAt: "2026-08-19T12:00:00.000Z",
});

test("the exact Core, Workspace, and Instance inputs produce one deterministic artifact", () => {
  const first = build();
  const second = build();
  assert.equal(first.artifactHash, second.artifactHash);
  assert.equal(first.provenance.coreVersion, "0.3.2");
  assert.equal(first.provenance.workspaceVersion, "0.1.0");
  assert.equal(first.provenance.resolvedToolSetHash, second.provenance.resolvedToolSetHash);
  assert.equal(first.agents.length, 1);
  assert.equal(first.agents[0].toolSet.tools.length, 5);
  assert.equal(first.roster.length, 3);
  assert.ok(first.agents[0].materials["workflows/property-campaign.md"]);
  assert.equal(first.agents[0].materials["connections/marketing.md"], undefined, "undeclared material must stay out of the agent snapshot");
});

test("a material Workspace change changes the immutable artifact hash", () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-reference-workspace-"));
  cpSync(FIXTURE, root, { recursive: true });
  try {
    const before = build(root);
    writeFileSync(join(root, "agents", "growth", "skills", "campaign-sop.md"), "---\ntype: sop\ndescription: changed\n---\nchanged\n");
    const after = build(root);
    assert.notEqual(before.artifactHash, after.artifactHash);
    assert.notEqual(before.provenance.workspaceHash, after.provenance.workspaceHash);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Builder rejects ambiguous product versions", () => {
  assert.throws(() => buildCompanyOSArtifact({
    workspaceRoot: FIXTURE,
    instance,
    coreVersion: "00.1.0",
    coreCommit: CORE_COMMIT,
    workspaceCommit: WORKSPACE_COMMIT,
    workbenchVersion: "0.1.0-experimental.7",
  }), /coreVersion must be an exact Semantic Versioning/);
});

test("the build rejects an invalid Company Tool JSON Schema", () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-invalid-tool-schema-"));
  cpSync(FIXTURE, root, { recursive: true });
  try {
    const path = join(root, "agents", "growth", "tools", "campaign-report", "TOOL.md");
    writeFileSync(path, readFileSync(path, "utf8").replace("input_schema:\n  type: object", "input_schema:\n  type: invented"));
    assert.throws(() => build(root), /not a valid JSON Schema/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the property campaign runs end to end through Tool SDK, resolved grants, Capabilities, and Sandbox Connectors", async () => {
  const artifact = build();
  const state = new InMemoryStateStore();
  const artifacts = new ArtifactSandboxConnector();
  const marketing = new MarketingSandboxConnector();
  const runtime = new CompanyOSRuntime({ artifact, state, connectors: [artifacts, marketing] });

  const publishedInput = {
    artifact_id: "listing-42-landing-page",
    content: "Approved fictional landing page",
    content_type: "text/html",
  };
  await runtime.requestApproval({ runId: "run-reference", stepId: "publish", agentId: "growth", grantId: "company:publish-asset", input: publishedInput });
  const published: any = await runtime.execute({
    runId: "run-reference",
    stepId: "publish",
    agentId: "growth",
    grantId: "company:publish-asset",
    input: publishedInput,
    approvingPrincipal: "test:solstice:avery",
  });
  assert.equal(published.output.url, "sandbox://artifacts/listing-42-landing-page");
  assert.equal(artifacts.artifacts.size, 1);

  const launchInput = {
    campaign_key: "listing-42",
    daily_budget: 20,
    days: 5,
    assets: ["listing-42-landing-page", "creative-a", "creative-b"],
  };
  await runtime.requestApproval({ runId: "run-reference", stepId: "launch", agentId: "growth", grantId: "company:launch-campaign", input: launchInput });
  const launched: any = await runtime.execute({
    runId: "run-reference",
    stepId: "launch",
    agentId: "growth",
    grantId: "company:launch-campaign",
    input: launchInput,
    approvingPrincipal: "test:solstice:avery",
  });
  assert.equal(launched.output.max_spend, 100);
  assert.equal(launched.output.simulated, true);

  await runtime.execute({
    runId: "run-reference",
    stepId: "conversion",
    agentId: "growth",
    grantId: "company:record-conversion",
    input: { campaign_key: "listing-42", asset: "creative-a", conversion_id: "conversion-1" },
  });
  const report: any = await runtime.execute({
    runId: "run-reference",
    stepId: "report",
    agentId: "growth",
    grantId: "company:campaign-report",
    input: { campaign_key: "listing-42" },
  });
  assert.equal(report.output.conversions, 1);

  const stopped: any = await runtime.execute({
    runId: "run-reference",
    stepId: "optimize",
    agentId: "growth",
    grantId: "company:stop-asset",
    input: { campaign_key: "listing-42", asset: "creative-b" },
  });
  assert.equal(stopped.output.stopped_asset, "creative-b");
  assert.equal(stopped.output.max_spend, 100, "a reversible optimization cannot increase approved spend");
  assert.equal(state.effects.size, 4, "publish, launch, conversion, and stop each own one idempotent effect");
});

test("agent identities cannot approve and stale content cannot consume an approval", async () => {
  const artifact = build();
  const state = new InMemoryStateStore();
  const runtime = new CompanyOSRuntime({
    artifact,
    state,
    connectors: [new ArtifactSandboxConnector(), new MarketingSandboxConnector()],
  });
  const first = { artifact_id: "asset-a", content: "first", content_type: "text/plain" };
  const changed = { artifact_id: "asset-a", content: "changed", content_type: "text/plain" };
  await runtime.requestApproval({ runId: "run-stale", stepId: "publish", agentId: "growth", grantId: "company:publish-asset", input: first });
  await runtime.requestApproval({ runId: "run-stale", stepId: "publish", agentId: "growth", grantId: "company:publish-asset", input: changed });
  const stale: any = await runtime.execute({
    runId: "run-stale",
    stepId: "publish",
    agentId: "growth",
    grantId: "company:publish-asset",
    input: first,
    approvingPrincipal: "test:solstice:avery",
  });
  assert.equal(stale.blocked, "input-hash-mismatch");

  const self: any = await runtime.execute({
    runId: "run-stale",
    stepId: "publish",
    agentId: "growth",
    grantId: "company:publish-asset",
    input: changed,
    approvingPrincipal: "test:solstice:growth-agent",
  });
  assert.equal(self.rejected, true);
  assert.match(self.reason, /agents never approve/);
});

test("the runtime refuses an installed but ungranted Tool", async () => {
  const runtime = new CompanyOSRuntime({
    artifact: build(),
    state: new InMemoryStateStore(),
    connectors: [new ArtifactSandboxConnector(), new MarketingSandboxConnector()],
  });
  await assert.rejects(() => runtime.execute({
    runId: "run-denied",
    stepId: "x",
    agentId: "growth",
    grantId: "company:not-granted",
    input: {},
  }), /not in agent 'growth' resolved ToolSet/);
});

test("an approved Connector failure is recorded as failed, never left dispatched", async () => {
  const state = new InMemoryStateStore();
  const runtime = new CompanyOSRuntime({
    artifact: build(),
    state,
    connectors: [{
      id: "oregano/artifact-sandbox",
      version: "1.0.0",
      capabilities: ["artifact.publish"],
      async invoke() { throw new Error("simulated connector failure"); },
    }, new MarketingSandboxConnector()],
  });
  const input = { artifact_id: "failure", content: "approved", content_type: "text/plain" };
  await runtime.requestApproval({
    runId: "run-failure", stepId: "publish", agentId: "growth", grantId: "company:publish-asset", input,
  });
  await assert.rejects(() => runtime.execute({
    runId: "run-failure",
    stepId: "publish",
    agentId: "growth",
    grantId: "company:publish-asset",
    input,
    approvingPrincipal: "test:solstice:avery",
  }), /simulated connector failure/);
  const effect = [...state.effects.values()][0];
  assert.equal(effect?.status, "failed");
});
