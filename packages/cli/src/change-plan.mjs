import { existsSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { diagnostic } from "./diagnostics.mjs";

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

export const changePlanTemplate = {
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

export function writeChangePlan(path, placement = "workspace") {
  if (existsSync(path)) throw new Error(`Refusing to overwrite existing plan: ${path}`);
  const plan = structuredClone(changePlanTemplate);
  plan.created = new Date().toISOString().slice(0, 10);
  plan.placement = placement;
  plan.architecture_assessment.boundary_assertions.public_fixtures = placement === "core"
    ? "synthetic-only"
    : "not-applicable";
  writeFileSync(path, YAML.stringify(plan));
}

export function readChangePlan(path) {
  return YAML.parse(readFileSync(path, "utf8"));
}

export function validateChangePlan(path, { allowAuthorApproval = false } = {}) {
  const diagnostics = [];
  if (!existsSync(path)) return [diagnostic("PLAN001", "error", "Change Plan does not exist.", { file: path })];
  let plan;
  try { plan = readChangePlan(path); }
  catch (error) { return [diagnostic("PLAN002", "error", error.message.split("\n")[0], { file: path })]; }
  const version = Number(plan?.version);
  if (![1, 2].includes(version)) {
    diagnostics.push(diagnostic("PLAN012", "error", `Unsupported Change Plan version '${plan?.version}'.`, { file: path }));
  } else if (version === 1 && (!/^\d{4}-\d{2}-\d{2}$/.test(plan?.created ?? "") || plan.created > CHANGE_PLAN_V2_CUTOFF)) {
    diagnostics.push(diagnostic("PLAN013", "error", `Change Plans created after ${CHANGE_PLAN_V2_CUTOFF} must use version 2 and include an architecture assessment.`, { file: path }));
  }
  for (const field of ["plan_id", "status", "author", "created", "title", "objective", "placement", "change_class", "required_approvals", "approvals", "validation", "tests", "documentation_impact", "rollback", "open_decisions"]) {
    if (plan?.[field] === undefined || plan[field] === "") diagnostics.push(diagnostic("PLAN003", "error", `Required Change Plan field '${field}' is empty.`, { file: path }));
  }
  if (!new Set(["core", "workspace", "instance"]).has(plan?.placement)) diagnostics.push(diagnostic("PLAN004", "error", `Invalid placement '${plan?.placement}'.`, { file: path }));
  if (!new Set(["content", "behavior", "security"]).has(plan?.change_class)) diagnostics.push(diagnostic("PLAN005", "error", `Invalid change_class '${plan?.change_class}'.`, { file: path }));
  if (!new Set(["draft", "review", "approved", "implemented", "rejected"]).has(plan?.status)) diagnostics.push(diagnostic("PLAN009", "error", `Invalid status '${plan?.status}'.`, { file: path }));
  if (["behavior", "security"].includes(plan?.change_class) && (!Array.isArray(plan.required_approvals) || plan.required_approvals.length === 0)) diagnostics.push(diagnostic("PLAN006", "error", `${plan.change_class} changes require at least one explicit approval role.`, { file: path }));
  const impact = plan?.documentation_impact;
  if (impact?.required === true && (!Array.isArray(impact.affected_documents) || impact.affected_documents.length === 0)) diagnostics.push(diagnostic("PLAN007", "error", "Documentation impact is required but no affected document IDs are listed.", { file: path }));
  if (impact?.required === false && !impact.reason_if_none) diagnostics.push(diagnostic("PLAN008", "error", "A no-documentation-impact claim requires reason_if_none.", { file: path }));
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
