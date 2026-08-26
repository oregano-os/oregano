import type { NetworkPolicy } from "@vercel/sandbox";
import type { BuilderAcpProfileId } from "../../../../runtime/builder/profiles.ts";

const PLACEHOLDER = "companyos-builder-broker-placeholder";

export interface VercelModelCredentialBinding {
  readonly profileId: BuilderAcpProfileId;
  readonly host: "api.anthropic.com" | "api.openai.com";
  readonly credentialHeader: "x-api-key" | "authorization";
  readonly agentEnvironment: Readonly<Record<string, string>>;
  readonly networkPolicy: NetworkPolicy;
}
/**
 * Keeps the real model credential in the Vercel network policy. The coding
 * process receives only a recognizable placeholder that must match before the
 * provider substitutes the outbound header.
 */
export function createVercelModelCredentialBinding(
  profileId: BuilderAcpProfileId,
  credential: string,
): VercelModelCredentialBinding {
  assertCredential(credential);
  if (profileId === "claude-code") {
    return {
      profileId,
      host: "api.anthropic.com",
      credentialHeader: "x-api-key",
      agentEnvironment: {
        ANTHROPIC_API_KEY: PLACEHOLDER,
        NO_BROWSER: "1",
      },
      networkPolicy: {
        allow: {
          "api.anthropic.com": [{
            match: {
              method: ["POST"],
              path: { startsWith: "/v1/" },
              headers: [{
                key: { exact: "x-api-key" },
                value: { exact: PLACEHOLDER },
              }],
            },
            transform: [{ headers: { "x-api-key": credential } }],
          }],
        },
      },
    };
  }
  if (profileId === "codex") {
    return {
      profileId,
      host: "api.openai.com",
      credentialHeader: "authorization",
      agentEnvironment: {
        CODEX_API_KEY: PLACEHOLDER,
        NO_BROWSER: "1",
      },
      networkPolicy: {
        allow: {
          "api.openai.com": [{
            match: {
              method: ["POST"],
              path: { startsWith: "/v1/" },
              headers: [{
                key: { exact: "authorization" },
                value: { exact: `Bearer ${PLACEHOLDER}` },
              }],
            },
            transform: [{ headers: { authorization: `Bearer ${credential}` } }],
          }],
        },
      },
    };
  }
  const exhaustive: never = profileId;
  throw new Error(`Unsupported Builder ACP profile '${exhaustive}'.`);
}

export function modelCredentialBindingEvidence(binding: VercelModelCredentialBinding): Readonly<Record<string, unknown>> {
  return {
    profileId: binding.profileId,
    host: binding.host,
    credentialHeader: binding.credentialHeader,
    realCredentialInAgentEnvironment: false,
    placeholderRequired: true,
  };
}

function assertCredential(credential: string): void {
  if (credential.trim() === "") throw new Error("Builder model credential is required.");
  if (credential.includes("\r") || credential.includes("\n")) {
    throw new Error("Builder model credential contains an invalid header character.");
  }
}
