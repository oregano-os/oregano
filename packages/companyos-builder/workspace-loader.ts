import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import YAML from "yaml";
import type { JsonSchema, RiskLevel } from "../capabilities/contracts.ts";
import { assertValidJsonSchema } from "../capabilities/validation.ts";
import { sha256 } from "../runtime/canonical.ts";
import type { CompanyToolContract } from "../tool-sdk/contracts.ts";
import { inspectAndCompileCompanyTool } from "../tool-sdk/source-inspector.ts";
import { parseRoster, type RosterMember } from "../state-store/roster.ts";
import { requireExactSemanticVersion } from "../runtime/semantic-version.ts";
import type { CompiledCompanyTool } from "./types.ts";

const parseDocument = (path: string) => {
  const raw = readFileSync(path, "utf8");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${path}: YAML frontmatter is required.`);
  return { raw, data: YAML.parse(match[1]) ?? {}, body: raw.slice(match[0].length) };
};

const walk = (root: string): string[] => {
  const output: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", "node_modules", ".companyos-cache"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) output.push(path);
    }
  };
  visit(root);
  return output;
};

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
  if (!statSync(root).isDirectory()) throw new Error(`Workspace does not exist: ${root}`);
  const allFiles = Object.fromEntries(walk(root).map((path) => [relative(root, path).replaceAll("\\", "/"), readFileSync(path, "utf8")]));
  const company = parseDocument(join(root, "company.md"));
  const allowedCapabilities = new Set<string>();
  for (const [path] of Object.entries(allFiles).filter(([path]) => /^connections\/.*\.md$/.test(path))) {
    const document = parseDocument(join(root, path));
    for (const capability of document.data.capabilities ?? []) allowedCapabilities.add(requireString(capability, `${path} capability`));
  }
  const agents: LoadedAgent[] = [];
  for (const [path] of Object.entries(allFiles).filter(([path]) => /^agents\/[^/]+\/instructions\.md$/.test(path))) {
    const id = path.split("/")[1];
    if (id === "builder" && !options.includeBuilder) continue;
    const document = parseDocument(join(root, path));
    const grants = Array.isArray(document.data.tools) ? document.data.tools.map((entry: unknown) => requireString(entry, `${path} grant`)) : [];
    const scopeRead = Array.isArray(document.data.scope?.read) ? document.data.scope.read.map((entry: unknown) => requireString(entry, `${path} scope.read`)) : [];
    const toolRoot = join(root, "agents", id, "tools");
    const tools: CompiledCompanyTool[] = [];
    if (Object.keys(allFiles).some((entry) => entry.startsWith(`agents/${id}/tools/`))) {
      for (const toolId of readdirSync(toolRoot).sort()) {
        const directory = join(toolRoot, toolId);
        if (!statSync(directory).isDirectory()) continue;
        const toolDocument = parseDocument(join(directory, "TOOL.md"));
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
        const executePath = join(directory, "execute.ts");
        const source = readFileSync(executePath, "utf8");
        const inspection = inspectAndCompileCompanyTool(source, relative(root, executePath));
        if (inspection.diagnostics.length > 0 || !inspection.compiledSource) throw new Error(inspection.diagnostics.join("\n"));
        tools.push({ contract, compiledSource: inspection.compiledSource, sourceDigest: sha256(source) });
      }
    }
    agents.push({ id, instructions: document.body, grants, scopeRead, tools: tools.sort((a, b) => a.contract.runtimeId.localeCompare(b.contract.runtimeId)) });
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

export function scopedMaterials(workspace: LoadedWorkspace, patterns: string[]): Record<string, string> {
  const expressions = patterns.map(globExpression);
  return Object.fromEntries(Object.entries(workspace.allFiles)
    .filter(([path]) => expressions.some((expression) => expression.test(path)))
    .sort(([a], [b]) => a.localeCompare(b)));
}
