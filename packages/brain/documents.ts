import YAML from "yaml";
import { sha256 } from "../runtime/canonical.ts";
import { assertBrainPath, brainSlug, normalizeBrainReference } from "./paths.ts";
import { splitBody } from "./upstream/timeline.ts";
import { parseTakes } from "./takes.ts";
import { BrainError, type BrainConfiguration, type BrainCorpus, type BrainDiagnostic, type BrainLink, type BrainPage } from "./contracts.ts";

export const MAX_BRAIN_PAGE_UNITS = 100_000;
const normalizeName = (value: string) => normalizeBrainReference(value).normalize("NFKC").toLocaleLowerCase("en");

export function referenceLinks(text: string): Array<{ target: string; context: string }> {
  const result: Array<{ target: string; context: string }> = [];
  for (const match of text.matchAll(/(?<!\\)\[\[([^\[\]\n]+)\]\]|(?<!!)\[[^\]\n]+\]\(([^\s)]+)\)/g)) {
    const target = (match[1] ? match[1].split("|")[0] : match[2]).trim();
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) continue;
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const next = text.indexOf("\n", match.index);
    result.push({ target: normalizeBrainReference(target), context: text.slice(lineStart, next < 0 ? undefined : next).slice(0, 1200) });
  }
  return result;
}

export function parseBrainPage(path: string, markdown: string, config: BrainConfiguration): { page?: BrainPage; diagnostics: BrainDiagnostic[] } {
  assertBrainPath(path);
  const diagnostics: BrainDiagnostic[] = [];
  const issue = (code: string, message: string) => diagnostics.push({ code, message, path, severity: "error" });
  if (markdown.length > MAX_BRAIN_PAGE_UNITS || markdown.includes("\0")) {
    issue("page_bound", "Brain page exceeds the supported text bound or contains binary content."); return { diagnostics };
  }
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = normalized.match(/^\uFEFF?\s*---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/);
  if (!match) { issue("frontmatter_required", "Brain pages require YAML frontmatter followed by Markdown."); return { diagnostics }; }
  let metadata: Record<string, unknown>;
  try {
    const doc = YAML.parseDocument(match[1], { strict: true, uniqueKeys: true });
    if (doc.errors.length) throw new Error();
    metadata = doc.toJS({ maxAliasCount: 0 });
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error();
  } catch { issue("frontmatter_invalid", "Brain frontmatter must be an ordinary YAML object without aliases."); return { diagnostics }; }
  const type = metadata.type, title = metadata.title, aliases = metadata.aliases ?? [], lang = metadata.lang ?? "und";
  if (typeof type !== "string" || !Object.hasOwn(config.types, type)) issue("unknown_type", "Page type is absent from the reviewed Brain declaration.");
  if (typeof title !== "string" || !title.trim() || title.length > 300) issue("title_invalid", "Page title must be nonempty and at most 300 units.");
  if (typeof lang !== "string" || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(lang)) issue("language_invalid", "Page language must be a language tag; omitted language uses the predictable fallback.");
  if (!Array.isArray(aliases) || aliases.length > 32 || aliases.some(alias => typeof alias !== "string" || !alias.trim() || alias.length > 160)) issue("aliases_invalid", "Aliases must be a bounded list of nonempty strings.");
  if (diagnostics.length) return { diagnostics };
  const slug = brainSlug(path);
  if (!slug.startsWith(config.types[type as string].directory + "/")) {
    issue("type_directory_mismatch", "The page must be filed under its declared type directory.");
  }
  const { compiled_truth, timeline } = splitBody(match[2].trim());
  const parsed = parseTakes(compiled_truth, path, config);
  diagnostics.push(...parsed.diagnostics);
  if (timeline.includes("gbrain:takes:")) issue("takes_in_timeline", "Takes belong before the Timeline separator.");
  const links: BrainLink[] = referenceLinks(`${parsed.prose}\n${timeline}`).map(link => ({ ...link, from: slug, relation: "mentions" }));
  // Row text belongs only in the attributed Takes result. Inactive claims must
  // not re-enter current retrieval through link context sent to synthesis.
  for (const take of parsed.takes.filter(take => take.active)) {
    for (const link of referenceLinks(take.source)) links.push({ ...link, from: slug, relation: "evidenced_by", context: `Take #${take.row_num} source` });
    if (take.holder !== "world" && take.holder !== "brain") links.push({ from: slug, target: take.holder, relation: "held_by", context: `Take #${take.row_num} holder` });
  }
  for (const [field, mapping] of Object.entries(config.relationships)) {
    if (metadata[field] === undefined) continue;
    const values = Array.isArray(metadata[field]) ? metadata[field] as unknown[] : [metadata[field]];
    if (values.length > 64 || values.some(value => typeof value !== "string" || !value.trim())) {
      issue("relationship_invalid", "Mapped relationship fields require a string or bounded list of strings."); continue;
    }
    for (const value of values as string[]) links.push({ from: slug, target: normalizeBrainReference(value), relation: mapping.relation, context: `frontmatter.${field}` });
  }
  const original_links = [...new Set([...match[2].matchAll(/\[[^\]\n]+\]\(((?:https?:\/\/|file:\/\/\/)[^\s)]+)\)/g)].map(match => match[1]))];
  return { page: { slug, path, type: type as string, title: (title as string).trim(), lang: lang as string, search_weight: config.types[type as string].search_weight,
    aliases: aliases as string[], metadata, markdown, content_hash: sha256(markdown), compiled_truth, timeline,
    search_text: parsed.prose, takes: parsed.takes, links, original_links }, diagnostics };
}

export function serializeBrainPage(metadata: Record<string, unknown>, compiledTruth: string, timeline: string): string {
  return `---\n${YAML.stringify(metadata).trimEnd()}\n---\n\n${compiledTruth.trim()}${timeline.trim() ? `\n\n<!-- timeline -->\n\n${timeline.trim()}` : ""}\n`;
}

/** Exact slug, then explicit alias/title. Ties are observable, never guessed. */
export function resolveBrainName(pages: readonly BrainPage[], name: string): BrainPage[] {
  const normalized = normalizeName(name);
  const exact = pages.filter(page => normalizeName(page.slug) === normalized);
  if (exact.length) return exact;
  return pages.filter(page => page.aliases.some(alias => normalizeName(alias) === normalized) || normalizeName(page.title) === normalized);
}

/** Derives references from one complete prospective corpus; never creates stub pages. */
export function checkBrainCorpus(files: Record<string, string>, config: BrainConfiguration): BrainCorpus {
  const pages: BrainPage[] = [], diagnostics: BrainDiagnostic[] = [];
  for (const [path, text] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    if (!path.startsWith("brain/")) continue;
    try { const parsed = parseBrainPage(path, text, config); if (parsed.page) pages.push(parsed.page); diagnostics.push(...parsed.diagnostics); }
    catch (error) {
      if (!(error instanceof BrainError)) throw error;
      diagnostics.push({ path, code: error.code, severity: "error", message: error.message });
    }
  }
  for (const page of pages) {
    const issue = (code: string, message: string, row_num?: number) => diagnostics.push({ path: page.path, code, severity: "error" as const, message, ...(row_num === undefined ? {} : { row_num }) });
    for (const link of page.links) {
      const mapping = Object.entries(config.relationships).find(([field]) => link.context === `frontmatter.${field}`)?.[1];
      const matches = resolveBrainName(pages, link.target).filter(target => !mapping || target.type === mapping.target_type);
      if (matches.length === 1) link.resolved = matches[0].slug;
      else diagnostics.push({ path: page.path, severity: "warning", code: matches.length ? "ambiguous_link" : "unresolved_link", message: `Unresolved ${link.relation} reference: ${link.target}.` });
    }
    const evidence = (text: string) => referenceLinks(text).some(link => {
      const matches = resolveBrainName(pages, link.target);
      return matches.length === 1 && config.types[matches[0].type].role === "evidence" && matches[0].original_links.length > 0;
    });
    if (config.types[page.type].role === "evidence" && page.original_links.length === 0) issue("original_source_missing", "Evidence pages require readable context and a direct original-source link.");
    // Treat paragraphs/list items as prose blocks; no Timeline entry IDs or metadata grammar.
    const timelineBlocks = page.timeline.split(/\n\s*\n|\n(?=[-*+]\s)/).filter(block => block.trim() && !/^\s*#{1,6}\s[^\n]+\s*$/.test(block));
    for (const block of timelineBlocks) if (!evidence(block)) issue("timeline_evidence_missing", "Each Timeline prose entry must cite an existing evidence page with its original-source link.");
    for (const take of page.takes) {
      if (!evidence(take.source)) issue("take_evidence_missing", "Each Take must cite an existing internal evidence page with its original-source link.", take.row_num);
      if (take.holder === "world" || take.holder === "brain") continue;
      const holders = resolveBrainName(pages, take.holder).filter(target => ["person", "company"].includes(config.types[target.type].role));
      if (holders.length !== 1) issue("take_holder_unresolved", "A Take holder must resolve to one declared person or company page.", take.row_num);
    }
  }
  return { pages, diagnostics };
}
