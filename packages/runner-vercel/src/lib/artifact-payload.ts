import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function readBundledArtifact(): Buffer {
  const file = join(process.cwd(), ".companyos", "artifact.br");
  if (statSync(file).size > 16 * 1024 * 1024) throw new Error("Bundled Artifact exceeds the transport limit");
  return readFileSync(file);
}

/** Deployment transport only. The caller must still verify the Artifact hash and environment. */
export function decodeArtifactPayload(environment: Record<string, string | undefined>, options: { readBundled?: () => Buffer } = {}): unknown {
  const gzip = environment.COMPANYOS_ARTIFACT_GZIP_BASE64;
  const brotli = environment.COMPANYOS_ARTIFACT_BROTLI_BASE64;
  const bundled = environment.COMPANYOS_ARTIFACT_BUNDLED;
  if (bundled && bundled !== "true") throw new Error("Bundled Artifact mode must be true or unset");
  if ([gzip, brotli, bundled].filter(Boolean).length !== 1) throw new Error("Configure exactly one compressed Artifact payload");
  const bytes = bundled ? (options.readBundled ?? readBundledArtifact)() : Buffer.from((brotli || gzip)!, "base64");
  if (bytes.length > 16 * 1024 * 1024) throw new Error("Artifact exceeds the compressed transport limit");
  const decoded = (brotli || bundled ? brotliDecompressSync : gunzipSync)(bytes, { maxOutputLength: 64 * 1024 * 1024 });
  return JSON.parse(decoded.toString("utf8"));
}
