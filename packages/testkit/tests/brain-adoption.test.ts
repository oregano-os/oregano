import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { buildCompanyOSArtifact } from "../../companyos-builder/build.ts";
import type { InstanceBuildConfiguration } from "../../companyos-builder/types.ts";
import { BRAIN_READ_CAPABILITIES, BRAIN_CAPABILITIES } from "../../brain/tools.ts";
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
  const build = () => buildCompanyOSArtifact({ workspaceRoot: root, instance, coreVersion: "0.16.1", coreCommit: "1".repeat(40), workspaceCommit: "2".repeat(40), workbenchVersion: "0.1.0-experimental.24" });
  const adopt = (grants = BRAIN_READ_CAPABILITIES.map(contract => `oregano:brain/${contract.id.slice(6)}`)) => {
    const policy = YAML.parse(readFileSync(join(root, ".companyos/governance.yaml"), "utf8"));
    policy.runtime = { common_tool_grants: grants, brain_reading: "company-wide" };
    writeFileSync(join(root, ".companyos/governance.yaml"), YAML.stringify(policy));
    writeFileSync(join(root, ".companyos/brain.yaml"), YAML.stringify(brainConfig));
    writeFileSync(join(root, "connections/brain.md"), `---\ncapabilities: ${JSON.stringify(BRAIN_CAPABILITIES.map(contract => contract.id))}\n---\nBrain capability allowlist.\n`);
    instance.bindings.push(...BRAIN_CAPABILITIES.map(contract => ({ capability: contract.id, contractVersion: contract.version, connector: "oregano/brain", connectorVersion: "0.1.0" })));
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
      assert.equal(tools.length, 5); assert.ok(tools.every(tool => tool.grantSources?.includes("workspace-common")));
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

test("common seven-Tool and forget-withheld policies apply exactly to current and future Agents", () => {
  for (const withheld of [false, true]) {
    const f = fixture();
    try {
      f.adopt(BRAIN_CAPABILITIES.filter(item => !withheld || item.id !== "brain.forget").map(item => `oregano:brain/${item.id.slice(6)}`));
      f.instance.defaultAgentId = "growth"; cpSync(join(f.root, "agents/growth"), join(f.root, "agents/research"), { recursive: true });
      for (const agent of f.build().agents) {
        const tools = agent.toolSet.tools.filter(tool => tool.runtimeId.startsWith("oregano:brain/"));
        assert.equal(tools.length, withheld ? 6 : 7);
        assert.equal(tools.some(tool => tool.runtimeId === "oregano:brain/forget"), !withheld);
        assert.equal(agent.instructions.includes("- forget:"), !withheld);
        assert.equal(tools.find(tool => tool.runtimeId === "oregano:brain/remember")?.risk, "R1");
      }
    } finally { f.cleanup(); }
  }
});

test("the actual Agent Tool path reconciles lost Git and saved/pending effects with current authority", async () => {
  const { CompanyOSRuntime } = await import("../../runtime/companyos-runtime.ts");
  const { BrainWrites } = await import("../../brain/writes.ts");
  const { InMemoryStateStore } = await import("../../runtime/memory-state.ts");
  const { InMemoryCompanyRecordsStore } = await import("../../records/memory-store.ts");
  const { CapabilityEffectOutcomeUnknownError } = await import("../../capabilities/contracts.ts");
  for (const risk of ["R1", "R3"] as const) for (const failure of ["lost-git", "pending-sync", ...(risk === "R1" ? ["tool-timeout"] : [])]) {
    const f = fixture();
    try {
      f.adopt(["oregano:brain/remember", "oregano:brain/entity", "oregano:brain/delta"]);
      const artifact = f.build(), state = new InMemoryStateStore(), store = new InMemoryBrainStore(), leases = new InMemoryCompanyRecordsStore();
      const scope = { instance_id: artifact.instance.id, repository_id: "example/company" }, binding = { instanceId: scope.instance_id, repositoryId: scope.repository_id, bindingId: "repository", branch: "brain-test" };
      let head = "a".repeat(40), files: Record<string, string> = structuredClone(brainFiles), commits = 0, reconciliations = 0;
      let receipt: import("../../runtime/repository/contracts.ts").BrainRepositoryCommitReceipt | undefined;
      let releaseCommit: (() => void) | undefined;
      const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
      if (risk === "R3") artifact.agents.find(agent => agent.id === "growth")!.toolSet.tools.find(tool => tool.runtimeId === "oregano:brain/remember")!.risk = "R3";
      const repository: import("../../runtime/repository/contracts.ts").BrainRepositoryMutationSource = {
        brainRevision: async () => head, brainFiles: async (_binding, revision) => structuredClone(revision === "a".repeat(40) ? brainFiles : files),
        brainCommit: async request => {
          commits++; head = "b".repeat(40);
          for (const change of request.changes) change.markdown === null ? delete files[change.path] : files[change.path] = change.markdown;
          receipt = { repositoryId: binding.repositoryId, branch: binding.branch, baseCommit: request.baseCommit, commit: head, operationId: request.operationId, inputDigest: request.inputDigest };
          if (failure === "lost-git") throw new CapabilityEffectOutcomeUnknownError("Lost provider receipt", { operation_id: request.operationId });
          if (failure === "tool-timeout") await commitGate;
          return receipt;
        }, brainFindCommit: async () => { reconciliations++; return receipt; },
      };
      const publish = store.publish.bind(store);
      if (failure === "pending-sync") store.publish = async () => { throw new Error("Index unavailable"); };
      const connector = new BrainConnector({ artifact, reads: new BrainReads(store, scope), writes: () => new BrainWrites({ scope, binding, configuration: brainConfig, store, effects: state, leases, repository }) });
      const runtime = new CompanyOSRuntime({ artifact, state, connectors: [connector], ...(failure === "tool-timeout" ? { toolExecutionTimeoutMs: 3000 } : {}) });
      const path = "brain/topics/expansion.md", request = { runId: "write-run", stepId: "remember", agentId: "growth", grantId: "oregano:brain/remember", subjectPrincipal: "test:solstice:morgan",
        input: { changes: { expected_revision: head, pages: [{ path, expected_content_hash: sha256(files[path]), markdown: files[path].replace("No shared decision yet.", "A source review is pending.") }] },
          provenance: { source_id: "review:1", source_version: "v1", action: "update", evidence: ["sources/review"] }, operation_key: "review:1:v1:update" } };
      if (risk === "R3") {
        assert.equal((await runtime.execute(request) as any).rejected, true); assert.equal(commits, 0);
        await runtime.requestApproval(request);
      }
      const approved = { ...request, ...(risk === "R3" ? { approvingPrincipal: "test:solstice:morgan" } : {}) };
      if (failure !== "pending-sync") await assert.rejects(runtime.execute(approved), CapabilityEffectOutcomeUnknownError);
      else assert.equal(((await runtime.execute(approved)) as any).output.sync_status, "pending");
      if (failure === "tool-timeout") {
        releaseCommit!();
        // The interrupted subprocess cannot cancel an in-flight provider response.
        // Wait for that exact callback to settle before proving read-only recovery.
        for (let attempt = 0; attempt < 1000 && ![...state.effects.values()].some(effect => effect.status === "succeeded"); attempt++) await new Promise(resolve => setImmediate(resolve));
        assert.ok([...state.effects.values()].some(effect => effect.status === "succeeded"));
      }
      assert.equal(commits, 1);
      await assert.rejects(runtime.execute({ ...request, subjectPrincipal: "not-in-roster" }), /authenticated company subject/);
      store.publish = publish;
      const recovered = await runtime.execute(request) as any;
      assert.equal(recovered.output.sync_status, "indexed"); assert.equal(recovered.output.saved_commit, head); assert.equal(commits, 1);
      assert.equal(reconciliations, failure === "lost-git" ? 1 : 0);
      if (risk === "R3") {
        assert.equal(state.approvals.size, 1, "Receipt reconciliation consumes no new approval");
        const original = state.getEffectApproval.bind(state); state.getEffectApproval = async () => undefined;
        await assert.rejects(runtime.execute(request), /original consumed approval/);
        state.getEffectApproval = original;
      }
      assert.ok(state.events.some(event => event.event === "tool.effect-reconciled"));
      assert.ok(!JSON.stringify(state.events).includes("A source review is pending."));
      await assert.rejects(runtime.execute({ ...request, grantId: "oregano:brain/forget" }), /resolved ToolSet/);
    } finally { f.cleanup(); }
  }
});

test("a durable Workflow resumes Brain receipt/index recovery across worker invocations without another commit", async () => {
  const { WorkflowEngine } = await import("../../runtime/workflow-engine/engine.ts");
  const { InMemoryWorkflowExecutionStore } = await import("../../runtime/workflow-engine/memory-store.ts");
  const { InMemoryDurableTimerStore } = await import("../../runtime/memory-durable-timers.ts");
  const { DurableTimerService } = await import("../../runtime/durable-timers.ts");
  const { InMemoryCompanyRecordsStore } = await import("../../records/memory-store.ts");
  const { BrainWrites } = await import("../../brain/writes.ts");
  const { CapabilityEffectOutcomeUnknownError } = await import("../../capabilities/contracts.ts");
  for (const failure of ["lost-git", "pending-sync", "operator-recovery"]) {
    const f = fixture();
    try {
      f.adopt(["oregano:brain/remember", "oregano:brain/entity"]);
      const path = "brain/topics/expansion.md", input = { changes: { expected_revision: "a".repeat(40), pages: [{ path, expected_content_hash: sha256(brainFiles[path]),
        markdown: brainFiles[path].replace("No shared decision yet.", "A bounded Workflow update.") }] }, provenance: { source_id: "review:1", source_version: "v1", action: "update", evidence: ["sources/review"] }, operation_key: "workflow:source:1:v1" };
      const declaration = { type: "workflow", id: "brain-update", version: 1, owner: "agents/growth", execution_mode: "unattended", trigger: "operator",
        steps: [{ save: "oregano:brain/remember", input, then: "end" }] };
      writeFileSync(join(f.root, "workflows/brain-update.md"), `---\n${YAML.stringify(declaration)}---\n# Brain update\n\n1. [growth, R1] Save evidenced knowledge. <!-- step:save -->\n`);
      const artifact = f.build(), executions = new InMemoryWorkflowExecutionStore(), store = new InMemoryBrainStore(), leases = new InMemoryCompanyRecordsStore();
      const scope = { instance_id: artifact.instance.id, repository_id: "example/company" }, binding = { instanceId: scope.instance_id, repositoryId: scope.repository_id, bindingId: "repository", branch: "brain-test" };
      let now = "2030-01-01T00:00:00.000Z", head = "a".repeat(40), files: Record<string, string> = structuredClone(brainFiles), commits = 0;
      let receipt: import("../../runtime/repository/contracts.ts").BrainRepositoryCommitReceipt | undefined, proofAvailable = failure !== "operator-recovery";
      const repository: import("../../runtime/repository/contracts.ts").BrainRepositoryMutationSource = {
        brainRevision: async () => head, brainFiles: async (_binding, revision) => structuredClone(revision === "a".repeat(40) ? brainFiles : files),
        brainCommit: async request => {
          commits++; head = "b".repeat(40); files[path] = request.changes[0].markdown!;
          receipt = { repositoryId: binding.repositoryId, branch: binding.branch, baseCommit: request.baseCommit, commit: head, operationId: request.operationId, inputDigest: request.inputDigest };
          if (failure !== "pending-sync") throw new CapabilityEffectOutcomeUnknownError("Lost receipt", { operation_id: request.operationId });
          return receipt;
        }, brainFindCommit: async () => proofAvailable ? receipt : undefined,
      };
      const publish = store.publish.bind(store);
      if (failure === "pending-sync") store.publish = async () => { throw new Error("Index temporarily unavailable"); };
      const connector = new BrainConnector({ artifact, reads: new BrainReads(store, scope), writes: () => new BrainWrites({ scope, binding, configuration: brainConfig,
        store, effects: executions.control, leases, repository, now: () => new Date(now) }) });
      const principal = "test:solstice:morgan", timers = new DurableTimerService({ instanceId: scope.instance_id, store: new InMemoryDurableTimerStore() });
      const engine = () => new WorkflowEngine({ artifact, store: executions, control: executions.control, timers,
        enabledWorkflowIds: ["brain-update"], operatorPrincipals: [principal], currentRoster: async () => artifact.roster, connectors: async () => [connector],
        qualifyMessageDestinations: async () => { throw new Error("Unexpected messaging"); }, conversationForReceipt: async () => { throw new Error("Unexpected conversation"); }, clock: () => now });
      let run = await engine().openOperator({ workflowId: "brain-update", requestId: "source:1", principal, fields: {} });
      run = (await engine().advance(run.runId))!;
      assert.equal(run.state.status, "waiting"); assert.equal(run.state.wait?.kind, "effect"); assert.equal(run.state.blocked, undefined); assert.equal(commits, 1);
      store.publish = publish; now = failure === "operator-recovery" ? "2030-01-01T00:16:00.000Z" : "2030-01-01T00:01:00.000Z";
      await engine().timers(); run = (await engine().advance(run.runId))!;
      if (failure === "operator-recovery") {
        assert.ok(run.state.blocked); proofAvailable = true;
        await engine().resume(run.runId, principal); run = (await engine().advance(run.runId))!;
      }
      assert.equal(run.state.status, "done"); assert.equal((run.state.steps.save?.output as any).sync_status, "indexed"); assert.equal(commits, 1);
      assert.equal((await executions.list({ instanceId: scope.instance_id, limit: 20 })).length, 1, "Recovery retains one durable run");
    } finally { f.cleanup(); }
  }
});

test("maintained Brain writes preserve typed validation failures across the isolated Tool worker", async () => {
  const { CompanyOSRuntime } = await import("../../runtime/companyos-runtime.ts");
  const { BrainWrites } = await import("../../brain/writes.ts");
  const { BrainError } = await import("../../brain/contracts.ts");
  const { InMemoryStateStore } = await import("../../runtime/memory-state.ts");
  const { InMemoryCompanyRecordsStore } = await import("../../records/memory-store.ts");
  const f = fixture();
  try {
    f.adopt(["oregano:brain/remember"]);
    const artifact = f.build(), state = new InMemoryStateStore(), store = new InMemoryBrainStore(), leases = new InMemoryCompanyRecordsStore();
    const scope = { instance_id: artifact.instance.id, repository_id: "example/company" };
    const binding = { instanceId: scope.instance_id, repositoryId: scope.repository_id, bindingId: "repository", branch: "brain-test" };
    let writes = 0;
    const repository = { brainRevision: async () => "a".repeat(40), brainFiles: async () => structuredClone(brainFiles),
      brainFindCommit: async () => undefined, brainCommit: async () => { writes++; throw new Error("No invalid write may reach the provider"); } };
    const connector = new BrainConnector({ artifact, reads: new BrainReads(store, scope), writes: () => new BrainWrites({ scope, binding,
      configuration: brainConfig, store, effects: state, leases, repository }) });
    const runtime = new CompanyOSRuntime({ artifact, state, connectors: [connector], workflowContext: { read: async () => undefined } });
    const path = "brain/topics/expansion.md";
    for (const code of ["write_conflict", "invalid_batch"]) {
      const input = { changes: { expected_revision: "a".repeat(40), pages: [{ path,
        expected_content_hash: sha256(code === "write_conflict" ? "stale content" : brainFiles[path]),
        markdown: code === "invalid_batch" ? "Missing frontmatter" : brainFiles[path] }] },
        provenance: { source_id: "review:1", source_version: "v1", action: "update", evidence: ["sources/review"] }, operation_key: `failure:${code}` };
      await assert.rejects(runtime.execute({ runId: `failure-${code}`, stepId: "save", agentId: "growth", grantId: "oregano:brain/remember",
        subjectPrincipal: "test:solstice:morgan", input }), error => error instanceof BrainError && error.code === code);
      const event = state.events.find(event => event.runId === `failure-${code}` && event.event === "tool.effect-failed");
      assert.equal((event?.evidence as { code?: string })?.code, code);
      const altered = structuredClone(artifact);
      const wrapper = altered.agents.find(agent => agent.id === "growth")!.tools.find(tool => tool.contract.runtimeId === "oregano:brain/remember")!;
      wrapper.compiledSource += "\n// A separately authored wrapper.\n";
      wrapper.sourceDigest = sha256(wrapper.compiledSource);
      const customRuntime = new CompanyOSRuntime({ artifact: altered, state, connectors: [connector], workflowContext: { read: async () => undefined } });
      await assert.rejects(customRuntime.execute({ runId: `wrapper-${code}`, stepId: "save", agentId: "growth", grantId: "oregano:brain/remember",
        subjectPrincipal: "test:solstice:morgan", input: { ...input, operation_key: `wrapper-failure:${code}` } }), error => error instanceof Error && !(error instanceof BrainError));
    }
    assert.equal(writes, 0);
  } finally { f.cleanup(); }
});

test("a continuing Agent saves Brain knowledge before completion and recovers a lost snapshot without a second commit", async () => {
  const { mkdirSync } = await import("node:fs");
  const { WorkflowEngine } = await import("../../runtime/workflow-engine/engine.ts");
  const { InMemoryWorkflowExecutionStore } = await import("../../runtime/workflow-engine/memory-store.ts");
  const { InMemoryDurableTimerStore } = await import("../../runtime/memory-durable-timers.ts");
  const { DurableTimerService } = await import("../../runtime/durable-timers.ts");
  const { InMemoryCompanyRecordsStore } = await import("../../records/memory-store.ts");
  const { BrainWrites } = await import("../../brain/writes.ts");
  const f = fixture();
  try {
    f.adopt(["oregano:brain/remember", "oregano:brain/entity"]);
    const skill = "agents/growth/skills/brain-task/SKILL.md";
    mkdirSync(join(f.root, "agents/growth/skills/brain-task"), { recursive: true });
    writeFileSync(join(f.root, skill), "---\nname: brain-task\ndescription: Synthetic incremental task.\n---\nSave and read the fictional page.\n");
    const path = "brain/topics/expansion.md", input = { changes: { expected_revision: "a".repeat(40), pages: [{ path,
      expected_content_hash: sha256(brainFiles[path]), markdown: brainFiles[path].replace("No shared decision yet.", "A sourced incremental update.") }] },
      provenance: { source_id: "review:1", source_version: "v1", action: "update", evidence: ["sources/review"] }, operation_key: "agent-source-v1-update" };
    const declaration = { type: "workflow", id: "brain-update", version: 1, owner: "agents/growth", execution_mode: "unattended", trigger: "operator",
      steps: [{ work: "agent", context: { source: "Synthetic retained original" }, instructions: [skill], profile: "reasoning", task: "brain.test",
        tools: [{ tool: "oregano:brain/remember", bind: { provenance: input.provenance } }, { tool: "oregano:brain/entity" }],
        output_schema: { type: "object", properties: { verified: { const: true } }, required: ["verified"] }, budget: { turns: 3, tool_calls: 6, output_tokens: 8000 } }] };
    writeFileSync(join(f.root, "workflows/brain-update.md"), `---\n${YAML.stringify(declaration)}---\n1. [growth, R1] Save and verify. <!-- step:work -->\n`);
    const artifact = f.build(), executions = new InMemoryWorkflowExecutionStore(), store = new InMemoryBrainStore(), leases = new InMemoryCompanyRecordsStore();
    const scope = { instance_id: artifact.instance.id, repository_id: "example/company" }, binding = { instanceId: scope.instance_id, repositoryId: scope.repository_id, bindingId: "repository", branch: "brain-test" };
    let now = "2030-01-01T00:00:00.000Z", head = "a".repeat(40), commits = 0, models = 0, files: Record<string, string> = structuredClone(brainFiles);
    let receipt: import("../../runtime/repository/contracts.ts").BrainRepositoryCommitReceipt | undefined;
    const repository: import("../../runtime/repository/contracts.ts").BrainRepositoryMutationSource = {
      brainRevision: async () => head, brainFiles: async (_binding, revision) => structuredClone(revision === "a".repeat(40) ? brainFiles : files),
      brainCommit: async request => { commits++; head = "b".repeat(40); files[path] = request.changes[0]!.markdown!;
        return receipt = { repositoryId: binding.repositoryId, branch: binding.branch, baseCommit: request.baseCommit, commit: head, operationId: request.operationId, inputDigest: request.inputDigest }; },
      brainFindCommit: async () => receipt,
    };
    const connector = new BrainConnector({ artifact, reads: new BrainReads(store, scope), writes: () => new BrainWrites({ scope, binding,
      configuration: brainConfig, store, effects: executions.control, leases, repository, now: () => new Date(now) }) });
    const principal = "test:solstice:morgan", timers = new DurableTimerService({ instanceId: scope.instance_id, store: new InMemoryDurableTimerStore() });
    const engine = () => new WorkflowEngine({ artifact, store: executions, control: executions.control, timers,
      enabledWorkflowIds: ["brain-update"], operatorPrincipals: [principal], currentRoster: async () => artifact.roster, connectors: async () => [connector],
      qualifyMessageDestinations: async () => { throw new Error("Unexpected messaging"); }, conversationForReceipt: async () => { throw new Error("Unexpected conversation"); }, clock: () => now,
      agentGenerator: async request => {
        await request.beforeDispatch({ model: "synthetic/test", profile: "reasoning", route: "openai-compatible" } as any,
          { system_prompt_digest: "c".repeat(64), system_instruction_characters: 10 });
        models++;
        const calls: import("../../state-store/workflow-engine.ts").WorkflowAgentResponse["calls"] = models === 1 ? [{ id: "save", name: "oregano_brain_remember", input }]
          : [{ id: "read", name: "oregano_brain_entity", input: { name: "topics/expansion" } }, { id: "finish", name: "companyos_finish_task", input: { verified: true } }];
        if (models === 2) assert.equal((request.turns[0]!.results[0]!.output as any).saved_commit, head);
        return { response: { messages: [], text: "", calls, finishReason: "tool-calls" }, evidence: { synthetic: true } };
      } });
    let run = await engine().openOperator({ workflowId: "brain-update", requestId: "source:1", principal, fields: {} });
    await engine().step(run.runId); await engine().step(run.runId);
    const commit = executions.commit.bind(executions); let drop = true;
    executions.commit = async args => { if (drop && args.event.name === "workflow.agent-tool-completed") { drop = false; return undefined; } return commit(args); };
    run = (await engine().step(run.runId))!;
    assert.equal(commits, 1); assert.equal(models, 1); assert.equal(run.state.status, "running"); assert.ok(files[path]!.includes("A sourced incremental update."));
    now = "2030-01-01T00:06:00.000Z";
    run = (await engine().advance(run.runId))!;
    assert.equal(run.state.status, "done", JSON.stringify(run.state.blocked)); assert.equal(commits, 1); assert.equal(models, 2);
    assert.equal((run.state.steps.work!.agent!.turns[1]!.results[0]!.output as any).page.markdown, files[path]);
    const proof = await engine().verify(run.runId, principal);
    assert.deepEqual(proof.checks.filter(check => !check.passed && !check.code.startsWith("required-")), [], "Retrospective proof must verify dynamic Agent calls and the saved effect");
    assert.equal(proof.counts.effects, 1);
  } finally { f.cleanup(); }
});
