import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { decodeArtifactPayload } from "../../runner-vercel/src/lib/artifact-payload.ts";

test("artifact transport preserves identical data across both compression formats", () => {
  const value = { artifactHash: "retained", data: ["synthetic", { content: "text" }] };
  const bytes = Buffer.from(JSON.stringify(value));
  const gzip = gzipSync(bytes).toString("base64"), brotli = brotliCompressSync(bytes).toString("base64");
  assert.deepEqual(decodeArtifactPayload({ COMPANYOS_ARTIFACT_GZIP_BASE64: gzip }), value);
  assert.deepEqual(decodeArtifactPayload({ COMPANYOS_ARTIFACT_GZIP_BASE64: "", COMPANYOS_ARTIFACT_BROTLI_BASE64: brotli }), value);
  assert.throws(() => decodeArtifactPayload({}), /exactly one/);
  assert.throws(() => decodeArtifactPayload({ COMPANYOS_ARTIFACT_GZIP_BASE64: gzip, COMPANYOS_ARTIFACT_BROTLI_BASE64: brotli }), /exactly one/);
  assert.throws(() => decodeArtifactPayload({ COMPANYOS_ARTIFACT_BROTLI_BASE64: gzip }));
});

test("bundled Artifact preserves the same payload and refuses mixed, missing or oversized transports", () => {
  const value = { artifactHash: "synthetic", instance: { environment: "preview" } };
  const bytes = brotliCompressSync(Buffer.from(JSON.stringify(value)));
  const environment = { COMPANYOS_ARTIFACT_BUNDLED: "true" };
  assert.deepEqual(decodeArtifactPayload(environment, { readBundled: () => bytes }), value);
  assert.throws(() => decodeArtifactPayload({ ...environment, COMPANYOS_ARTIFACT_BROTLI_BASE64: bytes.toString("base64") }), /exactly one/);
  assert.throws(() => decodeArtifactPayload({ COMPANYOS_ARTIFACT_BUNDLED: "../public/artifact" }), /true or unset/);
  assert.throws(() => decodeArtifactPayload(environment, { readBundled: () => { throw new Error("Missing file"); } }), /Missing file/);
  assert.throws(() => decodeArtifactPayload(environment, { readBundled: () => Buffer.alloc(16 * 1024 * 1024 + 1) }), /transport limit/);
  assert.throws(() => decodeArtifactPayload(environment, { readBundled: () => Buffer.from("corrupt") }));
});
