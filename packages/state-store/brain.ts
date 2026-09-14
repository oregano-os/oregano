import type { BrainLink, BrainPage, BrainRevision, BrainScope, BrainTake } from "../brain/contracts.ts";

export interface BrainSearchHit {
  slug: string;
  title: string;
  type: string;
  excerpt: string;
  score: number;
  take?: BrainTake;
}

/** All reads must reject an expected-revision mismatch, including empty results. */
export interface BrainStore {
  revision(scope: BrainScope): Promise<BrainRevision | undefined>;
  find(scope: BrainScope, revision: BrainRevision, names: string[]): Promise<BrainPage[]>;
  pages(scope: BrainScope, revision: BrainRevision, slugs: string[]): Promise<BrainPage[]>;
  links(scope: BrainScope, revision: BrainRevision, slugs: string[], limit: number): Promise<{ links: BrainLink[]; has_more: boolean }>;
  search(scope: BrainScope, revision: BrainRevision, args: { query: string; type?: string; slugs?: string[]; limit: number }): Promise<{ hits: BrainSearchHit[]; has_more: boolean }>;
  inventory(scope: BrainScope, revision: BrainRevision): Promise<Array<{ slug: string; content_hash: string }>>;
  /** Atomic page/Take/link projection and change marker. A failed lease/CAS changes nothing. */
  publish(args: { scope: BrainScope; expected?: BrainRevision; revision: BrainRevision; pages: BrainPage[];
    changes: Array<{ slug: string; kind: "created" | "updated" | "removed" }>; lease: { source_id: string; token: string } }): Promise<boolean>;
}
