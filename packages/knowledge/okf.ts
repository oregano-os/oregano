import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import YAML from "yaml";
import { sha256 } from "../runtime/canonical.ts";
import {
  KNOWLEDGE_BUNDLE_SCHEMA_VERSION,
  OKF_VERSION,
  type KnowledgeBundle,
  type KnowledgeDiagnostic,
  type KnowledgeDocument,
  type KnowledgeFragment,
  type OkfType,
  type KnowledgeAccessEntry,
  type KnowledgeAccessPolicy,
  type KnowledgeVisibility,
} from "./contracts.ts";
import { COMPANY_KNOWLEDGE_POLICY, COMPANY_KNOWLEDGE_POLICY_ID, validateKnowledgePolicies } from "./access-control.ts";

const OKF_TYPES = new Set<OkfType>(["concept", "playbook", "note"]);
const OPERATIONAL_HANDBOOK_FILES = new Set(["index.md", "roster.md"]);
const MAX_FRAGMENT_CHARS = 3_000;
const VISIBILITIES = new Set<KnowledgeVisibility>(["public", "company", "team", "restricted_group", "individual", "private"]);

const normalize = (value: string) => value.replace(/\r\n?/g, "\n").trimEnd() + "\n";

const walkMarkdown = (root: string): string[] => {
  if (!existsSync(root)) return [];
  const output: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".md")) output.push(path);
    }
  };
  visit(root);
  return output;
};

const parseFrontmatter = (raw: string, path: string): { data: Record<string, unknown>; body: string; bodyStartLine: number } => {
  const match = raw.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) throw new Error(`${path}: YAML frontmatter is required.`);
  const parsed = YAML.parse(match[1]) ?? {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path}: YAML frontmatter must be an object.`);
  return { data: parsed, body: raw.slice(match[0].length), bodyStartLine: match[0].split("\n").length };
};

const titleFromBody = (body: string, fallback: string): string => {
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || fallback.replace(/\.md$/, "").split("/").at(-1)!.replaceAll("-", " ");
};

const extractLinks = (body: string): string[] => {
  const links = new Set<string>();
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].trim().split(/\s+/)[0].replace(/^<|>$/g, "");
    if (target && !target.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(target)) links.add(target);
  }
  return [...links].sort();
};

const stringList = (value: unknown, field: string, path: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${path}: ${field} must be an array of non-empty stable ids.`);
  }
  return [...new Set(value.map((entry) => String(entry).trim()))].sort();
};

const accessPolicyFromFrontmatter = (data: Record<string, unknown>, path: string): KnowledgeAccessPolicy => {
  const visibility = (data.visibility ?? "company") as KnowledgeVisibility;
  if (!VISIBILITIES.has(visibility)) throw new Error(`${path}: visibility must be public, company, team, restricted_group, individual, or private.`);
  const allowedPrincipals = stringList(data.allowed_principals, "allowed_principals", path);
  const allowedGroups = stringList(data.allowed_groups, "allowed_groups", path);
  const deniedPrincipals = stringList(data.denied_principals, "denied_principals", path);
  const deniedGroups = stringList(data.denied_groups, "denied_groups", path);
  if (visibility === "company" && allowedPrincipals.length === 0 && allowedGroups.length === 0 && deniedPrincipals.length === 0 && deniedGroups.length === 0) {
    return structuredClone(COMPANY_KNOWLEDGE_POLICY);
  }
  if (["team", "restricted_group"].includes(visibility) && allowedGroups.length === 0) throw new Error(`${path}: ${visibility} visibility requires allowed_groups.`);
  if (["individual", "private"].includes(visibility) && allowedPrincipals.length + allowedGroups.length === 0) throw new Error(`${path}: ${visibility} visibility requires allowed_principals or allowed_groups.`);
  if (["public", "company"].includes(visibility) && (allowedPrincipals.length > 0 || allowedGroups.length > 0)) {
    throw new Error(`${path}: allowed subjects require team, restricted_group, individual, or private visibility.`);
  }
  const entries: KnowledgeAccessEntry[] = [
    ...allowedPrincipals.map((subjectId): KnowledgeAccessEntry => ({ subjectKind: "principal", subjectId, permission: "read", effect: "allow" })),
    ...allowedGroups.map((subjectId): KnowledgeAccessEntry => ({ subjectKind: "group", subjectId, permission: "read", effect: "allow" })),
    ...deniedPrincipals.map((subjectId): KnowledgeAccessEntry => ({ subjectKind: "principal", subjectId, permission: "read", effect: "deny" })),
    ...deniedGroups.map((subjectId): KnowledgeAccessEntry => ({ subjectKind: "group", subjectId, permission: "read", effect: "deny" })),
  ].sort((a, b) => a.subjectKind.localeCompare(b.subjectKind) || a.subjectId.localeCompare(b.subjectId) || a.permission.localeCompare(b.permission) || a.effect.localeCompare(b.effect));
  const definition = { visibility, entries };
  return {
    policyId: `policy:okf:${sha256(definition)}`,
    policyVersion: 1,
    visibility,
    ...(visibility !== "public" ? { parentPolicyId: COMPANY_KNOWLEDGE_POLICY_ID } : {}),
    sourceRoot: true,
    status: "active",
    entries,
  };
};

const splitFragment = (args: {
  path: string;
  heading: string;
  lines: string[];
  startLine: number;
}): KnowledgeFragment[] => {
  const chunks: KnowledgeFragment[] = [];
  let cursor = 0;
  while (cursor < args.lines.length) {
    let end = cursor;
    let size = 0;
    while (end < args.lines.length && (size === 0 || size + args.lines[end].length + 1 <= MAX_FRAGMENT_CHARS)) {
      size += args.lines[end].length + 1;
      end += 1;
    }
    const body = normalize(args.lines.slice(cursor, end).join("\n"));
    if (body.trim()) {
      const startLine = args.startLine + cursor;
      const endLine = args.startLine + end - 1;
      const digest = sha256(body);
      chunks.push({
        fragmentId: sha256({ path: args.path, heading: args.heading, startLine, endLine, digest }),
        path: args.path,
        heading: args.heading,
        startLine,
        endLine,
        body,
        digest,
        accessPolicyId: COMPANY_KNOWLEDGE_POLICY_ID,
      });
    }
    cursor = end;
  }
  return chunks;
};

const fragmentDocument = (path: string, title: string, body: string, bodyStartLine: number): KnowledgeFragment[] => {
  const lines = body.split("\n");
  const sections: Array<{ heading: string; start: number; lines: string[] }> = [];
  let current = { heading: title, start: 0, lines: [] as string[] };
  for (let index = 0; index < lines.length; index += 1) {
    const heading = lines[index].match(/^#{1,6}\s+(.+)$/)?.[1]?.trim();
    if (heading && current.lines.some((line) => line.trim())) {
      sections.push(current);
      current = { heading, start: index, lines: [lines[index]] };
    } else {
      if (heading) current.heading = heading;
      current.lines.push(lines[index]);
    }
  }
  if (current.lines.some((line) => line.trim())) sections.push(current);
  return sections.flatMap((section) => splitFragment({
    path,
    heading: section.heading,
    lines: section.lines,
    startLine: bodyStartLine + section.start,
  }));
};

export interface InspectKnowledgeResult {
  diagnostics: KnowledgeDiagnostic[];
  bundle?: KnowledgeBundle;
}

export function inspectKnowledgeWorkspace(args: {
  workspaceRoot: string;
  workspaceCommit?: string;
}): InspectKnowledgeResult {
  const diagnostics: KnowledgeDiagnostic[] = [];
  const handbookRoot = join(args.workspaceRoot, "handbook");
  const indexPath = join(handbookRoot, "index.md");
  if (!existsSync(indexPath)) diagnostics.push({ code: "KNOW001", severity: "error", path: "handbook/index.md", message: "OKF requires handbook/index.md." });
  const indexBody = existsSync(indexPath) ? normalize(readFileSync(indexPath, "utf8")) : "";
  const paths = walkMarkdown(handbookRoot)
    .map((path) => ({ absolute: path, relative: relative(handbookRoot, path).replaceAll("\\", "/") }))
    .filter(({ relative }) => !OPERATIONAL_HANDBOOK_FILES.has(relative));
  const known = new Set(walkMarkdown(handbookRoot).map((path) => relative(handbookRoot, path).replaceAll("\\", "/")));
  const documents: KnowledgeDocument[] = [];
  const policies = new Map<string, KnowledgeAccessPolicy>([[COMPANY_KNOWLEDGE_POLICY.policyId, structuredClone(COMPANY_KNOWLEDGE_POLICY)]]);

  for (const entry of paths) {
    let parsed;
    try {
      parsed = parseFrontmatter(normalize(readFileSync(entry.absolute, "utf8")), `handbook/${entry.relative}`);
    } catch (error) {
      diagnostics.push({ code: "KNOW002", severity: "error", path: `handbook/${entry.relative}`, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const type = parsed.data.type;
    const description = parsed.data.description;
    if (typeof type !== "string" || !OKF_TYPES.has(type as OkfType)) {
      diagnostics.push({ code: "KNOW003", severity: "error", path: `handbook/${entry.relative}`, message: "OKF type must be concept, playbook, or note." });
      continue;
    }
    if (typeof description !== "string" || !description.trim()) {
      diagnostics.push({ code: "KNOW004", severity: "error", path: `handbook/${entry.relative}`, message: "OKF description must be a non-empty string." });
      continue;
    }
    let accessPolicy: KnowledgeAccessPolicy;
    try { accessPolicy = accessPolicyFromFrontmatter(parsed.data, `handbook/${entry.relative}`); }
    catch (error) {
      diagnostics.push({ code: "KNOW008", severity: "error", path: `handbook/${entry.relative}`, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const sensitive = parsed.data.personal_data === true || (parsed.data.data_class !== undefined && parsed.data.data_class !== "business");
    if (sensitive && ["public", "company"].includes(accessPolicy.visibility)) {
      diagnostics.push({ code: "KNOW008", severity: "error", path: `handbook/${entry.relative}`, message: "Sensitive OKF documents require team, restricted_group, individual, or private visibility with explicit allowed subjects." });
      continue;
    }
    policies.set(accessPolicy.policyId, accessPolicy);
    const status = parsed.data.status ?? "current";
    if (!new Set(["current", "stale", "contested"]).has(status as string)) {
      diagnostics.push({ code: "KNOW010", severity: "error", path: `handbook/${entry.relative}`, message: "OKF status must be current, stale, or contested." });
      continue;
    }
    const validUntil = parsed.data.valid_until;
    if (validUntil !== undefined && (typeof validUntil !== "string" || Number.isNaN(Date.parse(validUntil)))) {
      diagnostics.push({ code: "KNOW011", severity: "error", path: `handbook/${entry.relative}`, message: "OKF valid_until must be an ISO date or timestamp." });
      continue;
    }
    if (!parsed.body.trim()) diagnostics.push({ code: "KNOW005", severity: "error", path: `handbook/${entry.relative}`, message: "OKF document body cannot be empty." });
    if (!indexBody.includes(entry.relative)) diagnostics.push({ code: "KNOW006", severity: "error", path: "handbook/index.md", message: `Handbook index does not reference '${entry.relative}'.` });
    const links = extractLinks(parsed.body);
    for (const link of links) {
      const withoutFragment = decodeURIComponent(link.split("#")[0]);
      if (!withoutFragment) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(entry.relative), withoutFragment));
      if (resolved.startsWith("../") || posix.isAbsolute(resolved) || !known.has(resolved)) {
        diagnostics.push({ code: "KNOW007", severity: "error", path: `handbook/${entry.relative}`, message: `Broken or escaping relative link '${link}'.` });
      }
    }
    const body = normalize(parsed.body);
    const title = titleFromBody(body, entry.relative);
    documents.push({
      path: entry.relative,
      type: type as OkfType,
      description: description.trim(),
      status: status as KnowledgeDocument["status"],
      validUntil: validUntil as string | undefined,
      title,
      body,
      digest: sha256({ type, description: description.trim(), status, validUntil, accessPolicyId: accessPolicy.policyId, body }),
      accessPolicyId: accessPolicy.policyId,
      links,
      fragments: fragmentDocument(entry.relative, title, body, parsed.bodyStartLine).map((fragment) => ({ ...fragment, accessPolicyId: accessPolicy.policyId })),
    });
  }

  const byIdentity = new Map<string, string>();
  const byDigest = new Map<string, string>();
  for (const document of documents) {
    const identity = document.path.normalize("NFC").toLocaleLowerCase("en");
    if (byIdentity.has(identity)) diagnostics.push({ code: "KNOW012", severity: "error", path: `handbook/${document.path}`, message: `Ambiguous OKF identity also used by '${byIdentity.get(identity)}'.` });
    else byIdentity.set(identity, document.path);
    if (byDigest.has(document.digest)) diagnostics.push({ code: "KNOW009", severity: "error", path: `handbook/${document.path}`, message: `Exact duplicate OKF content also exists at '${byDigest.get(document.digest)}'.` });
    else byDigest.set(document.digest, document.path);
  }

  if (diagnostics.some((entry) => entry.severity === "error")) return { diagnostics };
  const ordered = documents.sort((a, b) => a.path.localeCompare(b.path));
  const documentPaths = new Set(ordered.map((document) => document.path));
  const edges = ordered.flatMap((document) => document.links.flatMap((link) => {
    const target = posix.normalize(posix.join(posix.dirname(document.path), decodeURIComponent(link.split("#")[0])));
    return documentPaths.has(target) ? [{ from: document.path, to: target }] : [];
  })).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  const orphanPaths = ordered.filter((document) => !edges.some((edge) => edge.from === document.path || edge.to === document.path)).map((document) => document.path);
  if (ordered.length > 1) for (const path of orphanPaths) diagnostics.push({ code: "KNOW013", severity: "warning", path: `handbook/${path}`, message: "OKF document has no inbound or outbound knowledge link." });
  const graphHash = sha256(edges);
  const accessPolicies = [...policies.values()].sort((a, b) => a.policyId.localeCompare(b.policyId));
  try { validateKnowledgePolicies(accessPolicies); }
  catch (error) {
    diagnostics.push({ code: "KNOW014", severity: "error", message: error instanceof Error ? error.message : String(error) });
    return { diagnostics };
  }
  const policyHash = sha256({ okfVersion: OKF_VERSION, accessPolicies, maxFragmentChars: MAX_FRAGMENT_CHARS, graphMaxDepth: 5, graphMaxNodes: 100 });
  const withoutHash = {
    schemaVersion: KNOWLEDGE_BUNDLE_SCHEMA_VERSION,
    okfVersion: OKF_VERSION,
    workspaceCommit: args.workspaceCommit ?? "uncommitted",
    policyHash,
    accessPolicies,
    documents: ordered,
    edges,
    orphanPaths,
    graphHash,
    documentCount: ordered.length,
    fragmentCount: ordered.reduce((sum, document) => sum + document.fragments.length, 0),
  };
  return { diagnostics, bundle: { ...withoutHash, bundleHash: sha256(withoutHash) } };
}

export function buildKnowledgeBundle(args: { workspaceRoot: string; workspaceCommit: string }): KnowledgeBundle {
  const result = inspectKnowledgeWorkspace(args);
  if (!result.bundle) throw new Error(`Company Knowledge validation failed:\n- ${result.diagnostics.map((entry) => `${entry.path ?? "workspace"}: ${entry.message}`).join("\n- ")}`);
  return result.bundle;
}

export function assertKnowledgeBundleIntegrity(bundle: KnowledgeBundle): void {
  if (bundle.schemaVersion !== KNOWLEDGE_BUNDLE_SCHEMA_VERSION || bundle.okfVersion !== OKF_VERSION) {
    throw new Error("Unsupported Knowledge Bundle or OKF version.");
  }
  if (bundle.documentCount !== bundle.documents.length) throw new Error("Knowledge Bundle document count is invalid.");
  validateKnowledgePolicies(bundle.accessPolicies);
  const policies = new Set(bundle.accessPolicies.map((policy) => policy.policyId));
  if (bundle.policyHash !== sha256({ okfVersion: OKF_VERSION, accessPolicies: bundle.accessPolicies, maxFragmentChars: MAX_FRAGMENT_CHARS, graphMaxDepth: 5, graphMaxNodes: 100 })) throw new Error("Knowledge Bundle policy hash is invalid.");
  const fragmentCount = bundle.documents.reduce((sum, document) => sum + document.fragments.length, 0);
  if (bundle.fragmentCount !== fragmentCount) throw new Error("Knowledge Bundle fragment count is invalid.");
  for (const document of bundle.documents) {
    if (!policies.has(document.accessPolicyId)) throw new Error(`Knowledge document '${document.path}' has an unknown access policy.`);
    const expectedDocumentDigest = sha256({ type: document.type, description: document.description, status: document.status, validUntil: document.validUntil, accessPolicyId: document.accessPolicyId, body: document.body });
    if (document.digest !== expectedDocumentDigest) throw new Error(`Knowledge document '${document.path}' has an invalid digest.`);
    for (const fragment of document.fragments) {
      if (fragment.path !== document.path || fragment.accessPolicyId !== document.accessPolicyId || fragment.digest !== sha256(fragment.body)) {
        throw new Error(`Knowledge fragment '${fragment.fragmentId}' has invalid content or provenance.`);
      }
      const expectedFragmentId = sha256({ path: fragment.path, heading: fragment.heading, startLine: fragment.startLine, endLine: fragment.endLine, digest: fragment.digest });
      if (fragment.fragmentId !== expectedFragmentId) throw new Error(`Knowledge fragment '${fragment.fragmentId}' has an invalid identity.`);
    }
  }
  const orderedEdges = [...bundle.edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  if (JSON.stringify(bundle.edges) !== JSON.stringify(orderedEdges) || new Set(orderedEdges.map((edge) => `${edge.from}\0${edge.to}`)).size !== orderedEdges.length) {
    throw new Error("Knowledge Bundle graph edges must be sorted and unique.");
  }
  if (bundle.graphHash !== sha256(orderedEdges)) throw new Error("Knowledge Bundle graph hash is invalid.");
  const paths = new Set(bundle.documents.map((document) => document.path));
  if (orderedEdges.some((edge) => !paths.has(edge.from) || !paths.has(edge.to))) throw new Error("Knowledge Bundle graph references an unknown document.");
  let expectedEdges: typeof orderedEdges;
  try {
    expectedEdges = bundle.documents.flatMap((document) => document.links.flatMap((link) => {
      const target = posix.normalize(posix.join(posix.dirname(document.path), decodeURIComponent(link.split("#")[0])));
      return paths.has(target) ? [{ from: document.path, to: target }] : [];
    })).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  } catch { throw new Error("Knowledge Bundle graph contains an invalid encoded link."); }
  if (JSON.stringify(orderedEdges) !== JSON.stringify(expectedEdges)) throw new Error("Knowledge Bundle graph does not match its document links.");
  const expectedOrphans = bundle.documents
    .filter((document) => !orderedEdges.some((edge) => edge.from === document.path || edge.to === document.path))
    .map((document) => document.path)
    .sort();
  if (JSON.stringify(bundle.orphanPaths) !== JSON.stringify(expectedOrphans)) throw new Error("Knowledge Bundle orphan projection is invalid.");
  const { bundleHash: _bundleHash, ...withoutHash } = bundle;
  if (bundle.bundleHash !== sha256(withoutHash)) throw new Error("Knowledge Bundle hash is invalid.");
}

export function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const root = resolve(workspaceRoot);
  const path = resolve(candidate);
  return path === root || path.startsWith(`${root}/`);
}
