import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { buildCompanyOSArtifact } from "../../companyos-builder/build.ts";
import { compileWorkflows } from "../../companyos-builder/workflow-compiler.ts";
import { validateWorkflowFiles } from "../../companyos-builder/workflow-authoring.ts";
import { readWorkspaceFiles, workspaceDocument } from "../../companyos-builder/workspace-files.ts";
import { loadCompanyWorkspace, loadCompanyTool } from "../../companyos-builder/workspace-loader.ts";
import { CORE_CAPABILITY_CATALOG } from "../../capabilities/catalog.ts";
import type { InstanceBuildConfiguration } from "../../companyos-builder/types.ts";
import { sha256 } from "../../runtime/canonical.ts";

const fixture = resolve(import.meta.dirname, "../fixtures/lindenhof-studio");
const closePath = "workflows/friday-close.compact.md";
const instance: InstanceBuildConfiguration = {
  version: 1, instanceId: "lindenhof-test", environment: "test", agentBindings: [], defaultAgentId: "sprint",
  bindings: ["directory.members.query", "records.query", "work-item.read", "work-item.batch-update", "communication.message.publish"].map((id) => ({
    capability: id, contractVersion: CORE_CAPABILITY_CATALOG.find((contract) => contract.id === id)!.version,
    connector: "test/compile-only", connectorVersion: "1.0.0",
  })),
};
const build = (root = fixture, configuration = instance, builtAt = "2026-09-05T12:00:00.000Z") => buildCompanyOSArtifact({
  workspaceRoot: root, instance: configuration, coreVersion: "0.5.14", coreCommit: "1".repeat(40), workspaceCommit: "2".repeat(40), workbenchVersion: "0.1.0-experimental.15", builtAt,
});
const editWorkflow = (files: Record<string, string>, change: (declaration: any) => void) => {
  const { data, body } = workspaceDocument(files, closePath); change(data);
  files[closePath] = `---\n${YAML.stringify(data)}---\n${body}`;
};

// Cached Artifact is used only as the resolved Tool input to independent compiler tests.
const artifact = build();
const provenance = artifact.workflows![0]!.provenance;
const compile = (files: Record<string, string>, agents = artifact.agents) => compileWorkflows({ files, agents, provenance });

const unrelatedSchedule = YAML.stringify({
  version: 1, timezone: "Europe/Berlin", notes: "Independent Records polling metadata",
  triggers: [{ id: "records-poll", source: "message-source", every_minutes: 5 }],
});

test("prose Workspaces do not acquire executable calendar requirements", () => {
  const files = { ...readWorkspaceFiles(resolve(import.meta.dirname, "../fixtures/acme-casas")), "schedules/records-poll.yaml": unrelatedSchedule };
  assert.deepEqual(validateWorkflowFiles(files), []);
  assert.deepEqual(compile(files), []);
});

test("unrelated scheduling metadata does not change compiled workflow manifests", () => {
  const files = { ...readWorkspaceFiles(fixture) };
  const baseline = compile(files);
  files["schedules/records-poll.yaml"] = unrelatedSchedule;
  files["schedules/unclassified.yaml"] = "notes: Reserved for another scheduling contract\n";
  assert.deepEqual(validateWorkflowFiles(files), []);
  assert.deepEqual(compile(files), baseline);
});

test("explicitly referenced calendars must satisfy the complete calendar schema", () => {
  const files: Record<string, string> = { ...readWorkspaceFiles(fixture), "schedules/selected.yaml": unrelatedSchedule };
  editWorkflow(files, (data) => { data.calendar = "schedules/selected.yaml"; });
  assert.throws(() => compile(files), /selected.yaml.*business_days/);
  files["schedules/selected.yaml"] = "triggers: null\n";
  assert.throws(() => compile(files), /selected.yaml.*triggers/);
  delete files["schedules/selected.yaml"];
  assert.throws(() => compile(files), /calendar must name a declared schedule file/);
});

test("a wait selects its own calendar and rejects missing or malformed declarations", () => {
  const files = { ...readWorkspaceFiles(fixture) };
  const calendar = YAML.parse(files["schedules/sprint-rhythm.yaml"]!);
  calendar.triggers = [{ ...calendar.triggers[0], id: "separate-wake" }];
  files["schedules/other-calendar.yaml"] = YAML.stringify(calendar);
  editWorkflow(files, (data) => { data.steps.find((step: any) => step["await-chase"]).for = "schedule:separate-wake"; });
  const close = compile(files).find((workflow) => workflow.id === "friday-close")!;
  assert.deepEqual(close.steps.find((step) => step.id === "await-chase")!.wait, { triggerId: "separate-wake", schedulePath: "schedules/other-calendar.yaml" });
  assert.deepEqual(close.schedules.map((entry) => entry.path), ["schedules/other-calendar.yaml", "schedules/sprint-rhythm.yaml"]);
  delete calendar.business_days;
  files["schedules/other-calendar.yaml"] = YAML.stringify(calendar);
  assert.throws(() => compile(files), /other-calendar.yaml.*business_days/);
  delete files["schedules/other-calendar.yaml"];
  assert.throws(() => compile(files), /wait names an undeclared trigger/);
});

test("competing calendar triggers and unreadable discovery candidates fail closed", () => {
  const files = { ...readWorkspaceFiles(fixture) };
  files["schedules/duplicate.yaml"] = files["schedules/sprint-rhythm.yaml"]!;
  assert.throws(() => compile(files), /ambiguous across schedules/);
  files["schedules/duplicate.yaml"] = "triggers: [\n";
  assert.throws(() => compile(files), /Flow sequence/);
});

test("complete fixture builds four workflows; full close manifest matches reviewed expectation", () => {
  assert.equal(artifact.workflows!.length, 4);
  assert.equal(Object.hasOwn(artifact, "sprints"), false);
  const close = artifact.workflows!.find((workflow) => workflow.id === "friday-close")!;
  assert.deepEqual(JSON.parse(JSON.stringify(close)), JSON.parse(readFileSync(join(fixture, "compiler-expectations/friday-close.json"), "utf8")));
  assert.equal(close.steps.length, 20);
  assert.deepEqual(close.instance.key, ["sprint_id"]);
  const root = close.steps.find((step) => step.id === "open-close-thread")!;
  assert.equal(root.message!.thread, undefined);
  assert.deepEqual(root.requiredOutputPaths, [["thread_reference"]]);
  const write = close.steps.find((step) => step.id === "apply-rollover")!;
  assert.deepEqual(write.requiresDecisions, [{ stepId: "approve-rollover", payloadPath: ["updates"] }]);
  assert.deepEqual(write.bindingConstraints, [{ inputPath: ["resource_binding"], value: "sprint-board" }]);
  assert.equal(write.maxRisk, "R3");
  assert.equal(close.steps.find((step) => step.id === "approve-rollover")!.decision!.calendarPath, "schedules/sprint-rhythm.yaml");
  assert.ok(close.reservedEffects.includes("oregano:communications/publish"));
});

test("build timestamps do not change identities; JSONB key ordering preserves manifests", () => {
  const first = build(), second = build(fixture, instance, "2026-09-06T12:00:00.000Z");
  assert.equal(first.artifactHash, second.artifactHash);
  const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  for (const original of first.workflows!) {
    const { manifestHash, ...manifest } = reorder(original);
    assert.equal(sha256(manifest), manifestHash);
  }
});

test("source, Tool, template, calendar and config changes alter the pinned evidence", () => {
  const files = { ...readWorkspaceFiles(fixture) };
  const original = compile(files).find((workflow) => workflow.id === "friday-close")!;
  for (const path of [closePath, original.templates[0]!.path, original.config!.path, original.schedules[0]!.path]) {
    const changed = { ...files, [path]: `${files[path]}\n# Reviewed change\n` };
    const next = compile(changed).find((workflow) => workflow.id === "friday-close")!;
    assert.notEqual(next.manifestHash, original.manifestHash, path);
  }
  const agents = structuredClone(artifact.agents);
  const tool = agents.find((agent) => agent.id === "sprint")!.tools.find((tool) => tool.contract.grantId === "company:participant-view")!;
  const declarationPath = "agents/sprint/tools/participant-view/TOOL.md";
  files[declarationPath] = files[declarationPath]!.replace("version: 1.0.0", "version: 1.0.1");
  Object.assign(tool, loadCompanyTool(files, "sprint", "participant-view"));
  const resolved = agents.find((agent) => agent.id === "sprint")!.toolSet.tools.find((tool) => tool.grantId === "company:participant-view")!;
  resolved.version = tool.contract.version; resolved.contractDigest = sha256(tool.contract);
  assert.notEqual(compile(files, agents).find((workflow) => workflow.id === "friday-close")!.manifestHash, original.manifestHash);
});

test("captured bytes survive file edits; manifests and caller Instance objects cannot alias", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-compiler-"));
  try {
    cpSync(fixture, root, { recursive: true });
    const workspace = loadCompanyWorkspace(root);
    const config = structuredClone(instance);
    const first = build(root, config);
    writeFileSync(join(root, closePath), "broken workflow");
    assert.deepEqual(compile(workspace.allFiles), first.workflows);
    config.bindings[0]!.connector = "test/changed";
    assert.notEqual(first.bindings.find((binding) => binding.capability === config.bindings[0]!.capability)!.connector, "test/changed");
    assert.throws(() => { first.workflows![0]!.steps[0]!.allowedTools.push("forged"); }, TypeError);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compiler revalidates captured bytes and refuses stale resolved contracts", () => {
  const files = { ...readWorkspaceFiles(fixture) };
  editWorkflow(files, (data) => { data.steps[0].injected_option = "forged"; });
  assert.throws(() => compile(files), /unknown option/);
  const agents = structuredClone(artifact.agents);
  agents.find((agent) => agent.id === "sprint")!.tools[0]!.contract.version = "9.0.0";
  assert.throws(() => compile({ ...readWorkspaceFiles(fixture) }, agents), /resolved Artifact contract/);
});

test("foreach compilation requires the item key and fields before any item dispatch", () => {
  const workflow = artifact.workflows!.find((workflow) => workflow.id === "board-hygiene")!;
  const sender = workflow.steps.find((step) => step.id === "nudge-owners")!;
  assert.deepEqual(sender.forEach, { over: "$steps.triage.nudges", key: "participant_id", maxItems: 10000 });
  const paths = workflow.steps.find((step) => step.id === "triage")!.requiredOutputPaths;
  assert.ok(paths.some((path) => path.join(".") === "nudges.[].participant_id"));
  assert.ok(paths.some((path) => path.join(".") === "nudges.[].items_text"));
});

test("operator workflows require an explicit calendar for timed decisions and immutable key fields", () => {
  const files = { ...readWorkspaceFiles(fixture) };
  editWorkflow(files, (data) => { data.trigger = "operator"; });
  assert.throws(() => compile(files), /require calendar/);
  editWorkflow(files, (data) => { data.calendar = "schedules/sprint-rhythm.yaml"; });
  assert.equal(compile(files).find((workflow) => workflow.id === "friday-close")!.trigger.kind, "operator");
  editWorkflow(files, (data) => { data.instance.key = ["missing"]; });
  assert.throws(() => compile(files), /key.*declared/);
});

test("a changed Company Tool implementation cannot be compiled with a stale Agent snapshot", () => {
  const files = { ...readWorkspaceFiles(fixture) };
  const path = "agents/sprint/tools/participant-view/execute.ts";
  files[path] += "\n// Reviewed implementation revision.\n";
  assert.throws(() => compile(files), /differs from captured Workspace bytes/);
});

test("a forged lower resolved risk cannot weaken the workflow manifest", () => {
  const agents = structuredClone(artifact.agents);
  agents.find((agent) => agent.id === "sprint")!.toolSet.tools.find((tool) => tool.grantId === "oregano:work-items/batch-update")!.risk = "R0";
  assert.throws(() => compile({ ...readWorkspaceFiles(fixture) }, agents), /resolved risk differs/);
});

test("full Artifact pins Company Tool source and exact Instance bindings", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-artifact-"));
  try {
    cpSync(fixture, root, { recursive: true });
    const first = build(root);
    const path = join(root, "agents/sprint/tools/participant-view/execute.ts");
    writeFileSync(path, readFileSync(path, "utf8") + "\n// Reviewed source revision.\n");
    assert.notEqual(build(root).artifactHash, first.artifactHash);
    const configuration = structuredClone(instance);
    configuration.bindings[0]!.connector = "test/other-binding";
    assert.notEqual(build(root, configuration).artifactHash, build(root).artifactHash);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("one approval cannot be reused across R3 foreach item effects", () => {
  const files = { ...readWorkspaceFiles(fixture) };
  editWorkflow(files, (data) => {
    const effect = data.steps.find((step: any) => step["apply-rollover"]);
    effect.for_each = { over: "$steps.prepare-rollover.updates", key: "work_item_id" };
  });
  assert.throws(() => compile(files), /R3|R4|approval|batch/);
});

test("readable decision reviews are explicit, validated and preserved in the compiled Artifact", () => {
  const files = { ...readWorkspaceFiles(fixture) };
  editWorkflow(files, (data) => {
    const decision = data.steps.find((entry: any) => Object.values(entry)[0] === "human:sprint-owner");
    assert.ok(decision);
    decision.review_format = "message";
    decision.message = { template: "friday-close-sop/close-status.md", vars: {} };
    decision.labels = { approve: "Approve", reject: "Keep" };
  });
  // Resolve a known valid, existing template from the workflow instead of inventing a new contract.
  editWorkflow(files, (data) => {
    const publication = data.steps.find((entry: any) => Object.values(entry)[0] === "oregano:communications/publish");
    const decision = data.steps.find((entry: any) => entry.review_format);
    decision.message = { template: publication.template, vars: publication.vars };
  });
  assert.deepEqual(validateWorkflowFiles(files), []);
  const compiled = compile(files).find((workflow) => workflow.steps.some((step) => step.decision?.presentation?.reviewFormat));
  assert.equal(compiled?.steps.find((step) => step.decision?.presentation?.reviewFormat)?.decision?.presentation?.reviewFormat, "message");
  editWorkflow(files, (data) => { delete data.steps.find((entry: any) => entry.review_format).message; });
  assert.match(validateWorkflowFiles(files).join("\n"), /message-only review/);
});
