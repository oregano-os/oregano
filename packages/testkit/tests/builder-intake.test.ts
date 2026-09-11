import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256 } from "../../runtime/canonical.ts";
import { assertGroundedBuilderBrief, groundBuilderBrief, parseBuilderBrief, type BuilderBrief } from "../../runtime/builder/brief.ts";
import { builderCodingPrompt, builderJobInputForConfirmedProposal } from "../../runtime/builder/service.ts";
import { InMemoryBuilderJobStore } from "../adapter/in-memory-builder-jobs.ts";

const materials = {
  "workflows/report.md": "Read tickets, produce a report, ask the process owner before posting.",
  "agents/reporter/instructions.md": "Only summarize tickets visible to the requester.",
  ".companyos/governance.yaml": "review_mode: steward",
  "handbook/roster.md": "The process owner reviews reports.",
};
const brief: BuilderBrief = {
  version: 1, objective: "Add a three-line report summary", targetPaths: ["workflows/report.md"], newPaths: [],
  currentBehavior: "The report starts with tickets.", proposedBehavior: "A three-line summary precedes the tickets.",
  acceptanceCriteria: ["Three summary lines before the original tickets", "Existing approval still occurs"], constraints: ["Preserve visibility rules"],
  contextRefs: ["workflows/report.md", "agents/reporter/instructions.md"],
  decisions: {
    workflow: { disposition: "change", detail: "Prepend the summary before ticket details" },
    approvals: { disposition: "preserve", detail: "Keep the process owner's approval" },
    access: { disposition: "preserve", detail: "Only tickets already visible to the requester" },
  },
  test: { strategy: "simulate", scenarios: ["Run a synthetic sprint with two tickets"], targetBindings: [] },
  deploymentIntent: "after-acceptance", openQuestions: [],
};
const evidence = () => ({ input: brief, materials, sourcePaths: [...Object.keys(materials), "workflows/private.md"], artifactHash: "a".repeat(64), workspaceCommit: "b".repeat(40), reads: Object.entries(materials).map(([path, text]) => ({ path, digest: sha256(text) })) });

test("Builder admits an exact resolved process brief and binds it to source evidence", () => {
  const grounded = groundBuilderBrief(evidence());
  assertGroundedBuilderBrief(grounded, "b".repeat(40));
  assert.deepEqual(grounded.context.map((entry) => entry.path), ["agents/reporter/instructions.md", "workflows/report.md"]);
  assert.throws(() => assertGroundedBuilderBrief(grounded, "c".repeat(40)), /stale/);
  assert.throws(() => assertGroundedBuilderBrief({ ...grounded, brief: { ...brief, proposedBehavior: "Publish without approval" } }, "b".repeat(40)), /digest/);
});

test("Builder does not admit unread, stale, unavailable or invented existing process context", () => {
  assert.throws(() => groundBuilderBrief({ ...evidence(), reads: [] }), /Read the current/);
  assert.throws(() => groundBuilderBrief({ ...evidence(), materials: { ...materials, "workflows/report.md": "changed" } }), /Read the current/);
  assert.throws(() => groundBuilderBrief({ ...evidence(), input: { ...brief, targetPaths: ["workflows/private.md"] } }), /outside the compiled read scope/);
  assert.throws(() => groundBuilderBrief({ ...evidence(), input: { ...brief, newPaths: brief.targetPaths } }), /already exists/);
  assert.throws(() => groundBuilderBrief({ ...evidence(), input: { ...brief, targetPaths: ["workflows/private.md"], newPaths: ["workflows/private.md"] } }), /already exists/);
  assert.doesNotThrow(() => groundBuilderBrief({ ...evidence(), input: { ...brief, targetPaths: ["workflows/new.md"], newPaths: ["workflows/new.md"] } }));
});

test("unresolved process, approval, access or test decisions block coding admission", () => {
  for (const area of ["workflow", "approvals", "access"] as const) {
    assert.throws(() => groundBuilderBrief({ ...evidence(), input: { ...brief, decisions: { ...brief.decisions, [area]: { disposition: "unresolved", detail: `Who decides ${area}?` } } } }), /Clarification required/);
  }
  assert.throws(() => groundBuilderBrief({ ...evidence(), input: { ...brief, openQuestions: ["Which of the two weekly reports?"] } }), /Clarification required/);
  for (const strategy of ["test-resources", "live-trial"]) {
    assert.throws(() => groundBuilderBrief({ ...evidence(), input: { ...brief, test: { ...brief.test, strategy } } }), /exact authorized/);
  }
});

test("changing rights requires current governance and roster evidence", () => {
  const changed = { ...brief, decisions: { ...brief.decisions, approvals: { disposition: "change", detail: "Delegate report approval to the team" } } };
  assert.throws(() => groundBuilderBrief({ ...evidence(), input: changed, reads: evidence().reads.filter((entry) => !entry.path.startsWith(".companyos")) }), /governance/);
  const grounded = groundBuilderBrief({ ...evidence(), input: changed });
  assert.equal(grounded.context.length, 4);
});

test("brief parser rejects extra authority fields, unsafe paths and empty success criteria", () => {
  assert.throws(() => parseBuilderBrief({ ...brief, approved_by: "administrator" }), /exactly/);
  for (const path of ["../secret", "/etc/passwd", ".env.local", "agents/../secret", "a\\b"]) {
    assert.throws(() => parseBuilderBrief({ ...brief, targetPaths: [path] }), /safe Workspace-relative/);
  }
  assert.throws(() => parseBuilderBrief({ ...brief, acceptanceCriteria: [] }), /1 to 40/);
});

test("both coding profiles receive the same immutable agreed brief, without release authority", async () => {
  for (const profile of ["claude-code", "codex"] as const) {
    const grounded = groundBuilderBrief(evidence());
    const input = builderJobInputForConfirmedProposal({
      enabled: true, execution: { adapter: "testkit-memory", profile: "isolated-v1" },
      codingAgent: { protocol: "acp-v1", profile },
      repository: { repositoryId: "acme/workspace", sourceBinding: "workspace", proposalPublisherBinding: "workspace" },
    }, {
      requestId: profile, instanceId: "acme", requesterPrincipal: "slack:T1:U1", sourceConversationKey: "slack:C1:thread",
      objective: brief.objective, repositoryId: "acme/workspace", baseCommit: grounded.workspaceCommit, brief: grounded,
    });
    const store = new InMemoryBuilderJobStore();
    const job = await store.create(input);
    assert.deepEqual(job.brief, grounded);
    const prompt = builderCodingPrompt(job);
    assert.match(prompt, /three-line summary/);
    assert.match(prompt, /Do not commit, push, merge, publish, or deploy/);
    assert.match(prompt, /newPaths already exists/);
    await assert.rejects(store.create({ ...input, brief: { ...grounded, digest: "0".repeat(64) } }), /digest/);
  }
});
