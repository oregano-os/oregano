import { gunzipSync } from "node:zlib";
import type { CompanyOSArtifact, CompiledAgent } from "../../../companyos-builder/types.ts";
import { sha256 } from "../../../runtime/canonical.ts";

let cachedArtifact: CompanyOSArtifact | undefined;

export function loadArtifact(): CompanyOSArtifact {
  if (cachedArtifact) return cachedArtifact;
  const encoded = process.env.COMPANYOS_ARTIFACT_GZIP_BASE64;
  if (!encoded) throw new Error("COMPANYOS_ARTIFACT_GZIP_BASE64 is not configured.");
  const parsed = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8")) as CompanyOSArtifact;
  const { artifactHash, ...withoutHash } = parsed;
  const hashInput = {
    ...withoutHash,
    provenance: { ...withoutHash.provenance, builtAt: undefined },
  };
  const actualHash = sha256(hashInput);
  if (actualHash !== artifactHash) throw new Error(`Artifact integrity failure: expected ${artifactHash}, got ${actualHash}.`);
  if (parsed.instance.environment !== "production") {
    throw new Error(`Refusing to run non-production Artifact environment '${parsed.instance.environment}'.`);
  }
  cachedArtifact = parsed;
  return parsed;
}

export function selectedAgent(): CompiledAgent {
  const artifact = loadArtifact();
  const id = process.env.COMPANYOS_AGENT_ID ?? artifact.agents[0]?.id;
  const agent = artifact.agents.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`Configured Agent '${id}' is not present in the Artifact.`);
  return agent;
}
