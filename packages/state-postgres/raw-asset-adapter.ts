import { createHash } from "node:crypto";
import type { SourceRawAssetStager } from "../knowledge/source-pipeline-store.ts";
import { sha256 } from "../runtime/canonical.ts";

export const POSTGRES_INLINE_RAW_ASSET_ADAPTER_ID = "oregano/postgres-inline-raw-asset";
export const POSTGRES_INLINE_RAW_ASSET_ADAPTER_VERSION = "1.0.0";
export const POSTGRES_INLINE_RAW_ASSET_STORAGE_PREFIX = "postgres-inline:";

export function postgresInlineRawAssetStorageKey(assetId: string): string {
  return `${POSTGRES_INLINE_RAW_ASSET_STORAGE_PREFIX}${assetId}`;
}

export function createPostgresInlineRawAssetStager(): SourceRawAssetStager {
  return {
    id: POSTGRES_INLINE_RAW_ASSET_ADAPTER_ID,
    version: POSTGRES_INLINE_RAW_ASSET_ADAPTER_VERSION,
    async stage(input) {
      const payload = new Uint8Array(input.bytes);
      const contentDigest = createHash("sha256").update(payload).digest("hex");
      const assetId = `asset:${sha256({
        adapter: POSTGRES_INLINE_RAW_ASSET_ADAPTER_ID,
        sourceId: input.sourceId,
        providerObjectId: input.providerObjectId,
        providerVersion: input.providerVersion,
        mediaType: input.mediaType,
        contentDigest,
      }).slice(0, 48)}`;
      return {
        reference: {
          assetId,
          contentDigest,
          mediaType: input.mediaType,
          size: payload.byteLength,
          storageKey: postgresInlineRawAssetStorageKey(assetId),
        },
        payload,
      };
    },
  };
}
