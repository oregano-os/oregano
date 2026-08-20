import { existsSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { diagnostic } from "./diagnostics.mjs";

export const changePlanTemplate = {
  version: 1,
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
  rollback: "",
  open_decisions: [],
};

export function writeChangePlan(path, placement = "workspace") {
  if (existsSync(path)) throw new Error(`Refusing to overwrite existing plan: ${path}`);
  const plan = structuredClone(changePlanTemplate);
  plan.created = new Date().toISOString().slice(0, 10);
  plan.placement = placement;
  writeFileSync(path, YAML.stringify(plan));
}

export function readChangePlan(path) {
  return YAML.parse(readFileSync(path, "utf8"));
}

export function validateChangePlan(path) {
  const diagnostics = [];
  if (!existsSync(path)) return [diagnostic("PLAN001", "error", "Change Plan does not exist.", { file: path })];
  let plan;
  try { plan = readChangePlan(path); }
  catch (error) { return [diagnostic("PLAN002", "error", error.message.split("\n")[0], { file: path })]; }
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
    if (plan.change_class === "security" && approvals.some((approval) => approval?.approver === plan.author)) diagnostics.push(diagnostic("PLAN011", "error", "A security-plan author cannot record themselves as its approving identity.", { file: path }));
  }
  return diagnostics;
}
