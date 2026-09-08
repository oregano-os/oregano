import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import YAML from "yaml";
import { validateJsonSchemaValue } from "../../capabilities/validation.ts";
import { diagnostic } from "./diagnostics.mjs";
import { relativePath, walkFiles } from "./files.mjs";
import { validateRecordFilters } from "../../records/query.ts";
import { validateRecordSource } from "../../records/source-validation.ts";

const schema = (name) => JSON.parse(readFileSync(new URL(`../../schema/${name}`, import.meta.url), "utf8"));

const RECORD_SOURCE_SCHEMA = schema("company-record-source-v1.schema.json");
const RECORD_PROJECTION_SCHEMA = schema("company-record-projection-v1.schema.json");

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

/** Validate optional Company Records declarations without making them baseline requirements. */
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
      "The retired Sprint domain declaration is not supported; use generic workflow configuration and declared steps.",
      { file: relativePath(root, legacySprintPath) },
    ));
  }
  const retiredPath = join(root, "workflows", "sprint", "config.yaml");
  if (existsSync(retiredPath)) {
    try {
      if (YAML.parse(readFileSync(retiredPath, "utf8"))?.schema_version !== 2) diagnostics.push(diagnostic("WS061", "error", "Sprint configuration v1 is retired; migrate to generic workflow configuration v2 and declared steps.", { file: relativePath(root, retiredPath) }));
    } catch (error) { diagnostics.push(diagnostic("WS042", "error", `Structured declaration is not valid YAML: ${error.message.split("\n")[0]}`, { file: relativePath(root, retiredPath) })); }
  }

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
    try {
      validateRecordSource(source.value);
    } catch (error) {
      diagnostics.push(diagnostic("WS062", "error", `Invalid Record source normalization: ${error.message}`, { file: source.path }));
    }
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

    let selectedSources;
    if (Array.isArray(projection.value.source_ids)) {
      selectedSources = projection.value.source_ids.flatMap((sourceId) => {
        const exact = sources.find((source) => source.value.id === sourceId);
        if (!exact) {
          diagnostics.push(diagnostic("WS053", "error", `Record projection selects unknown source '${sourceId}'.`, { file: projection.path }));
          return [];
        }
        if (exact.value.record_type !== projection.value.record_type) {
          diagnostics.push(diagnostic("WS054", "error", `Record projection type '${projection.value.record_type}' does not match selected source '${sourceId}' type '${exact.value.record_type}'.`, { file: projection.path }));
          return [];
        }
        return [exact];
      });
    } else {
      selectedSources = sources.filter((source) => source.value.record_type === projection.value.record_type);
      if (selectedSources.length === 0) {
        diagnostics.push(diagnostic("WS053", "error", `Record projection type '${projection.value.record_type}' has no matching Record Source.`, { file: projection.path }));
      }
    }
    try {
      validateRecordFilters(projection.value);
    } catch (error) {
      diagnostics.push(diagnostic("WS061", "error", `Invalid Record projection filters: ${error.message}`, { file: projection.path }));
    }

    if (selectedSources.length > 0) {
      const paths = [
        ...Object.keys(projection.value.selection ?? {}),
        ...(projection.value.fields ?? []).map((field) => field.path),
      ];
      for (const path of new Set(paths.filter((candidate) => typeof candidate === "string"))) {
        const rootField = path.split(".")[0];
        const missing = selectedSources
          .filter((source) => !(source.value.fields ?? []).some((field) => field.target === rootField))
          .map((source) => source.value.id);
        if (missing.length > 0) {
          diagnostics.push(diagnostic(
            "WS055",
            "error",
            `Record projection path '${path}' is not materialized by selected source${missing.length === 1 ? "" : "s"} ${missing.map((id) => `'${id}'`).join(", ")}.`,
            { file: projection.path },
          ));
        }
      }
    }
  }

  return {
    diagnostics,
    declarations: {
      sources: sources.map((item) => item.value),
      projections: projections.map((item) => item.value),
    },
    summary: {
      record_sources: sources.length,
      record_projections: projections.length,
    },
  };
}
