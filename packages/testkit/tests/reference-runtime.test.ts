import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CapabilityEffectOutcomeUnknownError } from "../../capabilities/contracts.ts";
import { buildCompanyOSArtifact } from "../../companyos-builder/build.ts";
import type { InstanceBuildConfiguration } from "../../companyos-builder/types.ts";
import { ArtifactSandboxConnector, MarketingSandboxConnector } from "../../connectors/sandbox.ts";
import { CompanyOSRuntime } from "../../runtime/companyos-runtime.ts";
import { STANDARD_WORK_ITEM_TOOLS } from "../../standard-tools/work-items.ts";
import { InMemoryStateStore } from "../adapter/in-memory-state.ts";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "reference-company");
const CORE_COMMIT = "1".repeat(40);
const WORKSPACE_COMMIT = "2".repeat(40);
const instance: InstanceBuildConfiguration = {
  version: 1,
  instanceId: "solstice-demo",
  environment: "test",
  agentBindings: [],
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
  assert.deepEqual(first.connectors, []);
  assert.equal(first.agents[0].toolSet.tools.length, 5);
  assert.equal(first.roster.length, 3);
  assert.ok(first.agents[0].materials["workflows/property-campaign.md"]);
  assert.equal(first.agents[0].materials["connections/marketing.md"], undefined, "undeclared material must stay out of the agent snapshot");
});

test("the Artifact freezes non-secret runtime Connector installation configuration", () => {
  const artifact = buildCompanyOSArtifact({
    workspaceRoot: FIXTURE,
    instance: {
      ...instance,
      connectors: [{
        id: "slack-test",
        connector: "oregano/slack-communication",
        connectorVersion: "0.1.0",
        configuration: {
          destinations: [{ id: "test-channel", account_id: "T12345", kind: "channel", channel_id: "C12345" }],
        },
      }],
    },
    coreVersion: "0.5.8",
    coreCommit: CORE_COMMIT,
    workspaceCommit: WORKSPACE_COMMIT,
    workbenchVersion: "0.1.0-experimental.15",
    builtAt: "2026-09-02T12:00:00.000Z",
  });
  assert.deepEqual(artifact.connectors, [{
    id: "slack-test",
    connector: "oregano/slack-communication",
    connectorVersion: "0.1.0",
    configuration: {
      destinations: [{ id: "test-channel", account_id: "T12345", kind: "channel", channel_id: "C12345" }],
    },
  }]);
  assert.doesNotMatch(JSON.stringify(artifact), /xoxb-|MONDAY_API_TOKEN=/);
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

test("Artifact building resolves the provider-neutral Sprint standard Tools when explicitly granted and bound", () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-sprint-standard-tools-"));
  cpSync(FIXTURE, root, { recursive: true });
  try {
    const agentPath = join(root, "agents", "growth", "instructions.md");
    writeFileSync(agentPath, readFileSync(agentPath, "utf8").replace(
      "  - company:stop-asset\n",
      "  - company:stop-asset\n  - oregano:records/query\n  - oregano:work-items/read\n  - oregano:work-items/update\n  - oregano:work-items/comment\n  - oregano:communications/publish\n",
    ));
    const connectionPath = join(root, "connections", "marketing.md");
    writeFileSync(connectionPath, readFileSync(connectionPath, "utf8").replace(
      "  - conversion.record\n",
      "  - conversion.record\n  - records.query\n  - work-item.read\n  - work-item.update\n  - work-item.comment\n  - communication.message.publish\n",
    ));
    const sprintCapabilities = [
      "records.query",
      "work-item.read",
      "work-item.update",
      "work-item.comment",
      "communication.message.publish",
    ];
    const artifact = buildCompanyOSArtifact({
      workspaceRoot: root,
      instance: {
        ...instance,
        bindings: [
          ...instance.bindings,
          ...sprintCapabilities.map((capability) => ({
            capability,
            contractVersion: capability === "records.query" ? "2.0.0" : "1.0.0",
            connector: "oregano/synthetic-sprint-connector",
            connectorVersion: "1.0.0",
          })),
        ],
      },
      coreVersion: "0.5.3",
      coreCommit: CORE_COMMIT,
      workspaceCommit: WORKSPACE_COMMIT,
      workbenchVersion: "0.1.0-experimental.10",
      builtAt: "2026-08-31T12:00:00.000Z",
    });
    const runtimeIds = artifact.agents[0].tools.map((tool) => tool.contract.runtimeId);
    for (const runtimeId of [
      "oregano:records/query",
      "oregano:work-items/read",
      "oregano:work-items/update",
      "oregano:work-items/comment",
      "oregano:communications/publish",
    ]) assert.ok(runtimeIds.includes(runtimeId), runtimeId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Artifact building compiles portable Agent handoff rules without merging Agent ToolSets", () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-agent-handoff-"));
  cpSync(FIXTURE, root, { recursive: true });
  try {
    const sprintRoot = join(root, "agents", "sprint");
    mkdirSync(sprintRoot, { recursive: true });
    writeFileSync(join(sprintRoot, "instructions.md"), `---
description: Synthetic Sprint Agent.
scope:
  read:
    - company.md
---
# Sprint
Synthetic target Agent.
`);
    const agentPath = join(root, "agents", "growth", "instructions.md");
    writeFileSync(agentPath, readFileSync(agentPath, "utf8").replace(
      "scope:\n",
      `handoffs:
  - id: growth-to-sprint
    target: sprint
    purpose: sprint
    surfaces: [slack]
    eligible_roles: [contributor]
    eligible_groups: [sprint-participant]
    ttl_seconds: 3600
scope:
`,
    ));
    const artifact = buildCompanyOSArtifact({
      workspaceRoot: root,
      instance: { ...instance, defaultAgentId: "growth" },
      coreVersion: "0.5.3",
      coreCommit: CORE_COMMIT,
      workspaceCommit: WORKSPACE_COMMIT,
      workbenchVersion: "0.1.0-experimental.10",
      builtAt: "2026-09-01T12:00:00.000Z",
    });
    assert.deepEqual(artifact.agentRouting.handoffs, [{
      id: "growth-to-sprint",
      fromAgentId: "growth",
      toAgentId: "sprint",
      purpose: "sprint",
      surfaces: ["slack"],
      eligibleRoles: ["contributor"],
      eligibleGroups: ["sprint-participant"],
      ttlSeconds: 3600,
    }]);
    assert.equal(artifact.agents.find((agent) => agent.id === "sprint")?.toolSet.tools.length, 0);
    assert.ok((artifact.agents.find((agent) => agent.id === "growth")?.toolSet.tools.length ?? 0) > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Artifact building compiles a reviewed local-day-end handoff expiry", () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-agent-handoff-local-day-"));
  cpSync(FIXTURE, root, { recursive: true });
  try {
    const sprintRoot = join(root, "agents", "sprint");
    mkdirSync(sprintRoot, { recursive: true });
    writeFileSync(join(sprintRoot, "instructions.md"), `---
description: Synthetic Sprint Agent.
scope:
  read:
    - company.md
---
# Sprint
Synthetic target Agent.
`);
    const agentPath = join(root, "agents", "growth", "instructions.md");
    writeFileSync(agentPath, readFileSync(agentPath, "utf8").replace(
      "scope:\n",
      `handoffs:
  - id: growth-to-sprint
    target: sprint
    purpose: sprint
    surfaces: [slack]
    eligible_roles: [contributor]
    eligible_groups: [sprint-participant]
    expiry:
      mode: local-day-end
      timezone: Europe/Madrid
scope:
`,
    ));
    const artifact = buildCompanyOSArtifact({
      workspaceRoot: root,
      instance: { ...instance, defaultAgentId: "growth" },
      coreVersion: "0.5.8",
      coreCommit: CORE_COMMIT,
      workspaceCommit: WORKSPACE_COMMIT,
      workbenchVersion: "0.1.0-experimental.15",
      builtAt: "2026-09-02T12:00:00.000Z",
    });
    assert.deepEqual(artifact.agentRouting.handoffs, [{
      id: "growth-to-sprint",
      fromAgentId: "growth",
      toAgentId: "sprint",
      purpose: "sprint",
      surfaces: ["slack"],
      eligibleRoles: ["contributor"],
      eligibleGroups: ["sprint-participant"],
      localDayEndTimeZone: "Europe/Madrid",
    }]);
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

  const conversionRequest = {
    runId: "run-reference",
    stepId: "conversion",
    agentId: "growth",
    grantId: "company:record-conversion",
    input: { campaign_key: "listing-42", asset: "creative-a", conversion_id: "conversion-1" },
  };
  const conversion = await runtime.execute(conversionRequest);
  const conversionReplay = await runtime.execute(conversionRequest);
  assert.deepEqual(conversionReplay, conversion, "a completed idempotent effect replays its stored evidence");
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

test("a reversible Tool executes only after confirmation by its exact active human subject", async () => {
  const artifact: any = structuredClone(build());
  const confirmed = STANDARD_WORK_ITEM_TOOLS.find((tool) => tool.contract.grantId === "oregano:work-items/confirmed-update")!;
  const agent = artifact.agents.find((candidate: any) => candidate.id === "growth")!;
  agent.tools.push(confirmed);
  agent.toolSet.tools.push({
    grantId: confirmed.contract.grantId,
    runtimeId: confirmed.contract.runtimeId,
    version: confirmed.contract.version,
    risk: "R2",
    capabilities: [{ id: "work-item.update", version: "1.0.0", connector: "fixture/work-items", connectorVersion: "1.0.0" }],
    contractDigest: "d".repeat(64),
  });
  artifact.bindings.push({ capability: "work-item.update", contractVersion: "1.0.0", connector: "fixture/work-items", connectorVersion: "1.0.0" });
  let effects = 0;
  const runtime = new CompanyOSRuntime({
    artifact,
    state: new InMemoryStateStore(),
    connectors: [new ArtifactSandboxConnector(), new MarketingSandboxConnector(), {
      id: "fixture/work-items",
      version: "1.0.0",
      capabilities: ["work-item.update"],
      async invoke() {
        effects += 1;
        return {
          output: { work_item: {}, previous_version: "v1", provider_version: "v2", changed_fields: ["brief"] },
          evidence: { resource_binding: "sprint-board", work_item_id: "item-1", previous_version: "v1", provider_version: "v2", changed_fields: ["brief"] },
        };
      },
    }],
  });
  const request = {
    runId: "run-confirmed",
    stepId: "briefing",
    agentId: "growth",
    grantId: confirmed.contract.grantId,
    subjectPrincipal: "test:solstice:avery",
    input: { resource_binding: "sprint-board", work_item_id: "item-1", changes: { brief: "Reviewed" }, expected_version: "v1" },
  };
  await assert.rejects(() => runtime.execute(request), /requires executeConfirmed/);
  await assert.rejects(() => runtime.executeConfirmed(request, "test:solstice:morgan"), /does not match/);
  assert.equal(effects, 0);
  const result: any = await runtime.executeConfirmed(request, "test:solstice:avery");
  assert.equal(result.output.provider_version, "v2");
  assert.equal(effects, 1);
});

test("the runtime accepts only an explicitly bounded Tool execution window", () => {
  const base = {
    artifact: build(),
    state: new InMemoryStateStore(),
    connectors: [new ArtifactSandboxConnector(), new MarketingSandboxConnector()],
  };
  assert.doesNotThrow(() => new CompanyOSRuntime({ ...base, toolExecutionTimeoutMs: 30_000 }));
  assert.throws(() => new CompanyOSRuntime({ ...base, toolExecutionTimeoutMs: 99 }), /100 to 120000 ms/u);
  assert.throws(() => new CompanyOSRuntime({ ...base, toolExecutionTimeoutMs: 120_001 }), /100 to 120000 ms/u);
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

test("an approved provider effect with an unverifiable receipt is recorded as unknown", async () => {
  const state = new InMemoryStateStore();
  const runtime = new CompanyOSRuntime({
    artifact: build(),
    state,
    connectors: [{
      id: "oregano/artifact-sandbox",
      version: "1.0.0",
      capabilities: ["artifact.publish"],
      async invoke() {
        throw new CapabilityEffectOutcomeUnknownError("provider receipt incomplete", { provider_id: "possibly-created" });
      },
    }, new MarketingSandboxConnector()],
  });
  const input = { artifact_id: "unknown", content: "approved", content_type: "text/plain" };
  await runtime.requestApproval({ runId: "run-unknown", stepId: "publish", agentId: "growth", grantId: "company:publish-asset", input });
  await assert.rejects(() => runtime.execute({
    runId: "run-unknown",
    stepId: "publish",
    agentId: "growth",
    grantId: "company:publish-asset",
    input,
    approvingPrincipal: "test:solstice:avery",
  }), /complete outcome could not be verified/);
  const effect = [...state.effects.values()][0];
  assert.equal(effect?.status, "unknown");
  assert.deepEqual((effect?.evidence as any).partial_evidence, {
    capability_effects: [{ provider_id: "possibly-created" }],
  });
});


test("runtime approval requests preserve an explicit workflow deadline and reject expiry", async () => {
  const state = new InMemoryStateStore();
  const runtime = new CompanyOSRuntime({ artifact: build(), state, connectors: [new ArtifactSandboxConnector(), new MarketingSandboxConnector()] });
  const request = { runId: "run-deadline", stepId: "publish", agentId: "growth", grantId: "company:publish-asset", input: { artifact_id: "bounded", content: "reviewed", content_type: "text/plain" } };
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
  await runtime.requestApproval(request, { expiresAt });
  assert.equal(state.requests[0]!.expiresAt!.getTime(), expiresAt.getTime());
  state.requests[0]!.expiresAt = new Date(0);
  const result: any = await runtime.execute({ ...request, approvingPrincipal: "test:solstice:avery" });
  assert.equal(result.rejected, true);
  assert.match(result.reason, /expired/);
  assert.equal(state.effects.size, 0);
});
