import assert from "node:assert/strict";
import { test } from "node:test";
import { collectionFixture } from "../workflow-collection-fixture.ts";
import { engineFixture, ENGINE_OPERATOR, ENGINE_OWNER } from "../workflow-engine-fixture.ts";
import { CollectionNeedsInput } from "../../runtime/workflow-engine/collection.ts";
import { inspectAndCompileCompanyTool } from "../../tool-sdk/source-inspector.ts";
import { sha256 } from "../../runtime/canonical.ts";
import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";

function validatedArtifact(mutate?: (artifact: CompanyOSArtifact) => void) {
  const artifact = structuredClone(collectionFixture().artifact);
  const workflow = artifact.workflows!.find(w => w.id === "monday-handoff")!;
  const agent = artifact.agents.find(a => a.id === workflow.agentId)!;
  const template = agent.tools.find(t => t.contract.risk === "R0" && t.contract.capabilities.length === 0)!;
  const tool = structuredClone(template);
  Object.assign(tool.contract, {
    grantId: "company:check-draft", runtimeId: "company:sprint/check-draft", toolId: "check-draft",
    inputSchema: { type: "object", required: ["context", "facts"], additionalProperties: false, properties: {
      context: { type: "object" }, facts: { type: "object", required: ["summary"], additionalProperties: false, properties: { summary: { type: "string" } } },
    } },
    outputSchema: { type: "object", required: ["accepted", "feedback"], additionalProperties: false, properties: { accepted: { type: "boolean" }, feedback: { type: "string", maxLength: 2000 } } },
  });
  const source = 'import { defineCompanyTool } from "@companyos/tool-sdk"; export default defineCompanyTool({ execute(input) { return { accepted: input.facts.summary === "Complete discussed draft", feedback: "Ask for the missing outcome." }; } });';
  const compiled = inspectAndCompileCompanyTool(source);
  assert.deepEqual(compiled.diagnostics, []);
  tool.compiledSource = compiled.compiledSource!; tool.sourceDigest = sha256(source);
  const grant = { grantId: tool.contract.grantId, runtimeId: tool.contract.runtimeId, version: tool.contract.version, risk: "R0" as const, capabilities: [], contractDigest: sha256(tool.contract) };
  agent.tools.push(tool); agent.toolSet.tools.push(grant);
  workflow.steps[1]!.collect!.validator = structuredClone(grant);
  mutate?.(artifact);
  const { manifestHash, ...manifest } = workflow; workflow.manifestHash = sha256(manifest);
  const { artifactHash, ...content } = artifact; artifact.artifactHash = sha256({ ...content, provenance: { ...content.provenance, builtAt: undefined } });
  return artifact;
}

async function waiting(artifact = validatedArtifact()) {
  const h = engineFixture({ artifact });
  const opened = await h.engine().openOperator({ workflowId: "monday-handoff", requestId: "checked-conversation", principal: ENGINE_OPERATOR,
    fields: { sprint_id: "one", period_start: "2030-01-07", period_end: "2030-01-11" } });
  const run = (await h.engine().advance(opened.runId))!;
  const conversation = h.conversation("direct-jonas-owner", run.state.steps.ask!.output!);
  const submit = (summary: string) => h.engine().collect({ principal: ENGINE_OWNER, conversation, eventId: "answer", output: { summary } });
  return { h, run, conversation, submit };
}

test("pure validation rejects before completion and a later answer completes the same assigned work", async () => {
  const { h, run, submit } = await waiting();
  for (let i = 0; i < 4; i++) {
    await assert.rejects(submit("not yet asked"), error => error instanceof CollectionNeedsInput && error.feedback === "Ask for the missing outcome.");
    const current = (await h.store.read(run.instanceId, run.runId))!;
    assert.deepEqual(current.state, run.state);
    assert.equal(current.revision, run.revision);
  }
  const done = await submit("Complete discussed draft");
  assert.equal(done.runId, run.runId); assert.equal(done.state.status, "done");
  assert.deepEqual(done.state.decisions, {});
});

test("validator cannot substitute another grant, capabilities or altered contract", async () => {
  for (const change of ["risk", "capability", "digest", "grant"] as const) {
    const artifact = validatedArtifact(artifact => {
      const validator = artifact.workflows!.find(w => w.id === "monday-handoff")!.steps[1]!.collect!.validator!;
      if (change === "risk") validator.risk = "R2";
      if (change === "digest") validator.contractDigest = "0".repeat(64);
      if (change === "grant") validator.grantId = "company:missing";
      if (change === "capability") artifact.agents.find(a => a.id === "sprint")!.tools.find(t => t.contract.grantId === validator.grantId)!.contract.capabilities = ["communication.message.publish"];
    });
    const { h, run, submit } = await waiting(artifact);
    await assert.rejects(submit("Complete discussed draft"), /pinned pure Tool grant/);
    assert.deepEqual((await h.store.read(run.instanceId, run.runId))!.state, run.state);
  }
});

test("a validator crash never finishes or blocks the conversation", async () => {
  const artifact = validatedArtifact(artifact => {
    artifact.agents.find(a => a.id === "sprint")!.tools.find(t => t.contract.grantId === "company:check-draft")!.compiledSource =
      inspectAndCompileCompanyTool('import { defineCompanyTool } from "@companyos/tool-sdk"; export default defineCompanyTool({execute() {throw new Error("synthetic check failure");}});').compiledSource!;
  });
  const { h, run, submit } = await waiting(artifact);
  await assert.rejects(submit("Complete discussed draft"), /synthetic check failure/);
  assert.deepEqual((await h.store.read(run.instanceId, run.runId))!.state, run.state);
});
