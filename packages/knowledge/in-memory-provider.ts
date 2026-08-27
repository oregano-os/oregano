import type {
  KnowledgeGetResult,
  KnowledgeProvider,
  KnowledgeSearchResult,
  KnowledgeSnapshot,
  EmbeddingAdapter,
  EmbeddingPolicy,
  KnowledgeAccessAuditor,
  KnowledgeAccessSubject,
} from "./contracts.ts";
import { assertKnowledgeBundleIntegrity } from "./okf.ts";
import { authorizeEmbeddingAdapter, LocalHashEmbeddingAdapter } from "./embedding.ts";
import { searchHybridKnowledgeBundle } from "./hybrid-search.ts";
import { traverseKnowledgeGraph } from "./graph.ts";
import { filterAuthorizedKnowledgeBundle, KnowledgeAuthorizer } from "./access-control.ts";

export class InMemoryKnowledgeProvider implements KnowledgeProvider {
  readonly snapshots = new Map<string, KnowledgeSnapshot>();
  #active?: string;
  readonly #embedding?: EmbeddingAdapter;
  readonly #auditor?: KnowledgeAccessAuditor;

  constructor(options: { embeddingAdapter?: EmbeddingAdapter; embeddingPolicy?: EmbeddingPolicy; accessAuditor?: KnowledgeAccessAuditor } = {}) {
    const policy = options.embeddingPolicy ?? { mode: "local", allowExternalDataEgress: false };
    this.#embedding = authorizeEmbeddingAdapter(options.embeddingAdapter ?? new LocalHashEmbeddingAdapter(), policy);
    this.#auditor = options.accessAuditor;
  }

  async stage(bundle: KnowledgeSnapshot["bundle"]): Promise<KnowledgeSnapshot> {
    assertKnowledgeBundleIntegrity(bundle);
    const existing = this.snapshots.get(bundle.bundleHash);
    if (existing) return structuredClone(existing);
    const snapshot: KnowledgeSnapshot = {
      snapshotHash: bundle.bundleHash,
      status: "staged",
      bundle: structuredClone(bundle),
      stagedAt: new Date().toISOString(),
    };
    this.snapshots.set(snapshot.snapshotHash, snapshot);
    return structuredClone(snapshot);
  }

  async verify(snapshotHash: string): Promise<KnowledgeSnapshot> {
    const snapshot = this.#require(snapshotHash);
    if (snapshot.bundle.bundleHash !== snapshotHash) throw new Error("Knowledge snapshot hash does not match its bundle.");
    if (snapshot.bundle.documentCount !== snapshot.bundle.documents.length) throw new Error("Knowledge snapshot document count is invalid.");
    snapshot.status = snapshot.status === "active" ? "active" : "verified";
    snapshot.verifiedAt ??= new Date().toISOString();
    return structuredClone(snapshot);
  }

  async activate(snapshotHash: string): Promise<KnowledgeSnapshot> {
    const snapshot = this.#require(snapshotHash);
    if (!snapshot.verifiedAt) throw new Error(`Knowledge snapshot '${snapshotHash}' must be verified before activation.`);
    if (this.#active && this.#active !== snapshotHash) this.#require(this.#active).status = "retired";
    snapshot.status = "active";
    snapshot.activatedAt = new Date().toISOString();
    this.#active = snapshotHash;
    return structuredClone(snapshot);
  }

  async activeSnapshot(): Promise<KnowledgeSnapshot | undefined> {
    return this.#active ? structuredClone(this.#require(this.#active)) : undefined;
  }

  async search(input: { query: string; limit?: number; mode?: "lexical" | "hybrid"; subject?: KnowledgeAccessSubject }): Promise<KnowledgeSearchResult> {
    const active = await this.activeSnapshot();
    if (!active) return { query: input.query.trim(), snapshotHash: null, hits: [], gaps: ["no-active-snapshot"], mode: "lexical", degradations: this.#embedding ? [] : ["embedding-disabled"] };
    const authorized = await filterAuthorizedKnowledgeBundle(active.bundle, input.subject, new KnowledgeAuthorizer(active.bundle.accessPolicies, this.#auditor));
    return searchHybridKnowledgeBundle(authorized, input, this.#embedding);
  }

  async get(input: { path: string; subject?: KnowledgeAccessSubject }): Promise<KnowledgeGetResult | undefined> {
    const active = await this.activeSnapshot();
    if (!active) return undefined;
    const document = active.bundle.documents.find((entry) => entry.path === input.path);
    if (!document) return undefined;
    const permit = await new KnowledgeAuthorizer(active.bundle.accessPolicies, this.#auditor).authorize({
      subject: input.subject, permission: "read", policyIds: [document.accessPolicyId], objectType: "document", objectId: document.path,
    });
    return permit ? { snapshotHash: active.snapshotHash, document: structuredClone(document) } : undefined;
  }

  async traverse(input: { path: string; direction?: "outbound" | "inbound" | "both"; maxDepth?: number; maxNodes?: number; subject?: KnowledgeAccessSubject }) {
    const active = await this.activeSnapshot();
    if (!active) return { snapshotHash: null, startPath: input.path, direction: input.direction ?? "both", paths: [], truncated: false, gaps: ["no-active-snapshot" as const] };
    const authorized = await filterAuthorizedKnowledgeBundle(active.bundle, input.subject, new KnowledgeAuthorizer(active.bundle.accessPolicies, this.#auditor));
    return traverseKnowledgeGraph(authorized, input);
  }

  async health() {
    const active = await this.activeSnapshot();
    return { ok: Boolean(active), activeSnapshotHash: active?.snapshotHash ?? null, lexical: true as const, vectorIndex: Boolean(this.#embedding), embeddingAdapter: this.#embedding?.id ?? null };
  }

  #require(snapshotHash: string): KnowledgeSnapshot {
    const snapshot = this.snapshots.get(snapshotHash);
    if (!snapshot) throw new Error(`Unknown Knowledge snapshot '${snapshotHash}'.`);
    return snapshot;
  }
}
