import { brotliDecompressSync, gunzipSync } from "node:zlib";

/** Deployment transport only. The caller must still verify the Artifact hash and environment. */
export function decodeArtifactPayload(environment: Record<string, string | undefined>): unknown {
  const gzip = environment.COMPANYOS_ARTIFACT_GZIP_BASE64;
  const brotli = environment.COMPANYOS_ARTIFACT_BROTLI_BASE64;
  if (Boolean(gzip) === Boolean(brotli)) throw new Error("Configure exactly one compressed Artifact payload");
  const bytes = Buffer.from((brotli || gzip)!, "base64");
  const decoded = (brotli ? brotliDecompressSync : gunzipSync)(bytes, { maxOutputLength: 64 * 1024 * 1024 });
  return JSON.parse(decoded.toString("utf8"));
}
