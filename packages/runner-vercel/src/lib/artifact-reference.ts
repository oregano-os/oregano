import type { CompanyOSArtifact } from "../../../companyos-builder/types.ts";

/** One server process belongs to one immutable deployment Artifact. */
export class ArtifactReferenceCache {
  #hash: string | undefined;
  #artifact: CompanyOSArtifact | undefined;
  #pending: Promise<void> | undefined;
  readonly #verify: (artifact: CompanyOSArtifact) => void;
  constructor(verify: (artifact: CompanyOSArtifact) => void) { this.#verify = verify; }

  async initialize(hash: string, read: (hash: string) => Promise<CompanyOSArtifact | undefined>): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Deployment Artifact reference must be an exact SHA-256 hash.");
    if (this.#hash && this.#hash !== hash) throw new Error("A running deployment cannot change its Artifact reference.");
    this.#hash = hash;
    if (this.#artifact) return;
    if (this.#pending) return this.#pending;
    this.#pending = (async () => {
      const artifact = await read(hash);
      if (!artifact || artifact.artifactHash !== hash) throw new Error("The exact retained deployment Artifact is unavailable.");
      this.#verify(artifact);
      this.#artifact = artifact;
    })();
    try { await this.#pending; } finally { this.#pending = undefined; }
  }

  get(hash: string): CompanyOSArtifact {
    if (!this.#artifact || this.#hash !== hash) throw new Error("Referenced deployment Artifact has not completed verified startup.");
    return this.#artifact;
  }
}
