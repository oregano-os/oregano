import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { diagnostic } from "./diagnostics.mjs";
import { globToRegExp } from "./glob.mjs";

export const REQUIRED_ARCHITECTURE_MECHANISMS = [
  "agent-resolver",
  "toolset-resolver",
  "model-recipe-resolver",
  "company-records",
  "identity-and-authorization",
  "timers-and-business-time",
  "approvals-effects-and-idempotency",
  "capability-contracts-and-connectors",
];

export const CHANGE_PLAN_V2_CUTOFF = "2026-08-31";
export const CHANGE_PLAN_V3_CUTOFF = "2026-09-05";
export const CURRENT_CHANGE_PLAN_VERSION = 3;

const PLACEMENTS = new Set(["core", "workspace", "instance"]);
const CHANGE_CLASSES = new Set(["content", "behavior", "security"]);

const architectureAssessmentTemplate = {
  responsibilities: {
    core: [],
    packages: [],
    workspace: [],
    instance: [],
  },
  existing_mechanisms: REQUIRED_ARCHITECTURE_MECHANISMS.map((mechanism) => ({
    mechanism,
    decision: "",
    reason: "",
  })),
  new_core_mechanisms: [],
  boundary_assertions: {
    company_values_in_core: false,
    secrets_in_git: false,
    public_fixtures: "not-applicable",
  },
  core_reusability: "",
};

/** Version 2 shape. Kept for historical plans and their tests; new plans use version 3. */
export const changePlanTemplateV2 = {
  version: 2,
  plan_id: "",
  status: "draft",
  author: "",
  created: "",
  title: "",
  objective: "",
  non_goals: [],
  placement: "workspace",
  change_class: "behavior",
  vision_principles_affected: [],
  files_expected: [],
  required_approvals: [],
  approvals: [],
  validation: [],
  tests: [],
  documentation_impact: {
    required: true,
    affected_documents: [],
    reason_if_none: "",
  },
  architecture_assessment: architectureAssessmentTemplate,
  rollback: "",
  open_decisions: [],
};

/**
 * Version 3 shape. The merged pull request is the approval and the
 * implementation record, so the plan carries no status and no approvals.
 * Only extended or new mechanisms are listed; every other governed mechanism
 * is reused by definition.
 */
export const changePlanTemplate = {
  version: 3,
  plan_id: "",
  created: "",
  title: "",
  objective: "",
  non_goals: [],
  placement: "workspace",
  change_class: "behavior",
  files_expected: [],
  tests: [],
  documentation_impact: {
    required: true,
    affected_documents: [],
    reason_if_none: "",
  },
  architecture: {
    placement: {
      core: "",
      packages: "",
      workspace: "",
      instance: "",
    },
    mechanisms_extended: [],
    new_core_mechanisms: [],
    boundary_assertions: {
      company_values_in_core: false,
      secrets_in_git: false,
      public_fixtures: "not-applicable",
    },
    core_reusability: "",
  },
  rollback: "",
};

export const CHANGE_PLAN_V3_FIELDS = new Set([
  "version",
  "plan_id",
  "created",
  "title",
  "objective",
  "non_goals",
  "placement",
  "change_class",
  "proposal",
  "files_expected",
  "tests",
  "documentation_impact",
  "architecture",
  "rollback",
  "open_decisions",
]);

export function writeChangePlan(path, placement = "workspace") {
  if (existsSync(path)) throw new Error(`Refusing to overwrite existing plan: ${path}`);
  const plan = structuredClone(changePlanTemplate);
  plan.created = new Date().toISOString().slice(0, 10);
  plan.placement = placement;
  plan.architecture.boundary_assertions.public_fixtures = placement === "core" ? "synthetic-only" : "not-applicable";
  writeFileSync(path, YAML.stringify(plan));
}

export function readChangePlan(path) {
  return YAML.parse(readFileSync(path, "utf8"));
}

/** A glob that would accept everything below a top-level directory declares nothing. */
export const isCatchAllGlob = (pattern) => typeof pattern === "string" && (/^\*\*?$/.test(pattern.trim()) || /^[^/*]+\/\*\*$/.test(pattern.trim()));

const nonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const nonEmptyStringArray = (value) => Array.isArray(value) && value.length > 0 && value.every(nonEmptyString);

/**
 * Resolve the repository root that a plan belongs to: the parent of the
 * `.oregano/changes` or `.companyos/changes` directory, or the plan's own
 * directory when the plan lives elsewhere (tests, drafts).
 */
export function planRepositoryRoot(path) {
  const directory = dirname(resolve(path));
  const marker = directory.match(/^(.*)[\\/]\.(oregano|companyos)[\\/]changes$/);
  return marker ? marker[1] : directory;
}

export function validateChangePlan(path, { allowAuthorApproval = false, repositoryFiles } = {}) {
  const diagnostics = [];
  if (!existsSync(path)) return [diagnostic("PLAN001", "error", "Change Plan does not exist.", { file: path })];
  let plan;
  try { plan = readChangePlan(path); }
  catch (error) { return [diagnostic("PLAN002", "error", error.message.split("\n")[0], { file: path })]; }
  const version = Number(plan?.version);
  if (![1, 2, 3].includes(version)) {
    return [diagnostic("PLAN012", "error", `Unsupported Change Plan version '${plan?.version}'.`, { file: path })];
  }
  if (version === 3) return validateChangePlanV3(plan, path, { repositoryFiles });

  const created = plan?.created ?? "";
  if (version === 1 && (!/^\d{4}-\d{2}-\d{2}$/.test(created) || created > CHANGE_PLAN_V2_CUTOFF)) {
    diagnostics.push(diagnostic("PLAN013", "error", `Change Plans created after ${CHANGE_PLAN_V2_CUTOFF} must use version 2 and include an architecture assessment.`, { file: path }));
  }
  if (version === 2 && (!/^\d{4}-\d{2}-\d{2}$/.test(created) || created > CHANGE_PLAN_V3_CUTOFF)) {
    diagnostics.push(diagnostic("PLAN013", "error", `Change Plans created after ${CHANGE_PLAN_V3_CUTOFF} must use version 3; the merged pull request is the approval record.`, { file: path }));
  }
  for (const field of ["plan_id", "status", "author", "created", "title", "objective", "placement", "change_class", "required_approvals", "approvals", "validation", "tests", "documentation_impact", "rollback", "open_decisions"]) {
    if (plan?.[field] === undefined || plan[field] === "") diagnostics.push(diagnostic("PLAN003", "error", `Required Change Plan field '${field}' is empty.`, { file: path }));
  }
  if (!PLACEMENTS.has(plan?.placement)) diagnostics.push(diagnostic("PLAN004", "error", `Invalid placement '${plan?.placement}'.`, { file: path }));
  if (!CHANGE_CLASSES.has(plan?.change_class)) diagnostics.push(diagnostic("PLAN005", "error", `Invalid change_class '${plan?.change_class}'.`, { file: path }));
  if (!new Set(["draft", "review", "approved", "implemented", "rejected"]).has(plan?.status)) diagnostics.push(diagnostic("PLAN009", "error", `Invalid status '${plan?.status}'.`, { file: path }));
  if (["behavior", "security"].includes(plan?.change_class) && (!Array.isArray(plan.required_approvals) || plan.required_approvals.length === 0)) diagnostics.push(diagnostic("PLAN006", "error", `${plan.change_class} changes require at least one explicit approval role.`, { file: path }));
  diagnostics.push(...validateDocumentationImpact(plan, path));
  if (["approved", "implemented"].includes(plan?.status)) {
    const approvals = Array.isArray(plan.approvals) ? plan.approvals : [];
    const approvedRoles = new Set(approvals.map((approval) => approval?.role));
    for (const role of plan.required_approvals ?? []) {
      if (!approvedRoles.has(role)) diagnostics.push(diagnostic("PLAN010", "error", `Status '${plan.status}' requires recorded approval for role '${role}'.`, { file: path }));
    }
    if (!allowAuthorApproval && plan.change_class === "security" && approvals.some((approval) => approval?.approver === plan.author)) diagnostics.push(diagnostic("PLAN011", "error", "A security-plan author cannot record themselves as its approving identity.", { file: path }));
  }
  if (version === 2) diagnostics.push(...validateArchitectureAssessment(plan, path));
  return diagnostics;
}

function validateDocumentationImpact(plan, path) {
  const diagnostics = [];
  const impact = plan?.documentation_impact;
  if (!impact || typeof impact !== "object") {
    diagnostics.push(diagnostic("PLAN003", "error", "Required Change Plan field 'documentation_impact' is empty.", { file: path }));
    return diagnostics;
  }
  if (impact.required === true && (!Array.isArray(impact.affected_documents) || impact.affected_documents.length === 0)) diagnostics.push(diagnostic("PLAN007", "error", "Documentation impact is required but no affected document IDs are listed.", { file: path }));
  if (impact.required === false && !nonEmptyString(impact.reason_if_none)) diagnostics.push(diagnostic("PLAN008", "error", "A no-documentation-impact claim requires reason_if_none.", { file: path }));
  return diagnostics;
}

function validateChangePlanV3(plan, path, { repositoryFiles } = {}) {
  const diagnostics = [];
  for (const field of Object.keys(plan ?? {})) {
    if (!CHANGE_PLAN_V3_FIELDS.has(field)) {
      const hint = ["status", "approvals", "required_approvals", "author"].includes(field)
        ? "Version 3 records no status or approvals: the merged pull request is the approval and implementation record."
        : ["validation", "vision_principles_affected", "architecture_assessment", "migration"].includes(field)
          ? "Version 3 dropped this field; put migration notes into rollback and use the 'architecture' block."
          : undefined;
      diagnostics.push(diagnostic("PLAN030", "error", `Unknown Change Plan version 3 field '${field}'.`, { file: path, ...(hint ? { hint } : {}) }));
    }
  }
  for (const field of ["plan_id", "title", "objective", "placement", "change_class", "files_expected", "tests", "documentation_impact", "rollback"]) {
    if (plan?.[field] === undefined || plan[field] === "" || (Array.isArray(plan[field]) && plan[field].length === 0 && field !== "tests")) {
      diagnostics.push(diagnostic("PLAN003", "error", `Required Change Plan field '${field}' is empty.`, { file: path }));
    }
  }
  if (plan?.created !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(plan.created))) diagnostics.push(diagnostic("PLAN003", "error", "Change Plan field 'created' must be an ISO date.", { file: path }));
  if (!PLACEMENTS.has(plan?.placement)) diagnostics.push(diagnostic("PLAN004", "error", `Invalid placement '${plan?.placement}'.`, { file: path }));
  if (!CHANGE_CLASSES.has(plan?.change_class)) diagnostics.push(diagnostic("PLAN005", "error", `Invalid change_class '${plan?.change_class}'.`, { file: path }));
  if (plan?.proposal !== undefined && plan.proposal !== true) diagnostics.push(diagnostic("PLAN034", "error", "'proposal' may only be true; omit it for a plan that ships with its implementation.", { file: path }));
  if (plan?.non_goals !== undefined && !Array.isArray(plan.non_goals)) diagnostics.push(diagnostic("PLAN003", "error", "Change Plan field 'non_goals' must be a list.", { file: path }));
  if (plan?.open_decisions !== undefined && !Array.isArray(plan.open_decisions)) diagnostics.push(diagnostic("PLAN003", "error", "Change Plan field 'open_decisions' must be a list.", { file: path }));

  for (const pattern of Array.isArray(plan?.files_expected) ? plan.files_expected : []) {
    if (!nonEmptyString(pattern)) diagnostics.push(diagnostic("PLAN032", "error", "files_expected entries must be non-empty paths or globs.", { file: path }));
    else if (isCatchAllGlob(pattern)) diagnostics.push(diagnostic("PLAN032", "error", `files_expected glob '${pattern}' accepts everything below a top-level directory and declares nothing.`, { file: path, hint: "Name the packages or files the change touches, for example packages/cli/src/change-plan.mjs or packages/runtime/workflow-engine/**." }));
  }

  const tests = Array.isArray(plan?.tests) ? plan.tests : null;
  if (tests === null) diagnostics.push(diagnostic("PLAN003", "error", "Change Plan field 'tests' must be a list of test file paths.", { file: path }));
  else if (tests.length === 0 && ["behavior", "security"].includes(plan?.change_class) && plan?.proposal !== true) {
    diagnostics.push(diagnostic("PLAN031", "error", `${plan.change_class} changes must list at least one test file.`, { file: path }));
  } else {
    const files = repositoryFiles ?? null;
    const root = planRepositoryRoot(path);
    for (const entry of tests) {
      if (!nonEmptyString(entry)) { diagnostics.push(diagnostic("PLAN031", "error", "tests entries must be non-empty test file paths or globs.", { file: path })); continue; }
      if (plan?.proposal === true) continue;
      const exists = files
        ? files.some((file) => globToRegExp(entry).test(file))
        : entry.includes("*")
          ? true
          : existsSync(join(root, entry));
      if (!exists) diagnostics.push(diagnostic("PLAN031", "error", `Listed test '${entry}' does not exist in the repository.`, { file: path, hint: "tests must name real test files; prose descriptions of intended tests are not accepted." }));
    }
  }

  diagnostics.push(...validateDocumentationImpact(plan, path));
  diagnostics.push(...validateArchitectureV3(plan, path));
  return diagnostics;
}

function validateArchitectureV3(plan, path) {
  const diagnostics = [];
  const architecture = plan?.architecture;
  const required = plan?.placement === "core" && ["behavior", "security"].includes(plan?.change_class);
  if (!architecture || typeof architecture !== "object" || Array.isArray(architecture)) {
    if (required) diagnostics.push(diagnostic("PLAN014", "error", "Core behavior and security plans require an 'architecture' block.", { file: path }));
    return diagnostics;
  }
  for (const key of Object.keys(architecture)) {
    if (!["placement", "mechanisms_extended", "new_core_mechanisms", "boundary_assertions", "core_reusability"].includes(key)) {
      diagnostics.push(diagnostic("PLAN030", "error", `Unknown architecture field '${key}'.`, { file: path }));
    }
  }
  for (const area of ["core", "packages", "workspace", "instance"]) {
    if (!nonEmptyString(architecture?.placement?.[area])) {
      diagnostics.push(diagnostic("PLAN015", "error", `architecture.placement.${area} must state the responsibility or an explicit no-change statement.`, { file: path }));
    }
  }
  const extended = Array.isArray(architecture.mechanisms_extended) ? architecture.mechanisms_extended : [];
  if (architecture.mechanisms_extended !== undefined && !Array.isArray(architecture.mechanisms_extended)) {
    diagnostics.push(diagnostic("PLAN017", "error", "architecture.mechanisms_extended must be a list.", { file: path }));
  }
  const seen = new Set();
  for (const entry of extended) {
    const mechanism = entry?.mechanism;
    if (!REQUIRED_ARCHITECTURE_MECHANISMS.includes(mechanism)) {
      diagnostics.push(diagnostic("PLAN018", "error", `Unknown mechanism '${mechanism}' in mechanisms_extended; the governed catalog is ${REQUIRED_ARCHITECTURE_MECHANISMS.join(", ")}.`, { file: path }));
      continue;
    }
    if (seen.has(mechanism)) diagnostics.push(diagnostic("PLAN016", "error", `Mechanism '${mechanism}' is listed more than once.`, { file: path }));
    seen.add(mechanism);
    if (!nonEmptyString(entry?.reason)) diagnostics.push(diagnostic("PLAN017", "error", `Extended mechanism '${mechanism}' requires a reason that names the bounded contract extension.`, { file: path }));
  }
  const fresh = architecture.new_core_mechanisms;
  if (fresh !== undefined && !Array.isArray(fresh)) diagnostics.push(diagnostic("PLAN019", "error", "architecture.new_core_mechanisms must be a list.", { file: path }));
  else if (Array.isArray(fresh)) {
    if (plan?.placement !== "core" && fresh.length > 0) diagnostics.push(diagnostic("PLAN020", "error", "A non-Core Change Plan cannot introduce new Core mechanisms.", { file: path }));
    if (fresh.some((entry) => !nonEmptyString(entry))) diagnostics.push(diagnostic("PLAN019", "error", "Every new Core mechanism must have a non-empty description.", { file: path }));
  }
  const assertions = architecture.boundary_assertions;
  if (assertions?.company_values_in_core !== false || assertions?.secrets_in_git !== false) {
    diagnostics.push(diagnostic("PLAN021", "error", "Boundary assertions must confirm that Core contains no company values and Git contains no secrets.", { file: path }));
  }
  if (!new Set(["synthetic-only", "not-applicable"]).has(assertions?.public_fixtures)) {
    diagnostics.push(diagnostic("PLAN022", "error", "boundary_assertions.public_fixtures must be 'synthetic-only' or 'not-applicable'.", { file: path }));
  } else if (plan?.placement === "core" && assertions.public_fixtures !== "synthetic-only") {
    diagnostics.push(diagnostic("PLAN023", "error", "Core Change Plans must confirm that public fixtures are synthetic-only.", { file: path }));
  }
  if (!nonEmptyString(architecture.core_reusability)) {
    diagnostics.push(diagnostic("PLAN024", "error", "architecture.core_reusability must explain why the Core work is reusable across companies, or why no Core mechanism changes.", { file: path }));
  }
  return diagnostics;
}

function validateArchitectureAssessment(plan, path) {
  const diagnostics = [];
  const assessment = plan?.architecture_assessment;
  if (!assessment || typeof assessment !== "object" || Array.isArray(assessment)) {
    return [diagnostic("PLAN014", "error", "Change Plan version 2 requires architecture_assessment.", { file: path })];
  }

  for (const area of ["core", "packages", "workspace", "instance"]) {
    const entries = assessment?.responsibilities?.[area];
    if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
      diagnostics.push(diagnostic("PLAN015", "error", `Architecture assessment requires at least one explicit '${area}' responsibility or no-change statement.`, { file: path }));
    }
  }

  const mechanisms = Array.isArray(assessment.existing_mechanisms) ? assessment.existing_mechanisms : [];
  for (const required of REQUIRED_ARCHITECTURE_MECHANISMS) {
    const matches = mechanisms.filter((entry) => entry?.mechanism === required);
    if (matches.length !== 1) {
      diagnostics.push(diagnostic("PLAN016", "error", `Architecture assessment must review '${required}' exactly once.`, { file: path }));
      continue;
    }
    const [entry] = matches;
    if (!new Set(["reuse", "extend", "not-applicable"]).has(entry?.decision) || typeof entry?.reason !== "string" || entry.reason.trim() === "") {
      diagnostics.push(diagnostic("PLAN017", "error", `Existing mechanism '${required}' requires a reuse, extend, or not-applicable decision with a reason.`, { file: path }));
    }
  }
  const unknownMechanisms = mechanisms
    .map((entry) => entry?.mechanism)
    .filter((mechanism) => !REQUIRED_ARCHITECTURE_MECHANISMS.includes(mechanism));
  if (unknownMechanisms.length > 0) {
    diagnostics.push(diagnostic("PLAN018", "error", `Unknown existing mechanism review(s): ${[...new Set(unknownMechanisms)].join(", ")}.`, { file: path }));
  }

  if (!Array.isArray(assessment.new_core_mechanisms)) {
    diagnostics.push(diagnostic("PLAN019", "error", "Architecture assessment new_core_mechanisms must be an array.", { file: path }));
  } else if (plan?.placement !== "core" && assessment.new_core_mechanisms.length > 0) {
    diagnostics.push(diagnostic("PLAN020", "error", "A non-Core Change Plan cannot introduce new Core mechanisms.", { file: path }));
  } else if (assessment.new_core_mechanisms.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    diagnostics.push(diagnostic("PLAN019", "error", "Every new Core mechanism must have a non-empty description.", { file: path }));
  }

  const assertions = assessment.boundary_assertions;
  if (assertions?.company_values_in_core !== false || assertions?.secrets_in_git !== false) {
    diagnostics.push(diagnostic("PLAN021", "error", "Boundary assertions must confirm that Core contains no company values and Git contains no secrets.", { file: path }));
  }
  if (!new Set(["synthetic-only", "not-applicable"]).has(assertions?.public_fixtures)) {
    diagnostics.push(diagnostic("PLAN022", "error", "boundary_assertions.public_fixtures must be 'synthetic-only' or 'not-applicable'.", { file: path }));
  } else if (plan?.placement === "core" && assertions.public_fixtures !== "synthetic-only") {
    diagnostics.push(diagnostic("PLAN023", "error", "Core Change Plans must confirm that public fixtures are synthetic-only.", { file: path }));
  }

  if (typeof assessment.core_reusability !== "string" || assessment.core_reusability.trim() === "") {
    diagnostics.push(diagnostic("PLAN024", "error", "Architecture assessment requires a Core reusability rationale or an explicit no-Core-change rationale.", { file: path }));
  }
  return diagnostics;
}
