import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { inspectCompatibilityRegistry } from "./compatibility-registry.mjs";
import { diagnostic } from "./diagnostics.mjs";
import { readDocument, walkFiles } from "./files.mjs";

const REQUIRED = [
  "document_id", "title", "kind", "status", "authority", "language",
  "updated", "owners", "audience",
];
const STATUSES = new Set(["draft", "approved", "building", "implemented", "superseded", "frozen"]);
const AUTHORITIES = new Set(["canonical", "normative", "informative", "generated", "historical"]);
const AVAILABILITY = new Set(["planned", "experimental", "stable"]);
const RELATION_KEYS = new Set(["depends_on", "supersedes", "implements", "related"]);

const markdownLinks = (body) => [...body.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
  .map((match) => match[1])
  .filter((target) => !target.startsWith("http://") && !target.startsWith("https://") &&
    !target.startsWith("mailto:") && !target.startsWith("#"));

const relationIds = (metadata) => {
  const output = [];
  const relations = metadata?.relations;
  if (!relations || typeof relations !== "object") return output;
  for (const [key, values] of Object.entries(relations)) {
    if (!RELATION_KEYS.has(key)) continue;
    for (const value of Array.isArray(values) ? values : [values]) output.push({ key, value });
  }
  return output;
};

export function inspectDocumentation(repoRoot) {
  const docsRoot = join(repoRoot, "docs");
  const diagnostics = [];
  if (!existsSync(docsRoot)) {
    return { diagnostics: [diagnostic("DOC001", "error", "The canonical docs/ directory is missing.")], documents: [] };
  }

  const paths = walkFiles(docsRoot, {
    include: (path) => path.endsWith(".md"),
    skip: ["_generated"],
  });
  const documents = paths.map((path) => readDocument(docsRoot, path));
  const byId = new Map();

  for (const document of documents) {
    if (document.error) {
      diagnostics.push(diagnostic("DOC002", "error", document.error.message, { file: `docs/${document.relative}` }));
      continue;
    }
    if (!document.data || typeof document.data !== "object") {
      diagnostics.push(diagnostic("DOC003", "error", "Canonical Markdown requires YAML frontmatter.", { file: `docs/${document.relative}` }));
      continue;
    }
    for (const field of REQUIRED) {
      if (document.data[field] === undefined || document.data[field] === null || document.data[field] === "") {
        diagnostics.push(diagnostic("DOC004", "error", `Required metadata field '${field}' is missing.`, { file: `docs/${document.relative}` }));
      }
    }
    if (document.data.document_id) {
      const previous = byId.get(document.data.document_id);
      if (previous) diagnostics.push(diagnostic("DOC005", "error", `Duplicate document_id '${document.data.document_id}' also used by docs/${previous.relative}.`, { file: `docs/${document.relative}` }));
      else byId.set(document.data.document_id, document);
    }
    if (document.data.status && !STATUSES.has(document.data.status)) {
      diagnostics.push(diagnostic("DOC006", "error", `Unknown status '${document.data.status}'.`, { file: `docs/${document.relative}` }));
    }
    if (document.data.authority && !AUTHORITIES.has(document.data.authority)) {
      diagnostics.push(diagnostic("DOC007", "error", `Unknown authority '${document.data.authority}'.`, { file: `docs/${document.relative}` }));
    }
    if (document.data.availability && !AVAILABILITY.has(document.data.availability)) {
      diagnostics.push(diagnostic("DOC008", "error", `Unknown availability '${document.data.availability}'.`, { file: `docs/${document.relative}` }));
    }
    if (document.data.authority !== "historical" && document.data.language !== "en") {
      diagnostics.push(diagnostic("DOC009", "error", "Active canonical engineering documentation must be English.", { file: `docs/${document.relative}` }));
    }
    if (!Array.isArray(document.data.owners) || document.data.owners.length === 0) {
      diagnostics.push(diagnostic("DOC010", "error", "'owners' must be a non-empty list.", { file: `docs/${document.relative}` }));
    }
    if (!Array.isArray(document.data.audience) || document.data.audience.length === 0) {
      diagnostics.push(diagnostic("DOC011", "error", "'audience' must be a non-empty list.", { file: `docs/${document.relative}` }));
    }
    if ((document.data.kind === "command" || document.relative.startsWith("workbench/commands/")) && !document.data.availability) {
      diagnostics.push(diagnostic("DOC012", "error", "Command documentation must declare availability.", { file: `docs/${document.relative}` }));
    }
    for (const source of document.data.migration_sources ?? []) {
      const resolvedSource = normalize(resolve(repoRoot, source));
      if (!resolvedSource.startsWith(repoRoot) || !existsSync(resolvedSource)) {
        diagnostics.push(diagnostic("DOC016", "error", `Migration source '${source}' does not exist inside the repository.`, { file: `docs/${document.relative}` }));
      }
    }

    for (const target of markdownLinks(document.body)) {
      const targetWithoutAnchor = target.split("#")[0];
      if (!targetWithoutAnchor) continue;
      const resolved = normalize(resolve(dirname(document.path), targetWithoutAnchor));
      if (!resolved.startsWith(docsRoot) || !existsSync(resolved)) {
        diagnostics.push(diagnostic("DOC013", "error", `Broken or out-of-tree Markdown link '${target}'.`, { file: `docs/${document.relative}` }));
      }
    }
  }

  for (const document of documents) {
    if (!document.data) continue;
    for (const relation of relationIds(document.data)) {
      if (!byId.has(relation.value)) {
        diagnostics.push(diagnostic("DOC014", "error", `Relation '${relation.key}' references unknown document_id '${relation.value}'.`, { file: `docs/${document.relative}` }));
      }
    }
  }

  const currentStatuses = documents.filter((item) => item.data?.kind === "status" && item.data?.status === "approved");
  if (currentStatuses.length !== 1) {
    diagnostics.push(diagnostic("DOC015", "error", `Expected exactly one approved current status document, found ${currentStatuses.length}.`));
  }

  diagnostics.push(...inspectCompatibilityRegistry(repoRoot, { documentIds: new Set(byId.keys()) }).diagnostics);

  return { diagnostics, documents, byId };
}

export function documentationRegistry(documents) {
  return documents.filter((document) => document.data).map((document) => ({
    document_id: document.data.document_id,
    title: document.data.title,
    path: `docs/${document.relative}`,
    kind: document.data.kind,
    status: document.data.status,
    authority: document.data.authority,
    language: document.data.language,
    updated: String(document.data.updated),
    availability: document.data.availability ?? null,
    migration_sources: document.data.migration_sources ?? [],
    relations: document.data.relations ?? {},
  })).sort((a, b) => a.document_id.localeCompare(b.document_id));
}

const generatedFiles = (repoRoot, documents) => {
  const registry = documentationRegistry(documents);
  const navigation = registry.filter((item) => item.authority !== "historical")
    .map(({ document_id, title, path, kind, status, availability }) => ({ document_id, title, path, kind, status, availability }));
  const architecture = registry.filter((item) => item.kind === "architecture");
  const architectureIndex = [
    "<!-- Generated by `pnpm docs:generate`. Do not edit. -->",
    "# Architecture index",
    "",
    ...architecture.map((item) => `- [${item.title}](../../${item.path}) — ${item.status}`),
    "",
  ].join("\n");
  const outputs = new Map([
    [join(repoRoot, "docs", "_generated", "document-registry.json"), `${JSON.stringify(registry, null, 2)}\n`],
    [join(repoRoot, "docs", "_generated", "navigation.json"), `${JSON.stringify(navigation, null, 2)}\n`],
    [join(repoRoot, "docs", "_generated", "architecture-index.md"), architectureIndex],
  ]);
  for (const document of documents.filter((item) => item.relative.startsWith("workbench/guides/") && item.data)) {
    outputs.set(join(repoRoot, "packages", "cli", "content", "guides", document.relative.slice("workbench/guides/".length)), document.raw);
  }
  return outputs;
};

export function generateDocumentation(repoRoot, documents) {
  const outputs = generatedFiles(repoRoot, documents);
  for (const [path, content] of outputs) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return outputs.size;
}

export function checkGeneratedDocumentation(repoRoot, documents) {
  const diagnostics = [];
  for (const [path, expected] of generatedFiles(repoRoot, documents)) {
    const relative = path.slice(repoRoot.length + 1);
    if (!existsSync(path)) {
      diagnostics.push(diagnostic("DOC020", "error", "Generated documentation artifact is missing.", { file: relative, hint: "Run pnpm docs:generate." }));
    } else if (readFileSync(path, "utf8") !== expected) {
      diagnostics.push(diagnostic("DOC021", "error", "Generated documentation artifact is stale.", { file: relative, hint: "Run pnpm docs:generate." }));
    }
  }
  return diagnostics;
}
