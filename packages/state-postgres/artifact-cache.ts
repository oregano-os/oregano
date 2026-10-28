import type { CompanyOSArtifact } from "../companyos-builder/types.ts";
import { assertWorkflowArtifact } from "../runtime/workflow-engine/guard.ts";

/** Bounded process-local cache for immutable, validated database Artifacts. */
export class WorkflowArtifactCache {
  readonly #entries = new Map<string, { artifact: CompanyOSArtifact; bytes: number }>();
  readonly #pending = new Map<string, Promise<CompanyOSArtifact | undefined>>();
  #bytes = 0;
  readonly maxEntries: number;
  readonly maxBytes: number;
  constructor(maxEntries = 16, maxBytes = 64 * 1024 * 1024) {
    this.maxEntries = maxEntries; this.maxBytes = maxBytes;
  }

  async read(databaseKey: string, hash: string, load: () => Promise<CompanyOSArtifact | undefined>): Promise<CompanyOSArtifact | undefined> {
    const key = `${databaseKey}:${hash}`;
    const cached = this.#entries.get(key);
    if (cached) {
      this.#entries.delete(key); this.#entries.set(key, cached);
      return structuredClone(cached.artifact);
    }
    let pending = this.#pending.get(key);
    if (!pending) {
      pending = (async () => {
        const artifact = await load();
        if (!artifact) return undefined; // Missing/failed reads must be retryable after publication.
        assertWorkflowArtifact(artifact);
        if (artifact.artifactHash !== hash) throw new Error("Historical workflow Artifact hash differs from its storage identity");
        const copy = structuredClone(artifact);
        const bytes = Buffer.byteLength(JSON.stringify(copy));
        if (bytes <= this.maxBytes && this.maxEntries > 0) {
          while (this.#entries.size >= this.maxEntries || this.#bytes + bytes > this.maxBytes) {
            const oldest = this.#entries.keys().next().value!;
            this.#bytes -= this.#entries.get(oldest)!.bytes; this.#entries.delete(oldest);
          }
          this.#entries.set(key, { artifact: copy, bytes }); this.#bytes += bytes;
        }
        return copy;
      })();
      this.#pending.set(key, pending);
      // An unconditional rejection handler avoids unhandled promises on failed loads.
      void pending.then(() => this.#pending.delete(key), () => this.#pending.delete(key));
    }
    const artifact = await pending;
    return artifact && structuredClone(artifact);
  }
}
