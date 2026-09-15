import { sha256 } from "../runtime/canonical.ts";
import { BrainError, type BrainRevision } from "./contracts.ts";
import { resolveBrainName } from "./documents.ts";
import { assertBrainPath } from "./paths.ts";
import { parseBrainEntities, type BrainReads } from "./reads.ts";

export interface BrainDeltaInput { since?: string; cursor?: string; entities?: string; budget_tokens?: number }
interface Cursor {
  v: 1 | 2; scope: string; generation: string; after: number; after_slug?: string;
  entities: string[]; entities_digest: string; selected?: string[]; selected_digest?: string; unresolved?: boolean;
  upper?: BrainRevision; since?: string;
}
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");
const sorted = (values: unknown): values is string[] => Array.isArray(values) && values.length <= 8
  && values.every(value => typeof value === "string" && value.length > 0 && value.length <= 160)
  && sha256([...new Set(values)].sort()) === sha256(values);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const timestamp = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
function decode(value: string): Cursor | undefined {
  try {
    if (!value || value.length > 8000 || !/^[A-Za-z0-9_-]+$/.test(value)) return;
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString()) as Cursor;
    if (![1, 2].includes(cursor.v) || typeof cursor.scope !== "string" || typeof cursor.generation !== "string"
      || !integer(cursor.after) || !sorted(cursor.entities) || sha256(cursor.entities) !== cursor.entities_digest) return;
    if (cursor.selected !== undefined) {
      if (!sorted(cursor.selected) || sha256(cursor.selected) !== cursor.selected_digest) return;
      for (const slug of cursor.selected) assertBrainPath(`brain/${slug}.md`);
    }
    if (cursor.after_slug !== undefined) assertBrainPath(`brain/${cursor.after_slug}.md`);
    if (cursor.since !== undefined && !timestamp(cursor.since)) return;
    if (cursor.upper && (!integer(cursor.upper.sequence) || cursor.upper.sequence < cursor.after || cursor.upper.generation !== cursor.generation
      || !/^[a-f0-9]{40}$/.test(cursor.upper.git_commit) || !/^[a-f0-9]{64}$/.test(cursor.upper.configuration_digest) || !timestamp(cursor.upper.indexed_at))) return;
    if (cursor.after_slug !== undefined && !cursor.upper) return;
    return cursor;
  } catch { return; }
}

/** Only content-free index changes are paged; timestamps never serve as the sole ordering key. */
export async function deltaBrain(reads: BrainReads, input: BrainDeltaInput) {
  const budget = input.budget_tokens ?? 2000;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 8000) throw new BrainError("invalid_input", "Change-entry budget must be between 1 and 8000 estimated tokens.");
  if (input.cursor !== undefined && input.since !== undefined) throw new BrainError("invalid_input", "Use a cursor or an indexed-change time, not both.");
  if (input.since !== undefined && !timestamp(input.since)) throw new BrainError("invalid_input", "since must be an explicit ISO timestamp with a timezone.");
  const names = input.entities === undefined ? undefined : parseBrainEntities(input.entities).sort();
  const prior = input.cursor === undefined ? undefined : decode(input.cursor);
  return reads.snapshot(async revision => {
    const refresh = (reason: string) => ({ status: "refresh_required" as const, reason, changes: [], has_more: false, next_cursor: null,
      indexed_revision: revision, budget_tokens: budget, budget_used: 0 });
    if (input.cursor !== undefined && !prior) return refresh("invalid_cursor");
    if (prior && (prior.scope !== sha256(reads.scope) || prior.generation !== revision.generation || prior.after > revision.sequence
      || (prior.upper && prior.upper.sequence > revision.sequence))) return refresh("scope_or_generation_changed");
    if (prior?.unresolved) return refresh("unresolved_context_entities");
    const resolve = async (selectedNames: string[]) => {
      const candidates = selectedNames.length ? await reads.store.find(reads.scope, revision, selectedNames) : [];
      const matches = selectedNames.map(name => resolveBrainName(candidates, name));
      return matches.every(found => found.length === 1) ? [...new Set(matches.map(found => found[0].slug))].sort() : undefined;
    };
    let entities = prior?.entities ?? names ?? [], selected = prior?.selected;
    if (!selected) {
      selected = await resolve(entities);
      // Retained Phase A cursors may already carry canonical identities, including a now-deleted page.
      if (!selected && prior && entities.every(name => name.includes("/") && (() => { try { assertBrainPath(`brain/${name}.md`); return true; } catch { return false; } })())) selected = [...entities];
      if (!selected) return refresh("entity_identity_changed");
    }
    if (prior && names && sha256(names) !== sha256(entities)) {
      const requested = await resolve(names);
      if (!requested || sha256(requested) !== sha256(selected)) return refresh("entity_scope_changed");
    }
    const upper = prior?.upper ?? revision;
    const cursor: Cursor = { v: 2, scope: sha256(reads.scope), generation: revision.generation, after: prior?.after ?? (input.since ? 0 : revision.sequence),
      ...(prior?.after_slug === undefined ? {} : { after_slug: prior.after_slug }), entities, entities_digest: sha256(entities), selected, selected_digest: sha256(selected),
      upper, ...(prior?.since || input.since ? { since: prior?.since ?? new Date(input.since!).toISOString() } : {}) };
    const rows = await reads.store.changes(reads.scope, revision, { after: cursor.after, after_slug: cursor.after_slug, upper: upper.sequence,
      since: cursor.since, ...(entities.length ? { slugs: selected } : {}), limit: 100 });
    const current = await reads.store.pages(reads.scope, revision, [...new Set(rows.changes.map(change => change.slug))]);
    const entries = rows.changes.map(change => {
      const page = current.find(page => page.slug === change.slug);
      return { change_id: `${revision.generation}:${change.sequence}:${change.slug}`, page_id: change.slug, kind: change.kind,
        indexed_revision: { git_commit: change.git_commit, sequence: change.sequence, indexed_at: change.indexed_at },
        current: change.kind === "removed" || !page ? null : { path: page.path, content_hash: page.content_hash } };
    });
    const changes: typeof entries = []; let units = 2;
    for (const entry of entries) {
      const next = JSON.stringify(entry).length + (changes.length ? 1 : 0);
      if (units + next > budget * 4) break;
      changes.push(entry); units += next;
    }
    const hasMore = rows.has_more || changes.length < entries.length;
    if (hasMore && changes.length) {
      const last = rows.changes[changes.length - 1]; cursor.after = last.sequence; cursor.after_slug = last.slug;
    } else if (!hasMore) {
      cursor.after = upper.sequence; delete cursor.after_slug; delete cursor.upper; delete cursor.since;
    }
    return { status: "ok" as const, changes, has_more: hasMore, next_cursor: encode(cursor), indexed_revision: revision,
      upper_revision: upper, budget_tokens: budget, budget_used: Math.ceil((changes.length ? units : 0) / 4),
      ...(hasMore && !changes.length ? { minimum_budget_tokens: Math.ceil((2 + JSON.stringify(entries[0]).length) / 4) } : {}) };
  });
}
