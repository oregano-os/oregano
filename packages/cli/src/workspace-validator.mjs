import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import YAML from "yaml";
import { inspectWorkspaceCompatibility } from "./compatibility.mjs";
import { diagnostic } from "./diagnostics.mjs";
import { readDocument, relativePath, walkFiles } from "./files.mjs";
import { inspectRepositoryProtectionContract } from "./repository-protection.mjs";
import { inspectAndCompileCompanyTool } from "../../tool-sdk/source-inspector.ts";
import { scanCredentialIndicators } from "../../security/credential-scanner.ts";
import { isExactSemanticVersion } from "../../runtime/semantic-version.ts";
import { inspectKnowledgeWorkspace } from "../../knowledge/okf.ts";
import { loadKnowledgeSourceRequirement } from "../../knowledge/source-config.ts";

const REQUIRED_PATHS = [
  "company.md",
  "handbook/index.md",
  "handbook/roster.md",
  "policies/risk-levels.md",
  "policies/data-retention.md",
  "agents/builder/instructions.md",
  ".companyos/compatibility.yaml",
  ".companyos/repository-protection.yaml",
  "workflows",
  "connections",
  "schedules",
];

const requiredCompanyFields = ["name", "workspace_version", "language", "timezone", "companyos_spec", "workspace_mode"];
const CURRENT_SPEC = "0.7-draft";
const WORKSPACE_MODES = new Set(["authoring-only", "operating"]);
const EXECUTION_MODES = new Set(["supervised", "unattended"]);
const riskPattern = /\bR[0-4]\b/;

const allMarkdown = (root) => walkFiles(root, {
  include: (path) => path.endsWith(".md"),
  skip: [".git", "node_modules", ".companyos-cache"],
});

const parsedMarkdown = (root) => allMarkdown(root).map((path) => readDocument(root, path));

const lineOf = (raw, needle) => {
  const index = raw.indexOf(needle);
  return index < 0 ? undefined : raw.slice(0, index).split("\n").length;
};

export function validateWorkspace(root) {
  const diagnostics = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { diagnostics: [diagnostic("WS001", "error", `Company Workspace does not exist: ${root}`)], summary: null };
  }

  for (const required of REQUIRED_PATHS) {
    if (!existsSync(join(root, required))) diagnostics.push(diagnostic("WS002", "error", `Required Company Workspace path '${required}' is missing.`, { file: required }));
  }

  const documents = parsedMarkdown(root);
  const byPath = new Map(documents.map((document) => [document.relative, document]));
  for (const document of documents) {
    if (document.error) diagnostics.push(diagnostic("WS003", "error", document.error.message, { file: document.relative }));
    const requiresFrontmatter = document.relative !== "AGENTS.md" &&
      !document.relative.startsWith("brain/inbox/") &&
      !document.relative.startsWith("brain/archive/");
    if (requiresFrontmatter && !document.data) diagnostics.push(diagnostic("WS004", "error", "Workspace Markdown requires valid YAML frontmatter.", { file: document.relative }));
  }

  const company = byPath.get("company.md");
  if (company?.data) {
    for (const field of requiredCompanyFields) {
      if (company.data[field] === undefined) diagnostics.push(diagnostic("WS005", "error", `company.md is missing required field '${field}'.`, { file: "company.md" }));
    }
    if (String(company.data.companyos_spec ?? "") !== CURRENT_SPEC) diagnostics.push(diagnostic("WS006", "warning", `Workspace declares CompanyOS Spec '${company.data.companyos_spec ?? "none"}'; this Workbench currently targets ${CURRENT_SPEC}.`, { file: "company.md" }));
    if (company.data.workspace_version !== undefined && !isExactSemanticVersion(company.data.workspace_version)) {
      diagnostics.push(diagnostic("WS039", "error", "company.md workspace_version must be one exact semantic version without leading zeroes.", { file: "company.md" }));
    }
    if (!WORKSPACE_MODES.has(company.data.workspace_mode)) diagnostics.push(diagnostic("WS029", "error", "company.md workspace_mode must be 'authoring-only' or 'operating'.", { file: "company.md" }));
    if (company.data.conformance !== undefined || company.data.target !== undefined) diagnostics.push(diagnostic("WS030", "error", "Legacy global conformance/target profiles are not part of the current Workspace contract; use workspace_mode and per-workflow execution_mode.", { file: "company.md" }));
  }

  const roster = byPath.get("handbook/roster.md");
  const members = Array.isArray(roster?.data?.members) ? roster.data.members : [];
  if (members.length === 0) diagnostics.push(diagnostic("WS007", "error", "Roster must declare a non-empty 'members' list.", { file: "handbook/roster.md" }));
  const activeRoles = new Set(members.filter((member) => member?.status !== "inactive" && member?.type !== "agent").map((member) => member.role));
  for (const member of members) {
    if (!member.role || !member.name) diagnostics.push(diagnostic("WS008", "error", "Every roster member needs role and name.", { file: "handbook/roster.md" }));
    if (!Array.isArray(member.may_approve)) diagnostics.push(diagnostic("WS009", "error", `Roster member '${member.name ?? "unknown"}' needs may_approve as a list.`, { file: "handbook/roster.md" }));
    for (const level of member.may_approve ?? []) {
      if (!/^R[0-4]$/.test(level)) diagnostics.push(diagnostic("WS010", "error", `Unknown approval level '${level}' for '${member.name ?? "unknown"}'.`, { file: "handbook/roster.md" }));
    }
    if (member.groups !== undefined && (!Array.isArray(member.groups) || member.groups.some((group) => typeof group !== "string" || !group.trim()))) {
      diagnostics.push(diagnostic("WS041", "error", `Roster member '${member.name ?? "unknown"}' groups must be stable non-empty string ids.`, { file: "handbook/roster.md" }));
    }
  }

  const workflowDocs = documents.filter((document) => document.relative.startsWith("workflows/") && document.relative.endsWith(".md"));
  const agentRoles = new Set(documents
    .filter((document) => /^agents\/[^/]+\/instructions\.md$/.test(document.relative))
    .map((document) => document.relative.split("/")[1]));
  for (const workflow of workflowDocs) {
    for (const field of ["owner", "trigger", "input"]) {
      if (!workflow.data?.[field]) diagnostics.push(diagnostic("WS012", "error", `Workflow is missing '${field}' frontmatter.`, { file: workflow.relative }));
    }
    const workflowOwner = String(workflow.data?.owner ?? "").replace(/^agents\//, "");
    if (workflowOwner && !agentRoles.has(workflowOwner)) diagnostics.push(diagnostic("WS013", "error", `Workflow owner '${workflow.data.owner}' does not resolve to an agent instructions file.`, { file: workflow.relative }));
    if (!EXECUTION_MODES.has(workflow.data?.execution_mode)) diagnostics.push(diagnostic("WS031", "error", "Workflow execution_mode must be 'supervised' or 'unattended'.", { file: workflow.relative }));
    if (workflow.data?.execution_mode === "unattended") diagnostics.push(diagnostic("WS035", "info", "Unattended execution is declared; deployment readiness still requires resolved Tools, compiled enforcement, Instance controls, and runtime evidence.", { file: workflow.relative }));
    for (const match of workflow.body.matchAll(/\[human:([^,\]\s]+)(?:,\s*(R[0-4]))?\]/g)) {
      const role = match[1];
      if (!activeRoles.has(role)) diagnostics.push(diagnostic("WS014", "error", `Human step references unknown or inactive role '${role}'.`, { file: workflow.relative, line: workflow.bodyOffset + lineOf(workflow.body, match[0]) }));
      if (match[2]) diagnostics.push(diagnostic("WS015", "warning", `Human step '${match[0]}' should not carry a risk level; the human action is not an agent effect.`, { file: workflow.relative }));
    }
    for (const line of workflow.body.split("\n").filter((item) => /^\s*\d+[a-z]?\./.test(item))) {
      if (!riskPattern.test(line) && !line.includes("[human:")) diagnostics.push(diagnostic("WS016", "warning", "Workflow step has no explicit risk level; effective risk defaults to R3.", { file: workflow.relative }));
    }
  }

  const agents = documents.filter((document) => /^agents\/[^/]+\/instructions\.md$/.test(document.relative));
  if (!agentRoles.has("builder")) diagnostics.push(diagnostic("WS017", "error", "Workspace needs the Builder Agent entrypoint.", { file: "agents/builder/instructions.md" }));
  for (const agent of agents) {
    if (!agent.data?.description) diagnostics.push(diagnostic("WS018", "error", "Agent instructions need a description.", { file: agent.relative }));
    const agentName = agent.relative.split("/")[1];
    if (agentName !== "builder" && (!agent.data?.scope?.read || !Array.isArray(agent.data.scope.read))) diagnostics.push(diagnostic("WS019", "error", "Operating agent instructions need scope.read as a list.", { file: agent.relative }));
    if (agentName !== "builder" && (!Array.isArray(agent.data?.tools) || agent.data.tools.length === 0)) diagnostics.push(diagnostic("WS028", "warning", "Operating agent has no explicit Tool grants and cannot demonstrate resolved ToolSet readiness.", { file: agent.relative }));
    for (const grant of agent.data?.tools ?? []) {
      if (!/^(oregano|company):[a-z0-9][a-z0-9/-]*$/.test(grant)) diagnostics.push(diagnostic("WS020", "error", `Invalid tool grant '${grant}'.`, { file: agent.relative }));
      if (grant.startsWith("company:")) {
        const tool = grant.slice("company:".length);
        const toolDoc = join(root, "agents", agentName, "tools", tool, "TOOL.md");
        if (!existsSync(toolDoc)) diagnostics.push(diagnostic("WS021", "error", `Company grant '${grant}' does not resolve to agents/${agentName}/tools/${tool}/TOOL.md.`, { file: agent.relative }));
      }
      if (grant.startsWith("oregano:")) diagnostics.push(diagnostic("WS022", "info", `Core capability '${grant}' has valid syntax; availability will be resolved against the exact Core catalog at deploy time.`, { file: agent.relative }));
    }
  }

  const operatingAgents = agents.filter((agent) => agent.relative !== "agents/builder/instructions.md");
  const workspaceMode = company?.data?.workspace_mode;
  if (workspaceMode === "authoring-only" && (operatingAgents.length > 0 || workflowDocs.length > 0)) {
    diagnostics.push(diagnostic("WS032", "error", "An authoring-only Workspace cannot contain operating agents or executable workflows; change workspace_mode through an approved operating-model change.", { file: "company.md" }));
  }
  if (workspaceMode === "operating" && operatingAgents.length === 0) diagnostics.push(diagnostic("WS033", "error", "An operating Workspace needs at least one operating agent.", { file: "company.md" }));
  if (workspaceMode === "operating" && workflowDocs.length === 0) diagnostics.push(diagnostic("WS034", "error", "An operating Workspace needs at least one workflow.", { file: "company.md" }));

  const toolDocs = documents.filter((document) => /\/tools\/[^/]+\/TOOL\.md$/.test(document.relative));
  for (const tool of toolDocs) {
    const risk = tool.data?.risk;
    if (!risk) diagnostics.push(diagnostic("WS023", "warning", "Tool has no risk declaration; effective risk is R3.", { file: tool.relative }));
    else if (!/^R[0-4]$/.test(risk)) diagnostics.push(diagnostic("WS024", "error", `Invalid tool risk '${risk}'.`, { file: tool.relative }));
    for (const field of ["version", "description", "data_class", "idempotency", "input_schema", "output_schema", "evidence", "failure"]) {
      if (tool.data?.[field] === undefined) diagnostics.push(diagnostic("WS036", "error", `Company Tool contract is missing '${field}'.`, { file: tool.relative }));
    }
    if (tool.data?.idempotency !== undefined && tool.data.idempotency !== "input-hash") {
      diagnostics.push(diagnostic("WS037", "error", "Company Tool idempotency must be 'input-hash' in the current Tool SDK contract.", { file: tool.relative }));
    }
    if (tool.data?.capabilities !== undefined && !Array.isArray(tool.data.capabilities)) {
      diagnostics.push(diagnostic("WS038", "error", "Company Tool capabilities must be a list.", { file: tool.relative }));
    }
    const executePath = join(root, tool.relative.replace(/TOOL\.md$/, "execute.ts"));
    if (!existsSync(executePath)) diagnostics.push(diagnostic("WS025", "error", "Company tool needs execute.ts.", { file: relativePath(root, executePath) }));
    else {
      const source = readFileSync(executePath, "utf8");
      const inspection = inspectAndCompileCompanyTool(source, relativePath(root, executePath));
      for (const message of inspection.diagnostics) diagnostics.push(diagnostic("WS026", "error", message, { file: relativePath(root, executePath) }));
    }
  }

  const handbookIndex = byPath.get("handbook/index.md")?.body ?? "";
  for (const document of documents.filter((item) => item.relative.startsWith("handbook/") && item.relative !== "handbook/index.md")) {
    if (!handbookIndex.includes(basename(document.relative))) diagnostics.push(diagnostic("WS027", "warning", `Handbook file is missing from handbook/index.md.`, { file: document.relative }));
  }

  const knowledge = inspectKnowledgeWorkspace({ workspaceRoot: root });
  for (const entry of knowledge.diagnostics) {
    diagnostics.push(diagnostic(entry.code, entry.severity, entry.message, { file: entry.path }));
  }

  for (const source of documents.filter((item) => item.relative.startsWith("connections/") && item.data?.type === "knowledge-source")) {
    try { loadKnowledgeSourceRequirement(join(root, source.relative)); }
    catch (error) { diagnostics.push(diagnostic("WS040", "error", error.message, { file: source.relative })); }
  }

  for (const path of walkFiles(root, { skip: [".git", "node_modules"] })) {
    const relative = relativePath(root, path);
    if (/^\.env(?:\.|$)/.test(basename(path))) diagnostics.push(diagnostic("SEC001", "error", "Environment files must never be committed to a Company Workspace.", { file: relative }));
    if (!/\.(md|yaml|yml|json|ts|js|txt|gitkeep)$/.test(path)) continue;
    const raw = readFileSync(path, "utf8");
    for (const finding of scanCredentialIndicators(raw)) {
      diagnostics.push(diagnostic("SEC002", "error", `Possible ${finding.label} detected.`, { file: relative }));
    }
  }

  const governancePath = join(root, ".companyos", "governance.yaml");
  let reviewMode = null;
  if (!existsSync(governancePath)) {
    diagnostics.push(diagnostic("GOV001", "error", "Workspace has no .companyos/governance.yaml; protected change classes cannot be enforced.", { file: ".companyos/governance.yaml" }));
  } else {
    try {
      const governance = YAML.parse(readFileSync(governancePath, "utf8"));
      reviewMode = governance?.review_mode ?? null;
      if (!new Set(["steward", "independent-review"]).has(governance?.review_mode)) diagnostics.push(diagnostic("GOV010", "error", "Governance review_mode must be 'steward' or 'independent-review'.", { file: ".companyos/governance.yaml" }));
      if (governance?.core_defaults?.may_only_tighten !== true) diagnostics.push(diagnostic("GOV002", "error", "Governance must declare core_defaults.may_only_tighten: true.", { file: ".companyos/governance.yaml" }));
      if (!Array.isArray(governance?.roles?.workspace_stewards) || governance.roles.workspace_stewards.length === 0) diagnostics.push(diagnostic("GOV003", "error", "Governance must assign at least one Workspace Steward role.", { file: ".companyos/governance.yaml" }));
      for (const name of ["content", "behavior", "security"]) {
        if (!governance?.change_classes?.[name]) diagnostics.push(diagnostic("GOV004", "error", `Governance is missing '${name}' change class.`, { file: ".companyos/governance.yaml" }));
      }
      const securityPaths = governance?.change_classes?.security?.paths ?? [];
      if (!securityPaths.includes(".companyos/**")) diagnostics.push(diagnostic("GOV005", "error", "The security change class must protect .companyos/**, including its own policy.", { file: ".companyos/governance.yaml" }));
      if (governance?.review_mode === "steward" && (governance?.change_classes?.security?.two_person_review !== undefined || governance?.change_classes?.security?.review_model !== undefined)) diagnostics.push(diagnostic("GOV006", "error", "Steward review mode must not declare a second-person review requirement.", { file: ".companyos/governance.yaml" }));
      if (governance?.review_mode === "independent-review" && (governance?.change_classes?.security?.two_person_review !== true || governance?.change_classes?.security?.review_model !== "author-plus-one-independent-reviewer")) diagnostics.push(diagnostic("GOV009", "error", "Independent-review mode must require author-plus-one-independent-reviewer for security changes.", { file: ".companyos/governance.yaml" }));
      for (const protectedPath of [".github/**", "AGENTS.md"]) {
        if (!securityPaths.includes(protectedPath)) diagnostics.push(diagnostic("GOV008", "error", `The security change class must protect '${protectedPath}'.`, { file: ".companyos/governance.yaml" }));
      }
    } catch (error) {
      diagnostics.push(diagnostic("GOV007", "error", error.message.split("\n")[0], { file: ".companyos/governance.yaml" }));
    }
  }

  diagnostics.push(...inspectWorkspaceCompatibility(root).diagnostics);
  const protection = inspectRepositoryProtectionContract(root);
  diagnostics.push(...protection.diagnostics);

  return {
    diagnostics,
    summary: {
      workspace: company?.data?.name ?? basename(root),
      workspace_version: company?.data?.workspace_version ?? null,
      specification: company?.data?.companyos_spec ?? null,
      workspace_mode: company?.data?.workspace_mode ?? null,
      review_mode: reviewMode,
      documents: documents.length,
      workflows: workflowDocs.length,
      supervised_workflows: workflowDocs.filter((workflow) => workflow.data?.execution_mode === "supervised").length,
      unattended_workflows: workflowDocs.filter((workflow) => workflow.data?.execution_mode === "unattended").length,
      agents: agents.length,
      company_tools: toolDocs.length,
      knowledge_documents: knowledge.bundle?.documentCount ?? 0,
      knowledge_fragments: knowledge.bundle?.fragmentCount ?? 0,
    },
  };
}
