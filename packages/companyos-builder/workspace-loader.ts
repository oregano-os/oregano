import { readWorkspaceFiles, workspaceFile, workspaceDocument, type WorkspaceFiles } from "./workspace-files.ts";
import type { JsonSchema, RiskLevel } from "../capabilities/contracts.ts";
import { assertValidJsonSchema } from "../capabilities/validation.ts";
import { sha256 } from "../runtime/canonical.ts";
import type { CompanyToolContract } from "../tool-sdk/contracts.ts";
import { inspectAndCompileCompanyTool } from "../tool-sdk/source-inspector.ts";
import { parseRoster, type RosterMember } from "../state-store/roster.ts";
import { requireExactSemanticVersion } from "../runtime/semantic-version.ts";
import type { CompiledCompanyTool } from "./types.ts";
import type { AgentHandoffRule } from "../runtime/agent-resolver.ts";

const globExpression = (pattern: string) => new RegExp(`^${pattern
  .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  .replace(/\*\*/g, "\u0000")
  .replace(/\*/g, "[^/]*")
  .replace(/\u0000/g, ".*")}$`);

const requireString = (value: unknown, label: string) => {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string.`);
  return value;
};

const requireSchema = (value: unknown, label: string): JsonSchema => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON Schema object.`);
  const schema = value as JsonSchema;
  assertValidJsonSchema(schema, label);
  return schema;
};

export interface LoadedAgent {
  id: string;
  instructions: string;
  grants: string[];
  scopeRead: string[];
  handoffs: AgentHandoffRule[];
  tools: CompiledCompanyTool[];
}

export interface LoadedWorkspace {
  company: string;
  version: string;
  roster: RosterMember[];
  agents: LoadedAgent[];
  allowedCapabilities: string[];
  allFiles: Record<string, string>;
  workspaceHash: string;
}

export function loadCompanyWorkspace(root: string, options: { includeBuilder?: boolean } = {}): LoadedWorkspace {
  const allFiles = readWorkspaceFiles(root);
  const parseDocument = (path: string) => {
    const document = workspaceDocument(allFiles, path);
    if (!document.data) throw new Error(`${path}: YAML frontmatter is required.`);
    return document;
  };
  const company = parseDocument("company.md");
  const allowedCapabilities = new Set<string>();
  for (const [path] of Object.entries(allFiles).filter(([path]) => /^connections\/.*\.md$/.test(path))) {
    const document = parseDocument(path);
    for (const capability of document.data.capabilities ?? []) allowedCapabilities.add(requireString(capability, `${path} capability`));
  }
  const agents: LoadedAgent[] = [];
  for (const [path] of Object.entries(allFiles).filter(([path]) => /^agents\/[^/]+\/instructions\.md$/.test(path))) {
    const id = path.split("/")[1];
    if (id === "builder" && !options.includeBuilder) continue;
    const document = parseDocument(path);
    const grants = Array.isArray(document.data.tools) ? document.data.tools.map((entry: unknown) => requireString(entry, `${path} grant`)) : [];
    const scopeRead = Array.isArray(document.data.scope?.read) ? document.data.scope.read.map((entry: unknown) => requireString(entry, `${path} scope.read`)) : [];
    const handoffs = parseAgentHandoffs(document.data.handoffs, id, path);
    const toolRoot = `agents/${id}/tools`;
    const tools: CompiledCompanyTool[] = [];
    if (Object.keys(allFiles).some((entry) => entry.startsWith(`agents/${id}/tools/`))) {
      for (const toolId of [...new Set(Object.keys(allFiles).filter((path) => path.startsWith(`${toolRoot}/`) && path.slice(toolRoot.length + 1).includes("/")).map((path) => path.slice(toolRoot.length + 1).split("/")[0]!))].sort()) {
        tools.push(loadCompanyTool(allFiles, id!, toolId));
      }
    }
    agents.push({
      id,
      instructions: document.body,
      grants,
      scopeRead,
      handoffs,
      tools: tools.sort((a, b) => a.contract.runtimeId.localeCompare(b.contract.runtimeId)),
    });
  }
  return {
    company: requireString(company.data.name, "company.name"),
    version: requireExactSemanticVersion(company.data.workspace_version, "company.workspace_version"),
    roster: parseRoster(allFiles["handbook/roster.md"] ?? ""),
    agents: agents.sort((a, b) => a.id.localeCompare(b.id)),
    allowedCapabilities: [...allowedCapabilities].sort(),
    allFiles,
    workspaceHash: sha256(allFiles),
  };
}

function parseAgentHandoffs(value: unknown, fromAgentId: string, path: string): AgentHandoffRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${path}: handoffs must be a list.`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${path}: handoffs[${index}] must be an object.`);
    }
    const rule = entry as Record<string, unknown>;
    const list = (field: string): string[] => {
      const candidate = rule[field];
      if (!Array.isArray(candidate)) throw new Error(`${path}: handoffs[${index}].${field} must be a list.`);
      return [...new Set(candidate.map((item) => requireString(item, `${path}: handoffs[${index}].${field}`)))].sort();
    };
    const expiry = rule.expiry;
    const hasFixedTtl = rule.ttl_seconds !== undefined;
    const hasExpiry = expiry !== undefined;
    if (hasFixedTtl === hasExpiry) {
      throw new Error(`${path}: handoffs[${index}] must declare exactly one of ttl_seconds or expiry.`);
    }
    let compiledExpiry: Pick<AgentHandoffRule, "ttlSeconds" | "localDayEndTimeZone">;
    if (hasFixedTtl) {
      if (!Number.isSafeInteger(rule.ttl_seconds)) {
        throw new Error(`${path}: handoffs[${index}].ttl_seconds must be an integer.`);
      }
      compiledExpiry = { ttlSeconds: rule.ttl_seconds as number };
    } else {
      if (!expiry || typeof expiry !== "object" || Array.isArray(expiry)) {
        throw new Error(`${path}: handoffs[${index}].expiry must be an object.`);
      }
      const declaration = expiry as Record<string, unknown>;
      if (declaration.mode !== "local-day-end") {
        throw new Error(`${path}: handoffs[${index}].expiry.mode must be 'local-day-end'.`);
      }
      const timeZone = requireString(declaration.timezone, `${path}: handoffs[${index}].expiry.timezone`);
      try {
        new Intl.DateTimeFormat("en", { timeZone }).format(new Date(0));
      } catch {
        throw new Error(`${path}: handoffs[${index}].expiry.timezone must be a valid IANA timezone.`);
      }
      compiledExpiry = { localDayEndTimeZone: timeZone };
    }
    return {
      id: requireString(rule.id, `${path}: handoffs[${index}].id`),
      fromAgentId,
      toAgentId: requireString(rule.target, `${path}: handoffs[${index}].target`),
      purpose: requireString(rule.purpose, `${path}: handoffs[${index}].purpose`),
      surfaces: list("surfaces"),
      eligibleRoles: list("eligible_roles"),
      eligibleGroups: list("eligible_groups"),
      ...compiledExpiry,
    };
  });
}

export function scopedMaterials(
  workspace: LoadedWorkspace,
  patterns: string[],
  options: { excludeKnowledgeDocuments?: boolean } = {},
): Record<string, string> {
  const expressions = patterns.map(globExpression);
  return Object.fromEntries(Object.entries(workspace.allFiles)
    .filter(([path]) => expressions.some((expression) => expression.test(path)))
    .filter(([path]) => !options.excludeKnowledgeDocuments || !path.startsWith("handbook/") || path === "handbook/roster.md")
    .sort(([a], [b]) => a.localeCompare(b)));
}

export function loadCompanyTool(allFiles: WorkspaceFiles, id: string, toolId: string): CompiledCompanyTool {
  const directory = `agents/${id}/tools/${toolId}`;
  const toolDocument = workspaceDocument(allFiles, `${directory}/TOOL.md`);
  if (!toolDocument.data) throw new Error(`${directory}/TOOL.md: YAML frontmatter is required`);
  const data = toolDocument.data;
  const risk = requireString(data.risk ?? "R3", `${toolId} risk`) as RiskLevel;
  if (!/^R[0-4]$/.test(risk)) throw new Error(`${toolId}: invalid risk '${risk}'.`);
  const capabilities = Array.isArray(data.capabilities) ? data.capabilities.map((entry: unknown) => requireString(entry, `${toolId} capability`)) : [];
  const contract: CompanyToolContract = {
    grantId: `company:${toolId}`,
    runtimeId: `company:${id}/${toolId}`,
    agentId: id,
    toolId,
    version: requireString(data.version, `${toolId} version`),
    description: requireString(data.description, `${toolId} description`),
    risk,
    dataClass: requireString(data.data_class, `${toolId} data_class`),
    idempotency: data.idempotency === "input-hash" ? "input-hash" : (() => { throw new Error(`${toolId}: idempotency must be 'input-hash'.`); })(),
    capabilities,
    inputSchema: requireSchema(data.input_schema, `${toolId} input_schema`),
    outputSchema: requireSchema(data.output_schema, `${toolId} output_schema`),
    evidence: Array.isArray(data.evidence) ? data.evidence.map((entry: unknown) => requireString(entry, `${toolId} evidence`)) : [],
    failure: requireString(data.failure, `${toolId} failure`),
  };
  const executePath = `${directory}/execute.ts`;
  const source = workspaceFile(allFiles, executePath);
  const inspection = inspectAndCompileCompanyTool(source, executePath);
  if (inspection.diagnostics.length > 0 || !inspection.compiledSource) throw new Error(inspection.diagnostics.join("\n"));
  return { contract, compiledSource: inspection.compiledSource, sourceDigest: sha256(source) };
}
