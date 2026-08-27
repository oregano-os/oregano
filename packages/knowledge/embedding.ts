import { sha256 } from "../runtime/canonical.ts";
import {
  KNOWLEDGE_EMBEDDING_DIMENSIONS,
  type EmbeddingAdapter,
  type EmbeddingPolicy,
} from "./contracts.ts";
import { normalizeSearchText } from "./search.ts";

export class LocalHashEmbeddingAdapter implements EmbeddingAdapter {
  readonly id = "oregano/local-hash-embedding";
  readonly version = "1.0.0";
  readonly dimensions = KNOWLEDGE_EMBEDDING_DIMENSIONS;
  readonly dataEgress = "none" as const;

  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = Array<number>(this.dimensions).fill(0);
      for (const token of normalizeSearchText(text)) {
        const digest = sha256(token);
        const index = Number.parseInt(digest.slice(0, 8), 16) % this.dimensions;
        const sign = Number.parseInt(digest.slice(8, 10), 16) % 2 === 0 ? 1 : -1;
        vector[index] += sign;
      }
      const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
    });
  }
}

export function authorizeEmbeddingAdapter(adapter: EmbeddingAdapter | undefined, policy: EmbeddingPolicy): EmbeddingAdapter | undefined {
  if (policy.mode === "disabled") return undefined;
  if (!adapter) throw new Error(`Embedding policy '${policy.mode}' requires an adapter.`);
  if (adapter.dimensions !== KNOWLEDGE_EMBEDDING_DIMENSIONS) throw new Error(`Embedding adapter '${adapter.id}' must produce ${KNOWLEDGE_EMBEDDING_DIMENSIONS} dimensions.`);
  if (policy.adapterId && policy.adapterId !== adapter.id) throw new Error(`Embedding policy allows '${policy.adapterId}', not '${adapter.id}'.`);
  if (policy.mode === "local" && adapter.dataEgress !== "none") throw new Error("Local embedding policy forbids external data egress.");
  if (adapter.dataEgress === "external" && !policy.allowExternalDataEgress) throw new Error("External embedding data egress requires an explicit allowExternalDataEgress decision.");
  return adapter;
}

export const cosineSimilarity = (left: readonly number[], right: readonly number[]): number => {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
};
