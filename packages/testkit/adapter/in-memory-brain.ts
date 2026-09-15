import type { BrainStore, BrainSearchHit } from "../../state-store/brain.ts";
import { BrainError, type BrainPage, type BrainRevision, type BrainScope } from "../../brain/contracts.ts";
import { resolveBrainName } from "../../brain/documents.ts";
import { sameBrainRevision } from "../../brain/reads.ts";

/** Deterministic contract fixture; it does not qualify PostgreSQL full-text ranking. */
export class InMemoryBrainStore implements BrainStore {
  readonly snapshots = new Map<string, { revision: BrainRevision; pages: BrainPage[] }>();
  readonly publications: Parameters<BrainStore["publish"]>[0][] = [];
  leaseValid: (scope: BrainScope, lease: { source_id: string; token: string }) => boolean = () => true;
  key(scope: BrainScope) { return JSON.stringify([scope.instance_id, scope.repository_id]); }
  async revision(scope: BrainScope) { return structuredClone(this.snapshots.get(this.key(scope))?.revision); }
  snapshot(scope: BrainScope, revision: BrainRevision) {
    const value = this.snapshots.get(this.key(scope));
    if (!value || !sameBrainRevision(value.revision, revision)) throw new BrainError("snapshot_changed", "Fixture snapshot changed.");
    return structuredClone(value);
  }
  async find(scope: BrainScope, revision: BrainRevision, names: string[]) {
    const pages = this.snapshot(scope, revision).pages;
    return pages.filter(page => names.some(name => resolveBrainName(pages, name).some(match => match.slug === page.slug)));
  }
  async pages(scope: BrainScope, revision: BrainRevision, slugs: string[]) { return this.snapshot(scope, revision).pages.filter(page => slugs.includes(page.slug)); }
  async links(scope: BrainScope, revision: BrainRevision, slugs: string[], limit: number) {
    const links = this.snapshot(scope, revision).pages.flatMap(page => page.links).filter(link => slugs.includes(link.from) || (!!link.resolved && slugs.includes(link.resolved)));
    return { links: links.slice(0, limit), has_more: links.length > limit };
  }
  async search(scope: BrainScope, revision: BrainRevision, args: Parameters<BrainStore["search"]>[2]) {
    const terms = args.query.toLowerCase().split(/\W+/).filter(Boolean), hits: BrainSearchHit[] = [];
    const score = (text: string) => terms.filter(term => text.toLowerCase().includes(term)).length;
    for (const page of this.snapshot(scope, revision).pages) {
      if ((args.type && page.type !== args.type) || (args.slugs && !args.slugs.includes(page.slug))) continue;
      const rank = score(page.title) * 4 + score(page.search_text) * 2 + score(page.timeline);
      if (rank) hits.push({ slug: page.slug, title: page.title, type: page.type, excerpt: page.search_text.slice(0, 1200), score: rank });
      for (const take of page.takes.filter(take => take.active)) if (score(take.claim)) hits.push({ slug: page.slug, title: page.title, type: page.type, excerpt: take.claim, score: score(take.claim) * 2, take });
    }
    hits.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug) || (a.take?.row_num ?? 0) - (b.take?.row_num ?? 0));
    return { hits: hits.slice(0, args.limit), has_more: hits.length > args.limit };
  }
  async inventory(scope: BrainScope, revision: BrainRevision) { return this.snapshot(scope, revision).pages.map(page => ({ slug: page.slug, content_hash: page.content_hash })); }
  async changes(scope: BrainScope, revision: BrainRevision, args: Parameters<BrainStore["changes"]>[2]) {
    this.snapshot(scope, revision);
    const changes = this.publications.filter(item => this.key(item.scope) === this.key(scope) && item.revision.generation === revision.generation)
      .flatMap(item => item.changes.map(change => ({ ...change, sequence: item.revision.sequence, git_commit: item.revision.git_commit, indexed_at: item.revision.indexed_at })))
      .filter(change => (change.sequence > args.after || change.sequence === args.after && args.after_slug !== undefined && change.slug > args.after_slug)
        && change.sequence <= args.upper && (!args.since || change.indexed_at >= args.since) && (!args.slugs || args.slugs.includes(change.slug)))
      .sort((a, b) => a.sequence - b.sequence || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
    return { changes: changes.slice(0, args.limit), has_more: changes.length > args.limit };
  }
  async publish(args: Parameters<BrainStore["publish"]>[0]) {
    const current = await this.revision(args.scope);
    if ((args.expected ? !sameBrainRevision(current, args.expected) : !!current) || !this.leaseValid(args.scope, args.lease)) return false;
    this.snapshots.set(this.key(args.scope), structuredClone({ revision: args.revision, pages: args.pages }));
    this.publications.push(structuredClone(args)); return true;
  }
}
