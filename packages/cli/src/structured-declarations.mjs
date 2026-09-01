import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import YAML from "yaml";
import { validateJsonSchemaValue } from "../../capabilities/validation.ts";
import { diagnostic } from "./diagnostics.mjs";
import { relativePath, walkFiles } from "./files.mjs";

const schema = (name) => JSON.parse(readFileSync(new URL(`../../schema/${name}`, import.meta.url), "utf8"));

const RECORD_SOURCE_SCHEMA = schema("company-record-source-v1.schema.json");
const RECORD_PROJECTION_SCHEMA = schema("company-record-projection-v1.schema.json");
const SPRINT_CONFIGURATION_SCHEMA = schema("sprint-configuration-v1.schema.json");

const declarationFiles = (root, prefix) => walkFiles(root, {
  include: (path) => {
    const relative = relativePath(root, path);
    return relative.startsWith(prefix) && /\.ya?ml$/.test(relative);
  },
  skip: [".git", "node_modules", ".companyos-cache"],
});

const readDeclaration = (root, path, contract, diagnostics) => {
  const relative = relativePath(root, path);
  let value;
  try {
    value = YAML.parse(readFileSync(path, "utf8"));
  } catch (error) {
    diagnostics.push(diagnostic("WS042", "error", `Structured declaration is not valid YAML: ${error.message.split("\n")[0]}`, { file: relative }));
    return null;
  }
  for (const message of validateJsonSchemaValue(contract, value)) {
    diagnostics.push(diagnostic("WS043", "error", `Structured declaration violates its contract: ${message}.`, { file: relative }));
  }
  return value && typeof value === "object" ? { path: relative, value } : null;
};

const duplicates = (items) => {
  const counts = new Map();
  for (const item of items) counts.set(item.value.id, (counts.get(item.value.id) ?? 0) + 1);
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id));
};

const safeWorkspaceTarget = (target) => {
  if (typeof target !== "string" || !target.endsWith(".md") || isAbsolute(target)) return false;
  const normalized = normalize(target).replaceAll("\\", "/");
  return !normalized.startsWith("../") && normalized !== ".." && !normalized.startsWith(".companyos/");
};

/** Validate optional Company Records and Sprint declarations without making them baseline requirements. */
export function inspectStructuredDeclarations(root) {
  const diagnostics = [];
  const sources = declarationFiles(root, "records/sources/")
    .map((path) => readDeclaration(root, path, RECORD_SOURCE_SCHEMA, diagnostics)).filter(Boolean);
  const projections = declarationFiles(root, "records/projections/")
    .map((path) => readDeclaration(root, path, RECORD_PROJECTION_SCHEMA, diagnostics)).filter(Boolean);
  const legacySprintPath = join(root, "domains", "sprint.yaml");
  if (existsSync(legacySprintPath)) {
    diagnostics.push(diagnostic(
      "WS052",
      "error",
      "Sprint configuration must use 'workflows/sprint/config.yaml'; the unreleased 'domains/sprint.yaml' path is not supported.",
      { file: relativePath(root, legacySprintPath) },
    ));
  }
  const sprintPath = join(root, "workflows", "sprint", "config.yaml");
  const sprint = existsSync(sprintPath)
    ? readDeclaration(root, sprintPath, SPRINT_CONFIGURATION_SCHEMA, diagnostics)
    : null;

  for (const id of duplicates(sources)) {
    for (const source of sources.filter((item) => item.value.id === id)) {
      diagnostics.push(diagnostic("WS044", "error", `Record source id '${id}' is declared more than once.`, { file: source.path }));
    }
  }
  for (const id of duplicates(projections)) {
    for (const projection of projections.filter((item) => item.value.id === id)) {
      diagnostics.push(diagnostic("WS045", "error", `Record projection id '${id}' is declared more than once.`, { file: projection.path }));
    }
  }

  for (const source of sources) {
    for (const referenced of [source.value.connection, source.value.reconcile_schedule].filter(Boolean)) {
      if (!existsSync(join(root, referenced))) diagnostics.push(diagnostic("WS046", "error", `Record source references missing Workspace file '${referenced}'.`, { file: source.path }));
    }
  }

  for (const projection of projections) {
    const materialization = projection.value.materialization;
    if (materialization?.mode === "workspace-proposal" && !safeWorkspaceTarget(materialization.target)) {
      diagnostics.push(diagnostic("WS047", "error", "Workspace proposal materialization requires a safe relative Markdown target outside .companyos/.", { file: projection.path }));
    }
    if (materialization?.mode === "database-view" && materialization.target !== undefined) {
      diagnostics.push(diagnostic("WS048", "error", "Database-view materialization must not declare a Workspace target.", { file: projection.path }));
    }
  }

  if (sprint) {
    const projectionIds = new Set(projections.map((item) => item.value.id));
    for (const [field, id] of [
      ["participants.projection", sprint.value.participants?.projection],
      ["work_items.projection", sprint.value.work_items?.projection],
    ]) {
      if (id && !projectionIds.has(id)) diagnostics.push(diagnostic("WS049", "error", `Sprint declaration ${field} references unknown record projection '${id}'.`, { file: sprint.path }));
    }
    const { reminder_time: reminder, complete_by: complete, report_at: report } = sprint.value.close ?? {};
    if (reminder && complete && report && !(reminder < complete && complete <= report)) {
      diagnostics.push(diagnostic("WS050", "error", "Sprint close times must satisfy reminder_time < complete_by <= report_at.", { file: sprint.path }));
    }
    if (sprint.value.rollover?.eligible === "selected-states" && !(sprint.value.rollover.states?.length > 0)) {
      diagnostics.push(diagnostic("WS051", "error", "Sprint rollover selected-states requires at least one state.", { file: sprint.path }));
    }
  }

  return {
    diagnostics,
    declarations: {
      sources: sources.map((item) => item.value),
      projections: projections.map((item) => item.value),
      sprint: sprint?.value ?? null,
    },
    summary: {
      record_sources: sources.length,
      record_projections: projections.length,
      sprint_configurations: sprint ? 1 : 0,
    },
  };
}
