import { isAbsolute } from "node:path";

export interface RepositorySourceRequest {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly instanceId: string;
  readonly bindingId: string;
  readonly repositoryId: string;
  readonly baseCommit: string;
  readonly destinationPath: string;
}

export interface RepositorySourceReceipt {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly provider: {
    readonly id: string;
    readonly version: string;
  };
  readonly bindingId: string;
  readonly repositoryId: string;
  readonly baseCommit: string;
  readonly workspacePath: string;
  readonly transfer?: {
    readonly format: "git-bundle";
    readonly path: string;
  };
  readonly contentDigest: string;
  readonly credentialIsolation: {
    readonly repositoryCredentialPresent: false;
    readonly retainedRemotes: 0;
  };
  readonly materializedAt: string;
}

export interface RepositorySourceAdapter {
  readonly id: string;
  readonly version: string;
  materialize(request: RepositorySourceRequest): Promise<RepositorySourceReceipt>;
}

export interface CheckedProposal {
  readonly validationPassed: true;
  readonly validatedDiffDigest: string;
  readonly changedPaths: readonly string[];
  readonly checks: readonly {
    readonly id: string;
    readonly status: "passed";
    readonly evidenceDigest: string;
  }[];
}

export interface ProposalPublicationRequest {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly requestId: string;
  readonly instanceId: string;
  readonly bindingId: string;
  readonly repositoryId: string;
  readonly baseCommit: string;
  readonly workspacePath?: string;
  readonly sourceBundlePath?: string;
  readonly diff?: string;
  readonly branchName: string;
  readonly targetBranchName?: string;
  readonly title: string;
  readonly body: string;
  readonly checked: CheckedProposal;
}

export interface ProposalPublicationReceipt {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly provider: {
    readonly id: string;
    readonly version: string;
  };
  readonly repositoryId: string;
  readonly baseCommit: string;
  readonly proposalCommit: string;
  readonly branchName: string;
  readonly proposalUrl: string;
  readonly publishedAt: string;
}

export interface ProposalPublisher {
  readonly id: string;
  readonly version: string;
  publish(request: ProposalPublicationRequest): Promise<ProposalPublicationReceipt>;
}

export function assertRepositorySourceRequest(request: RepositorySourceRequest): void {
  if (request.schemaVersion !== 1) throw new Error("Repository source request schemaVersion must be 1.");
  for (const [label, value] of [
    ["requestId", request.requestId],
    ["instanceId", request.instanceId],
    ["bindingId", request.bindingId],
    ["repositoryId", request.repositoryId],
  ] as const) {
    if (!value || value.length > 256) throw new Error(`Repository source ${label} is invalid.`);
  }
  assertGitCommit(request.baseCommit, "Repository source baseCommit");
  if (!isAbsolute(request.destinationPath)) {
    throw new Error("Repository source destinationPath must be absolute.");
  }
}

export function assertProposalPublicationRequest(request: ProposalPublicationRequest): void {
  if (request.schemaVersion !== 1) throw new Error("Proposal publication request schemaVersion must be 1.");
  for (const [label, value] of [
    ["jobId", request.jobId],
    ["requestId", request.requestId],
    ["instanceId", request.instanceId],
    ["bindingId", request.bindingId],
    ["repositoryId", request.repositoryId],
    ["title", request.title],
  ] as const) {
    if (!value || value.length > 512) throw new Error(`Proposal publication ${label} is invalid.`);
  }
  assertGitCommit(request.baseCommit, "Proposal publication baseCommit");
  const localWorkspace = request.workspacePath !== undefined;
  const transferredWorkspace = request.sourceBundlePath !== undefined || request.diff !== undefined;
  if (localWorkspace === transferredWorkspace) {
    throw new Error("Proposal publication requires exactly one local workspace or transferred Git bundle input.");
  }
  if (localWorkspace && !isAbsolute(request.workspacePath!)) {
    throw new Error("Proposal publication workspacePath must be absolute.");
  }
  if (transferredWorkspace) {
    if (!request.sourceBundlePath || !isAbsolute(request.sourceBundlePath) || !request.sourceBundlePath.endsWith(".bundle")) {
      throw new Error("Proposal publication sourceBundlePath must be an absolute Git bundle path.");
    }
    if (!request.diff || request.diff.trim() === "") {
      throw new Error("Proposal publication transferred diff must be non-empty.");
    }
  }
  if (!/^companyos\/builder\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(request.branchName)) {
    throw new Error("Proposal branch must use the bounded 'companyos/builder/' namespace.");
  }
  if (request.targetBranchName !== undefined && !isSafeBranchName(request.targetBranchName)) {
    throw new Error("Proposal targetBranchName is invalid.");
  }
  if (request.checked.validationPassed !== true || request.checked.checks.length === 0) {
    throw new Error("Proposal publication requires passed validation evidence.");
  }
  assertSha256(request.checked.validatedDiffDigest, "validatedDiffDigest");
  if (request.checked.changedPaths.length === 0) throw new Error("Proposal publication requires a non-empty checked diff.");
  if (new Set(request.checked.changedPaths).size !== request.checked.changedPaths.length) {
    throw new Error("Proposal publication changedPaths must be unique.");
  }
  for (const check of request.checked.checks) {
    if (check.status !== "passed" || !check.id) throw new Error("Proposal publication contains a non-passing check.");
    assertSha256(check.evidenceDigest, `check '${check.id}' evidenceDigest`);
  }
}

function isSafeBranchName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,180}$/.test(value)
    && !value.includes("..")
    && !value.includes("//")
    && !value.endsWith("/")
    && !value.split("/").some((segment) => segment.startsWith(".") || segment.endsWith(".lock"));
}

export function assertGitCommit(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${label} must be an exact lowercase 40-character Git commit.`);
  }
}

export function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest.`);
}
