import { gunzipSync } from "node:zlib";
import type { CompanyOSArtifact, CompiledAgent } from "../../../companyos-builder/types.ts";
import { sha256 } from "../../../runtime/canonical.ts";
import { resolveAgent } from "../../../runtime/agent-resolver.ts";

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
  const id = process.env.COMPANYOS_AGENT_ID
    ?? artifact.agentRouting?.defaultAgentId
    ?? (artifact.agents.length === 1 ? artifact.agents[0]?.id : undefined);
  if (!id) {
    throw new Error("A multi-agent Artifact cannot use artifact order; configure an explicit Agent id or resolve an Agent Binding.");
  }
  const agent = artifact.agents.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`Configured Agent '${id}' is not present in the Artifact.`);
  return agent;
}

export function resolvedAgentForConversation(args: {
  threadId: string;
  requesterPrincipal: string;
}): CompiledAgent {
  const artifact = loadArtifact();
  const thread = parseThreadIdentity(args.threadId);
  const principal = parsePrincipalIdentity(args.requesterPrincipal);
  if (thread.surface !== principal.surface) {
    throw new Error("Conversation surface does not match the authenticated requester principal.");
  }
  const resolution = resolveAgent(
    artifact.agentRouting ?? { bindings: [] },
    artifact.agents.map((candidate) => candidate.id),
    {
      surface: thread.surface,
      accountId: principal.accountId,
      channelId: thread.channelId,
    },
  );
  const agent = artifact.agents.find((candidate) => candidate.id === resolution.agentId);
  if (!agent) throw new Error(`Resolved Agent '${resolution.agentId}' is not present in the Artifact.`);
  return agent;
}

function parseThreadIdentity(threadId: string): { surface: string; channelId: string } {
  const [surface, channelId] = threadId.split(":");
  if (!surface || !channelId) throw new Error(`Conversation thread id '${threadId}' is not surface-qualified.`);
  return { surface, channelId };
}

function parsePrincipalIdentity(principal: string): { surface: string; accountId: string } {
  const [surface, accountId, subjectId] = principal.split(":");
  if (!surface || !accountId || !subjectId) {
    throw new Error(`Requester principal '${principal}' is not surface- and account-qualified.`);
  }
  return { surface, accountId };
}
