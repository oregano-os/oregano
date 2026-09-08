import { sha256 } from "../canonical.ts";
import { parseBuilderTestExecution, type BuilderTestExecution } from "./functional-tests.ts";

export interface BuilderDecision {
  readonly disposition: "preserve" | "change" | "not-applicable" | "unresolved";
  readonly detail: string;
}

/** Company intent only. Identity, access and source evidence are added by Core. */
export interface BuilderBrief {
  readonly version: 1;
  readonly objective: string;
  readonly targetPaths: readonly string[];
  /** Explicitly new files; every other target must have been read. */
  readonly newPaths: readonly string[];
  readonly currentBehavior: string;
  readonly proposedBehavior: string;
  readonly acceptanceCriteria: readonly string[];
  readonly constraints: readonly string[];
  readonly contextRefs: readonly string[];
  readonly decisions: {
    readonly workflow: BuilderDecision;
    readonly approvals: BuilderDecision;
    readonly access: BuilderDecision;
  };
  readonly test: {
    readonly strategy: "auto" | "simulate" | "test-resources" | "live-trial";
    readonly scenarios: readonly string[];
    readonly targetBindings: readonly string[];
    readonly execution?: BuilderTestExecution;
  };
  readonly deploymentIntent: "prepare-only" | "after-acceptance";
  readonly openQuestions: readonly string[];
}

export interface BuilderContextRead {
  readonly path: string;
  readonly digest: string;
}

export interface GroundedBuilderBrief {
  readonly brief: BuilderBrief;
  readonly artifactHash: string;
  readonly workspaceCommit: string;
  readonly context: readonly BuilderContextRead[];
  readonly digest: string;
}

const text = { type: "string", minLength: 1, maxLength: 4000 } as const;
const list = { type: "array", items: text, maxItems: 40 } as const;
const decision = {
  type: "object", additionalProperties: false, required: ["disposition", "detail"],
  properties: { disposition: { type: "string", enum: ["preserve", "change", "not-applicable", "unresolved"] }, detail: text },
} as const;

/** Shared by chat, Workbench consumers, and both coding profiles. */
export const BUILDER_BRIEF_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["version", "objective", "targetPaths", "newPaths", "currentBehavior", "proposedBehavior", "acceptanceCriteria", "constraints", "contextRefs", "decisions", "test", "deploymentIntent", "openQuestions"],
  properties: {
    version: { const: 1 }, objective: text,
    targetPaths: { ...list, minItems: 1 }, newPaths: list, currentBehavior: text, proposedBehavior: text,
    acceptanceCriteria: { ...list, minItems: 1 }, constraints: list,
    contextRefs: { ...list, minItems: 1 },
    decisions: { type: "object", additionalProperties: false, required: ["workflow", "approvals", "access"], properties: { workflow: decision, approvals: decision, access: decision } },
    test: { type: "object", additionalProperties: false, required: ["strategy", "scenarios", "targetBindings"], properties: {
      strategy: { type: "string", enum: ["auto", "simulate", "test-resources", "live-trial"] },
      scenarios: { ...list, minItems: 1 }, targetBindings: list,
      execution: { oneOf: [
        { type: "object", additionalProperties: false, required: ["kind", "agentId", "prompt"], properties: { kind: { const: "agent" }, agentId: text, prompt: text } },
        { type: "object", additionalProperties: false, required: ["kind", "workflowId", "fields"], properties: { kind: { const: "workflow" }, workflowId: text, fields: { type: "object", maxProperties: 30, additionalProperties: text } } },
      ] },
    } },
    deploymentIntent: { type: "string", enum: ["prepare-only", "after-acceptance"] },
    openQuestions: list,
  },
} as const;

function object(value: unknown, keys: readonly string[], label: string, optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => !optional.includes(key) && !(key in record))) {
    throw new Error(`${label} must contain exactly: ${keys.join(", ")}.`);
  }
  return record;
}
function boundedText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4000) throw new Error(`${label} must be non-empty bounded text.`);
  return value.trim();
}
function strings(value: unknown, label: string, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 40) throw new Error(`${label} must contain ${minimum} to 40 entries.`);
  return [...new Set(value.map((entry) => boundedText(entry, label)))];
}
export function assertBuilderContextPath(path: string): void {
  if (!path || path.length > 512 || path.startsWith("/") || path.includes("\\") || /[\u0000-\u001f]/.test(path)
    || path.split("/").some((part) => !part || part === "." || part === "..")
    || /(^|\/)(\.git|node_modules|\.env[^/]*)(\/|$)/.test(path)) {
    throw new Error("Builder context path must be a safe Workspace-relative file path.");
  }
}
export function parseBuilderBrief(input: unknown): BuilderBrief {
  const raw = object(input, Object.keys(BUILDER_BRIEF_SCHEMA.properties), "Builder brief");
  if (raw.version !== 1) throw new Error("Builder brief version must be 1.");
  const rawDecisions = object(raw.decisions, ["workflow", "approvals", "access"], "Builder decisions");
  const parseDecision = (key: string): BuilderDecision => {
    const entry = object(rawDecisions[key], ["disposition", "detail"], `Decision '${key}'`);
    if (!["preserve", "change", "not-applicable", "unresolved"].includes(String(entry.disposition))) throw new Error(`Decision '${key}' is invalid.`);
    return { disposition: entry.disposition as BuilderDecision["disposition"], detail: boundedText(entry.detail, key) };
  };
  const rawTest = object(raw.test, ["strategy", "scenarios", "targetBindings", "execution"], "Builder test", ["execution"]);
  if (!["auto", "simulate", "test-resources", "live-trial"].includes(String(rawTest.strategy))) throw new Error("Builder test strategy is invalid.");
  if (!["prepare-only", "after-acceptance"].includes(String(raw.deploymentIntent))) throw new Error("Builder deployment intent is invalid.");
  const targetPaths = strings(raw.targetPaths, "targetPaths", 1);
  const newPaths = strings(raw.newPaths, "newPaths");
  if (newPaths.some((path) => !targetPaths.includes(path))) throw new Error("Every new path must be a target path.");
  const contextRefs = strings(raw.contextRefs, "contextRefs", 1);
  [...targetPaths, ...contextRefs].forEach(assertBuilderContextPath);
  const result: BuilderBrief = {
    version: 1, objective: boundedText(raw.objective, "objective"), targetPaths, newPaths,
    currentBehavior: boundedText(raw.currentBehavior, "currentBehavior"),
    proposedBehavior: boundedText(raw.proposedBehavior, "proposedBehavior"),
    acceptanceCriteria: strings(raw.acceptanceCriteria, "acceptanceCriteria", 1),
    constraints: strings(raw.constraints, "constraints"), contextRefs,
    decisions: { workflow: parseDecision("workflow"), approvals: parseDecision("approvals"), access: parseDecision("access") },
    test: { strategy: rawTest.strategy as BuilderBrief["test"]["strategy"], scenarios: strings(rawTest.scenarios, "test.scenarios", 1), targetBindings: strings(rawTest.targetBindings, "test.targetBindings"),
      ...(rawTest.execution === undefined ? {} : { execution: parseBuilderTestExecution(rawTest.execution) }) },
    deploymentIntent: raw.deploymentIntent as BuilderBrief["deploymentIntent"],
    openQuestions: strings(raw.openQuestions, "openQuestions"),
  };
  if (JSON.stringify(result).length > 30000) throw new Error("Builder brief exceeds its total size limit.");
  return result;
}

export function builderBriefQuestions(brief: BuilderBrief): string[] {
  const questions = [...brief.openQuestions];
  for (const [area, decision] of Object.entries(brief.decisions)) {
    if (decision.disposition === "unresolved") questions.push(`${area}: ${decision.detail}`);
  }
  if (["test-resources", "live-trial"].includes(brief.test.strategy) && brief.test.targetBindings.length === 0) {
    questions.push("Select the exact authorized test or live-trial resource bindings.");
  }
  return [...new Set(questions)];
}

export function groundBuilderBrief(args: {
  input: unknown;
  artifactHash: string;
  workspaceCommit: string;
  materials: Readonly<Record<string, string>>;
  sourcePaths?: readonly string[];
  reads: readonly BuilderContextRead[];
}): GroundedBuilderBrief {
  const brief = parseBuilderBrief(args.input);
  const questions = builderBriefQuestions(brief);
  if (questions.length) throw new Error(`Clarification required before coding: ${questions.join("; ")}`);
  if (!/^[a-f0-9]{64}$/.test(args.artifactHash) || !/^[a-f0-9]{40}$/.test(args.workspaceCommit)) throw new Error("Builder source provenance is invalid.");
  const read = new Map(args.reads.map((entry) => [entry.path, entry.digest]));
  const required = new Set(brief.contextRefs);
  for (const path of brief.targetPaths) {
    if (brief.newPaths.includes(path)) {
      if (!args.sourcePaths) throw new Error("Rebuild the Builder context inventory before proposing new files.");
      if (args.sourcePaths.includes(path) || Object.hasOwn(args.materials, path)) throw new Error(`'${path}' already exists; read it and describe a modification.`);
    } else required.add(path);
  }
  if (brief.decisions.approvals.disposition === "change" || brief.decisions.access.disposition === "change") {
    required.add(".companyos/governance.yaml");
    required.add("handbook/roster.md");
  }
  const context = [...required].sort().map((path) => {
    if (!Object.hasOwn(args.materials, path)) throw new Error(`Builder context '${path}' is outside the compiled read scope. Configure the required read scope before preparing this change.`);
    const digest = sha256(args.materials[path]);
    if (read.get(path) !== digest) throw new Error(`Read the current '${path}' before preparing the build brief.`);
    return { path, digest };
  });
  const content = { brief, artifactHash: args.artifactHash, workspaceCommit: args.workspaceCommit, context };
  return { ...content, digest: sha256(content) };
}

export function assertGroundedBuilderBrief(value: GroundedBuilderBrief, workspaceCommit: string): void {
  parseBuilderBrief(value.brief);
  if (builderBriefQuestions(value.brief).length) throw new Error("Builder job contains unresolved questions.");
  const { digest, ...content } = value;
  if (digest !== sha256(content) || value.workspaceCommit !== workspaceCommit) throw new Error("Builder brief digest or source revision is stale.");
  if (!/^[a-f0-9]{64}$/.test(value.artifactHash) || !value.context.length) throw new Error("Builder brief is missing source evidence.");
  for (const entry of value.context) {
    assertBuilderContextPath(entry.path);
    if (!/^[a-f0-9]{64}$/.test(entry.digest)) throw new Error("Builder context digest is invalid.");
  }
  const required = [...value.brief.contextRefs, ...value.brief.targetPaths.filter((path) => !value.brief.newPaths.includes(path))];
  if (value.brief.decisions.approvals.disposition === "change" || value.brief.decisions.access.disposition === "change") required.push(".companyos/governance.yaml", "handbook/roster.md");
  for (const path of required) {
    if (!value.context.some((entry) => entry.path === path)) throw new Error("Builder brief context evidence is incomplete.");
  }
}

export const BUILDER_INTAKE_INSTRUCTIONS = [
  "You are the company-facing Builder Agent. You clarify the change with the human; the separate coding agent implements the resolved brief later.",
  "A request to explain or evaluate a process is not a development request. Answer it without starting a coding job. Start only when the human has requested development within the resolved scope.",
  "Before proposing code work, discover and read the actual scoped Workspace definitions with builder_list_context and builder_read_context.",
  "Resolve a named workflow or Agent to its exact file. If several match, ask which one. Read its referenced Agents, policies, Tools and process definitions where available before describing the current behavior.",
  "List every existing target as a modification and read it. Declare newPaths only for files that must be created; the coding agent must stop if a declared new file already exists at the exact source revision.",
  "Explain the existing process and the precise intended before/after change. Ask concise questions about missing workflow steps, order, triggers, participants, exception handling, approval authority and access scope. Never invent a material decision to fill the form.",
  "Use existing documented choices when they answer the question; do not repeatedly ask for unchanged settings. Missing context is a blocker, not a reason to guess.",
  "Complete the versioned brief, including acceptance criteria, constraints, explicit workflow/approval/access decisions and a suitable test. Preserve an unchanged rule explicitly. Keep unresolved decisions in openQuestions or disposition=unresolved.",
  "Call builder_propose_change only after those questions are resolved. The tool verifies context-read evidence and refuses unresolved briefs before it can start a coding job. The human's unchanged-scope development request is sufficient; do not add a redundant start confirmation.",
  "Preview is optional. Tests can use simulation or exact existing company resource bindings; a live trial requires its actual scope and authorization. Selecting a test preference does not execute it or grant access.",
  "Before selecting test-resources, call builder_instance_capabilities. Use only listed test resources and a supported concrete test.execution. Resolve missing Instance capabilities before coding; installing another provider app is not a default. A read-only Agent test uses kind=agent, agentId and prompt. The first workflow profile uses kind=workflow, workflowId and fields for an operator-opened graph without messages, timers or intermediate decisions.",
  "When the human asks for a correction after a test, call builder_read_test_result. Retain the complete original requested change and apply the authenticated feedback in a fresh brief against the current source. Re-read affected definitions. A previous test or acceptance never approves the rebuilt candidate.",
  "The build brief never approves the eventual result or grants merge/deploy rights. Explain the final change for human acceptance; only the trusted release path can report verified live completion.",
].join("\n\n");
