import { isAbsolute } from "node:path";
import type { CheckedProposal } from "./contracts.ts";

export interface TrustedGitCredentialBinding {
  readonly host: string;
  readonly placeholderAuthorization: string;
  readonly realAuthorization: string;
}

export interface TrustedGitMaterializationRequest {
  readonly operationId: string;
  readonly remoteUrl: string;
  readonly baseCommit: string;
  readonly destinationBundlePath: string;
  readonly credential: TrustedGitCredentialBinding;
}

export interface TrustedGitMaterializationResult {
  readonly contentDigest: string;
  readonly evidence: Readonly<Record<string, unknown>>;
}

export interface TrustedGitValidationRequest {
  readonly operationId: string;
  readonly sourceBundlePath: string;
  readonly baseCommit: string;
  readonly diff: string;
}

export interface TrustedGitPublicationRequest extends TrustedGitValidationRequest {
  readonly remoteUrl: string;
  readonly branchName: string;
  readonly title: string;
  readonly checked: CheckedProposal;
  readonly credential: TrustedGitCredentialBinding;
}

/**
 * Private Company Instance boundary for trusted repository-only Git execution.
 * It must never run the coding agent or expose repository credentials to it.
 */
export interface TrustedGitExecutionAdapter {
  readonly id: string;
  readonly version: string;
  materialize(request: TrustedGitMaterializationRequest): Promise<TrustedGitMaterializationResult>;
  validate(request: TrustedGitValidationRequest): Promise<CheckedProposal>;
  publish(request: TrustedGitPublicationRequest): Promise<{
    readonly proposalCommit: string;
    readonly evidence: Readonly<Record<string, unknown>>;
  }>;
}

export function assertTrustedGitCredentialBinding(binding: TrustedGitCredentialBinding): void {
  if (!/^[a-z0-9.-]+$/i.test(binding.host) || binding.host.includes("..")) {
    throw new Error("Trusted Git credential host is invalid.");
  }
  if (!binding.placeholderAuthorization.startsWith("Basic ")) {
    throw new Error("Trusted Git placeholder authorization must use HTTP Basic.");
  }
  if (!binding.realAuthorization.startsWith("Basic ")) {
    throw new Error("Trusted Git real authorization must use HTTP Basic.");
  }
  if (binding.placeholderAuthorization === binding.realAuthorization) {
    throw new Error("Trusted Git placeholder and real authorization must differ.");
  }
}

export function assertTrustedGitBundlePath(path: string, label: string): void {
  if (!isAbsolute(path) || !path.endsWith(".bundle")) {
    throw new Error(`${label} must be an absolute Git bundle path.`);
  }
}
