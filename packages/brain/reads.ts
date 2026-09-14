import { sha256 } from "../runtime/canonical.ts";
import type { BrainStore, BrainSearchHit } from "../state-store/brain.ts";
import { BrainError, type BrainPage, type BrainRevision, type BrainScope } from "./contracts.ts";
import { resolveBrainName } from "./documents.ts";
import { deltaBrain, type BrainDeltaInput } from "./delta.ts";

export const sameBrainRevision = (a: BrainRevision | undefined, b: BrainRevision | undefined) => !!a && !!b
  && a.generation === b.generation && a.sequence === b.sequence && a.git_commit === b.git_commit && a.configuration_digest === b.configuration_digest;
export const requireText = (value: unknown, label: string, max = 500): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new BrainError("invalid_input", `${label} must be nonempty bounded text.`);
  return value.trim();
};
const bounded = (value: number | undefined, fallback: number, max: number) => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new BrainError("invalid_input", `Expected an integer between 1 and ${max}.`);
  return value;
};
export const parseBrainEntities = (value: string) => {
  const names = [...new Set(requireText(value, "entities", 2000).split(",").map(name => requireText(name, "entity", 160)))];
  if (names.length > 8) throw new BrainError("invalid_input", "At most eight entities are supported.");
  return names;
};

/** Retry only a changed read snapshot, never a provider/model effect. */
export async function withBrainSnapshot<T>(store: BrainStore, scope: BrainScope, read: (revision: BrainRevision) => Promise<T>, configurationDigest?: string): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const revision = await store.revision(scope);
    if (!revision) throw new BrainError("not_indexed", "Brain has no successfully indexed revision.");
    if (configurationDigest !== undefined && revision.configuration_digest !== configurationDigest) throw new BrainError("sync_required", "The Brain projection has not indexed the deployed configuration yet.");
    try {
      const value = await read(revision);
      if (!sameBrainRevision(revision, await store.revision(scope))) throw new BrainError("snapshot_changed", "Brain changed during the read.");
      return value;
    } catch (error) { if (!(error instanceof BrainError) || error.code !== "snapshot_changed" || attempt === 2) throw error; }
  }
  throw new BrainError("snapshot_changed", "Retry this read against a stable Brain revision.");
}

/** Content-free, scoped starting marker. It is never an authorization credential. */
export function brainContextCursor(scope: BrainScope, revision: BrainRevision, entities: string[], selected?: string[], unresolved = false): string {
  return Buffer.from(JSON.stringify({ v: 1, scope: sha256(scope), generation: revision.generation, after: revision.sequence,
    entities: [...entities].sort(), entities_digest: sha256([...entities].sort()),
    ...(selected ? { selected: [...selected].sort(), selected_digest: sha256([...selected].sort()), unresolved } : {}) })).toString("base64url");
}

export class BrainReads {
  readonly store: BrainStore;
  readonly scope: BrainScope;
  readonly configurationDigest?: string;
  constructor(store: BrainStore, scope: BrainScope, configurationDigest?: string) { this.store = store; this.scope = scope; this.configurationDigest = configurationDigest; }
  snapshot<T>(read: (revision: BrainRevision) => Promise<T>) { return withBrainSnapshot(this.store, this.scope, read, this.configurationDigest); }
  delta(input: BrainDeltaInput) { return deltaBrain(this, input); }

  async entity(name: string) {
    name = requireText(name, "name", 160);
    return this.snapshot(async revision => {
      const candidates = resolveBrainName(await this.store.find(this.scope, revision, [name]), name);
      if (candidates.length !== 1) return { found: false as const, status: candidates.length ? "ambiguous" : "not_found", candidates: candidates.map(page => ({ slug: page.slug, title: page.title })), indexed_revision: revision };
      const page = candidates[0], graph = await this.store.links(this.scope, revision, [page.slug], 100);
      return { found: true as const, status: "found", page, outgoing: graph.links.filter(link => link.from === page.slug),
        backlinks: graph.links.filter(link => link.resolved === page.slug), omitted_links: graph.has_more, indexed_revision: revision };
    });
  }

  async recall(input: { query: string; type?: string; entity?: string; limit?: number }) {
    const query = requireText(input.query, "query"), limit = bounded(input.limit, 10, 50);
    if (input.type !== undefined) requireText(input.type, "type", 64);
    if (input.entity !== undefined) requireText(input.entity, "entity", 160);
    return this.snapshot(revision => this.recallAt(revision, { ...input, query, limit }));
  }

  async recallAt(revision: BrainRevision, input: { query: string; type?: string; entity?: string; limit: number }) {
    let slugs: string[] | undefined;
    let omittedNeighbors = false;
    if (input.entity) {
      const pages = resolveBrainName(await this.store.find(this.scope, revision, [input.entity]), input.entity);
      if (pages.length !== 1) return { hits: [] as BrainSearchHit[], has_more: false, status: pages.length ? "ambiguous" : "not_found", candidates: pages.map(page => page.slug), indexed_revision: revision };
      const graph = await this.store.links(this.scope, revision, [pages[0].slug], 50);
      slugs = [...new Set([pages[0].slug, ...graph.links.flatMap(link => link.resolved ? [link.from, link.resolved] : [link.from])])];
      omittedNeighbors = graph.has_more;
    }
    const result = await this.store.search(this.scope, revision, { query: input.query, type: input.type, slugs, limit: input.limit });
    const seen = new Set<string>();
    const hits = result.hits.filter(hit => { const key = `${hit.slug}#${hit.take?.row_num ?? "page"}`; if (seen.has(key)) return false; seen.add(key); return !hit.take || hit.take.active; });
    return { ...result, hits, status: "ok", omitted_neighbors: omittedNeighbors, indexed_revision: revision };
  }

  async contextPack(input: { entities: string; budget_tokens?: number }) {
    const names = parseBrainEntities(input.entities), budget = bounded(input.budget_tokens, 4000, 8000);
    return this.snapshot(async revision => {
      const candidates = await this.store.find(this.scope, revision, names), selected: BrainPage[] = [];
      const unresolved: Array<{ name: string; status: string; candidates: string[] }> = [];
      for (const name of names) {
        const matches = resolveBrainName(candidates, name);
        if (matches.length === 1) { if (!selected.some(page => page.slug === matches[0].slug)) selected.push(matches[0]); }
        else unresolved.push({ name, status: matches.length ? "ambiguous" : "not_found", candidates: matches.map(page => page.slug) });
      }
      let text = "";
      const references: Array<{ slug: string; row_num: number | null }> = [], omissions: Array<{ slug: string; part: string }> = [];
      const pack = (page: BrainPage, part: string, value: string, row_num: number | null = null) => {
        const block = `\n[${page.slug}${row_num === null ? "" : `#${row_num}`}] ${page.title} — ${part}\n${value}\n`;
        if (text.length + block.length > budget * 4) { omissions.push({ slug: page.slug, part }); return; }
        text += block; references.push({ slug: page.slug, row_num });
      };
      for (const page of selected) pack(page, "current knowledge", page.search_text);
      for (const page of selected) for (const take of page.takes.filter(take => take.active)) pack(page, "attributed Take", JSON.stringify(take), take.row_num);
      for (const page of selected) if (page.timeline) pack(page, "Timeline", page.timeline);
      for (const page of selected) if (page.original_links.length) pack(page, "original sources", page.original_links.join("\n"));
      return { text, references, unresolved, omissions, budget_tokens: budget, budget_used: Math.ceil(text.length / 4), dropped_count: omissions.length,
        indexed_revision: revision, change_cursor: brainContextCursor(this.scope, revision, names, selected.map(page => page.slug), unresolved.length > 0) };
    });
  }
}
