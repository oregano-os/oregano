import { sha256 } from "../runtime/canonical.ts";
import { BrainError, type BrainConfiguration, type BrainPage } from "./contracts.ts";
import { checkBrainCorpus, parseBrainPage, resolveBrainName, serializeBrainPage } from "./documents.ts";
import { assertBrainPath } from "./paths.ts";
import { parseTakes, renderTakes, TAKES_BEGIN, TAKES_END } from "./takes.ts";

export const MAX_BRAIN_WRITE_FILES = 16;
export const MAX_BRAIN_WRITE_UNITS = 400_000;
export interface BrainReplacement { path: string; expected_content_hash: string | null; markdown: string }
export interface BrainRememberInput {
  changes: { expected_revision: string; pages: BrainReplacement[] };
  provenance: { source_id: string; source_version: string; action: string; evidence: string[] };
  operation_key: string;
  dry_run?: boolean;
}
export interface BrainPassageTarget { path: string; expected_content_hash: string; text: string }
export interface BrainForgetInput {
  target: {
    expected_revision: string;
    path: string;
    expected_content_hash: string;
    kind: "page" | "passage" | "take";
    text?: string;
    row_num?: number;
    /** Exact dependent summary assertions selected by the caller after reading the pages. */
    related_passages?: BrainPassageTarget[];
  };
  reason: string;
  operation_key: string;
  dry_run?: boolean;
}
export interface BrainPreparedMutation {
  files: Record<string, string>;
  changes: Array<{ path: string; markdown: string | null }>;
  diagnostics: ReturnType<typeof checkBrainCorpus>["diagnostics"];
}

const fail = (code: string, message: string): never => { throw new BrainError(code, message); };
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function assertBrainWriteIdentity(revision: unknown, operationKey: unknown): void {
  if (typeof revision !== "string" || !/^[a-f0-9]{40}$/.test(revision)) fail("invalid_input", "An exact expected repository revision is required.");
  if (typeof operationKey !== "string" || !operationKey.trim() || operationKey.length > 256) fail("invalid_input", "A stable bounded operation key is required.");
}

function expectedFile(files: Record<string, string>, path: string, expected: string | null): string | undefined {
  assertBrainPath(path);
  if (expected !== null && !digest(expected)) fail("invalid_input", "Expected page content must be a digest or null for creation.");
  const exists = Object.hasOwn(files, path), text = exists ? files[path] : undefined;
  if ((expected === null && exists) || (expected !== null && (!exists || sha256(text) !== expected))) {
    fail("write_conflict", "A selected page changed; read it again and reapply the intended change.");
  }
  return text;
}

function parsedPage(path: string, markdown: string, config: BrainConfiguration): BrainPage {
  if (typeof markdown !== "string") fail("target_missing", "The selected page is absent.");
  const parsed = parseBrainPage(path, markdown, config);
  if (!parsed.page || parsed.diagnostics.some(item => item.severity === "error")) fail("invalid_batch", "A selected page is invalid; run Brain check for diagnostics.");
  return parsed.page!;
}

/** Existing citations may never silently refer to a different claim or holder. */
export function assertBrainTakeContinuity(previous: BrainPage, next: BrainPage): void {
  const old = new Map(previous.takes.map(take => [take.row_num, take]));
  const high = Math.max(0, ...old.keys());
  for (const take of previous.takes) {
    const replacement = next.takes.find(candidate => candidate.row_num === take.row_num);
    if (!replacement || replacement.claim !== take.claim || replacement.holder !== take.holder || replacement.kind !== take.kind
      || (!take.active && replacement.active)) {
      fail("take_identity_conflict", "Keep existing Take row identities and inactive history; supersede a changed claim with a new row.");
    }
  }
  if (next.takes.some(take => !old.has(take.row_num) && take.row_num <= high)) {
    fail("take_identity_conflict", "New Takes must use row numbers above the previous maximum.");
  }
}

function finishMutation(before: Record<string, string>, after: Record<string, string>, config: BrainConfiguration): BrainPreparedMutation {
  const changes = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .filter(path => before[path] !== after[path]).map(path => ({ path, markdown: after[path] ?? null }));
  if (changes.length > MAX_BRAIN_WRITE_FILES || changes.reduce((size, change) => size + (change.markdown?.length ?? 0), 0) > MAX_BRAIN_WRITE_UNITS) {
    fail("write_bound", "The mutation exceeds the bounded file count or total text size; split it into evidenced batches.");
  }
  for (const change of changes) assertBrainPath(change.path);
  const checked = checkBrainCorpus(after, config);
  if (checked.diagnostics.some(item => item.severity === "error")) fail("invalid_batch", "Brain validation: " + checked.diagnostics.filter(item => item.severity === "error").slice(0, 12).map(item => `${item.path}: ${item.code}: ${item.message}`).join("; "));
  return { files: after, changes, diagnostics: checked.diagnostics };
}

/** The complete prospective corpus is checked before any provider mutation. */
export function prepareBrainRemember(files: Record<string, string>, config: BrainConfiguration, input: BrainRememberInput): BrainPreparedMutation {
  assertBrainWriteIdentity(input.changes?.expected_revision, input.operation_key);
  const replacements = input.changes.pages;
  if (!Array.isArray(replacements) || !replacements.length || replacements.length > MAX_BRAIN_WRITE_FILES
    || new Set(replacements.map(change => change.path)).size !== replacements.length) fail("invalid_input", "Provide one bounded set of distinct page replacements.");
  const provenance = input.provenance;
  if (!provenance || [provenance.source_id, provenance.source_version, provenance.action].some(value => typeof value !== "string" || !value.trim() || value.length > 256)
    || !Array.isArray(provenance.evidence) || !provenance.evidence.length || provenance.evidence.length > 16
    || provenance.evidence.some(value => typeof value !== "string" || !value.trim() || value.length > 160)) fail("invalid_input", "Source identity, version, processing action and internal evidence are required.");
  const next = { ...files };
  for (const change of replacements) {
    const previous = expectedFile(files, change.path, change.expected_content_hash);
    if (typeof change.markdown !== "string") fail("invalid_input", "Remember supplies complete Markdown pages; use forget for deletion.");
    const page = parsedPage(change.path, change.markdown, config);
    if (previous !== undefined) assertBrainTakeContinuity(parsedPage(change.path, previous, config), page);
    next[change.path] = change.markdown;
  }
  const prepared = finishMutation(files, next, config);
  const corpus = checkBrainCorpus(next, config);
  for (const source of provenance.evidence) {
    const found = resolveBrainName(corpus.pages, source);
    if (found.length !== 1 || config.types[found[0].type].role !== "evidence" || !found[0].original_links.length) {
      fail("provenance_missing", "Provenance must resolve to existing internal evidence with an original-source link.");
    }
  }
  return prepared;
}

function withoutExactPassage(page: BrainPage, text: string, config: BrainConfiguration): string {
  if (typeof text !== "string" || !text.trim() || text.length > 100_000 || text.includes(TAKES_BEGIN) || text.includes(TAKES_END)) {
    fail("invalid_input", "A bounded exact prose passage is required; target Takes by row instead.");
  }
  const prose = parseTakes(page.compiled_truth, page.path, config).prose;
  const occurrences = (value: string) => {
    let count = 0, offset = 0;
    while ((offset = value.indexOf(text, offset)) !== -1) { count++; offset++; if (count > 1) break; }
    return count;
  };
  const currentCount = occurrences(prose), historyCount = occurrences(page.timeline);
  if (currentCount + historyCount !== 1) fail("ambiguous_target", "The exact prose passage must occur once across current knowledge and Timeline.");
  // Work on parsed prose so a substring cannot modify frontmatter or Take identity.
  const current = currentCount ? prose.replace(text, "") : prose;
  const timeline = historyCount ? page.timeline.replace(text, "") : page.timeline;
  const takes = page.takes.length ? `\n\n${renderTakes(page.takes)}` : "";
  return serializeBrainPage(page.metadata, current + takes, timeline);
}

/** No removed text is returned as an effect receipt, reason or diagnostic. */
export function prepareBrainForget(files: Record<string, string>, config: BrainConfiguration, input: BrainForgetInput): BrainPreparedMutation {
  const target = input.target;
  assertBrainWriteIdentity(target?.expected_revision, input.operation_key);
  if (!digest(target.expected_content_hash)) fail("invalid_input", "Withdrawal requires the previously read page digest.");
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000) fail("invalid_input", "An attributable bounded withdrawal reason is required.");
  if (!["page", "passage", "take"].includes(target.kind)) fail("invalid_input", "Select a page, exact prose passage or Take row.");
  const original = expectedFile(files, target.path, target.expected_content_hash)!;
  const next = { ...files };
  const page = parsedPage(target.path, original, config);
  if (target.kind === "page") delete next[target.path];
  else if (target.kind === "passage") next[target.path] = withoutExactPassage(page, target.text!, config);
  else {
    const take = page.takes.find(take => take.row_num === target.row_num);
    if (!take || !Number.isSafeInteger(target.row_num)) fail("target_missing", "The selected Take row is absent.");
    const prose = parseTakes(page.compiled_truth, page.path, config).prose;
    const takes = page.takes.map(take => take.row_num === target.row_num ? { ...take, active: false } : take);
    next[target.path] = serializeBrainPage(page.metadata, `${prose}\n\n${renderTakes(takes)}`, page.timeline);
  }
  const related = target.related_passages ?? [];
  if (!Array.isArray(related) || related.length > 32 || related.reduce((size, item) => size + (typeof item?.text === "string" ? item.text.length : MAX_BRAIN_WRITE_UNITS + 1), target.text?.length ?? 0) > MAX_BRAIN_WRITE_UNITS) {
    fail("write_bound", "Too many or oversized dependent prose withdrawals in one operation.");
  }
  for (const passage of related) {
    // Every precondition describes the originally read snapshot, including repeated page targets.
    expectedFile(files, passage.path, passage.expected_content_hash);
    if (!Object.hasOwn(next, passage.path)) fail("invalid_input", "A dependent passage cannot target a deleted page.");
    next[passage.path] = withoutExactPassage(parsedPage(passage.path, next[passage.path], config), passage.text, config);
  }
  if (target.kind === "take") {
    const withdrawn = page.takes.find(take => take.row_num === target.row_num)!;
    // Reject an obvious unsupported restatement; semantic paraphrases still require source review.
    const current = parsedPage(target.path, next[target.path], config);
    if (current.search_text.includes(withdrawn.claim)) fail("dependent_assertion_remaining", "Withdraw the selected Take's current-summary assertion in the same operation.");
  }
  return finishMutation(files, next, config);
}
