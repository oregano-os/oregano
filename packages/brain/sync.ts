import { randomUUID } from "node:crypto";
import { sha256 } from "../runtime/canonical.ts";
import type { BrainStore } from "../state-store/brain.ts";
import type { CompanyRecordsStore } from "../state-store/records.ts";
import { BrainError, type BrainConfiguration, type BrainScope } from "./contracts.ts";
import { checkBrainCorpus } from "./documents.ts";

/** Trusted adapter: credentials and provider APIs never enter Agent inputs. */
export interface BrainRepositoryReader {
  revision(): Promise<string>;
  read(revision: string): Promise<Record<string, string>>;
}

export async function syncBrain(args: { scope: BrainScope; configuration: BrainConfiguration; store: BrainStore; repository: BrainRepositoryReader;
  leases: Pick<CompanyRecordsStore, "claimSyncLease" | "releaseSyncLease">; now?: () => Date }) {
  const now = args.now ?? (() => new Date());
  const sourceId = `brain:${sha256(args.scope)}`, token = randomUUID();
  const acquired = await args.leases.claimSyncLease({ instanceId: args.scope.instance_id, sourceId, owner: "brain-sync", token,
    now: now().toISOString(), expiresAt: new Date(now().getTime() + 300_000).toISOString() });
  if (!acquired) throw new BrainError("sync_busy", "Another synchronization owns this repository lease.");
  try {
    // Read the current head after taking the lease; stale push payloads cannot select an older revision.
    const gitCommit = await args.repository.revision();
    if (!/^[a-f0-9]{40}$/.test(gitCommit)) throw new BrainError("repository_revision_invalid", "Repository must return an immutable Git commit.");
    const expected = await args.store.revision(args.scope), configurationDigest = sha256(args.configuration);
    if (expected?.git_commit === gitCommit && expected.configuration_digest === configurationDigest) return { status: "unchanged", indexed_revision: expected, diagnostics: [] };
    const files = await args.repository.read(gitCommit), checked = checkBrainCorpus(files, args.configuration);
    if (checked.diagnostics.some(item => item.severity === "error")) return { status: "invalid", indexed_revision: expected ?? null, diagnostics: checked.diagnostics };
    const previous = expected ? await args.store.inventory(args.scope, expected) : [];
    const old = new Map(previous.map(item => [item.slug, item.content_hash])), next = new Set(checked.pages.map(page => page.slug));
    const changes: Array<{ slug: string; kind: "created" | "updated" | "removed" }> = [];
    for (const page of checked.pages) {
      if (!old.has(page.slug)) changes.push({ slug: page.slug, kind: "created" });
      else if (old.get(page.slug) !== page.content_hash || expected?.configuration_digest !== configurationDigest) changes.push({ slug: page.slug, kind: "updated" });
    }
    for (const item of previous) if (!next.has(item.slug)) changes.push({ slug: item.slug, kind: "removed" });
    // A changed interpretation of the files requires fresh context, including for
    // older cursors that predate configuration fields in the cursor contract.
    const sameConfiguration = expected?.configuration_digest === configurationDigest;
    const revision = { git_commit: gitCommit, configuration_digest: configurationDigest, generation: sameConfiguration ? expected!.generation : randomUUID(),
      sequence: (sameConfiguration ? expected!.sequence : 0) + (changes.length ? 1 : 0), indexed_at: now().toISOString() };
    if (!await args.store.publish({ scope: args.scope, expected, revision, pages: checked.pages, changes, lease: { source_id: sourceId, token } })) {
      throw new BrainError("sync_conflict", "The projection or synchronization lease changed; retry from the current repository revision.");
    }
    return { status: "indexed", indexed_revision: revision, changed: changes.length, diagnostics: checked.diagnostics };
  } finally { await args.leases.releaseSyncLease({ instanceId: args.scope.instance_id, sourceId, token }); }
}
