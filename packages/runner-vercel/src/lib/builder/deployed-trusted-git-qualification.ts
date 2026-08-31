import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../../../runtime/repository/proposal-inspection.ts";
import { createPostgresRepositoryInstallationStore } from "../../../../state-postgres/repository-installation-store.ts";
import { getGitHubRepositoryProvider, getTrustedGitExecution } from "./provider-factory.ts";
import { handleGitHubRepositoryOnboarding } from "./repository-onboarding.ts";

const PLAN_PATH = ".companyos/changes/2026-08-26-builder-trusted-git-qualification.yaml";
const EVIDENCE_PATH = "handbook/builder-trusted-git-qualification.md";

export async function qualifyDeployedTrustedGit(): Promise<Readonly<Record<string, unknown>>> {
  const configuration = qualificationConfiguration();
  const provider = getGitHubRepositoryProvider();
  const gitExecution = getTrustedGitExecution();
  const temporary = await mkdtemp(join(tmpdir(), "companyos-trusted-git-qualification-"));
  let phase = "verify_installation";
  try {
    const onboardingSecret = process.env.COMPANYOS_REPOSITORY_ONBOARDING_SECRET;
    if (!onboardingSecret) throw new Error("repository onboarding secret is unavailable");
    const onboardingResponse = await handleGitHubRepositoryOnboarding(new Request(
      "https://companyos.invalid/api/repository/github/installations",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${onboardingSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          binding_id: configuration.bindingId,
          instance_id: configuration.instanceId,
          installation_id: configuration.installationId,
          repository_id: configuration.repositoryId,
          provider_repository_id: configuration.providerRepositoryId,
          onboarding_principal: configuration.onboardingPrincipal,
        }),
      },
    ));
    if (!onboardingResponse.ok) {
      throw new Error(`repository onboarding callback returned ${onboardingResponse.status}`);
    }
    const onboardingEvidence = await onboardingResponse.json() as {
      binding?: { status?: string };
    };
    const persistedBinding = await createPostgresRepositoryInstallationStore().get(configuration.bindingId);
    if (
      !persistedBinding
      || persistedBinding.status !== "active"
      || persistedBinding.instanceId !== configuration.instanceId
      || persistedBinding.repositoryId !== configuration.repositoryId
      || persistedBinding.installationId !== configuration.installationId
      || persistedBinding.providerRepositoryId !== configuration.providerRepositoryId
    ) {
      throw new Error("qualification repository binding was not durably persisted");
    }
    phase = "materialize_source";
    const source = await provider.materialize({
      schemaVersion: 1,
      requestId: "trusted-git-stage-0",
      instanceId: configuration.instanceId,
      bindingId: configuration.bindingId,
      repositoryId: configuration.repositoryId,
      baseCommit: configuration.baseCommit,
      destinationPath: join(temporary, "source"),
    });
    if (source.transfer?.format !== "git-bundle") {
      throw new Error("qualification source was not transferred as a Git bundle");
    }
    const diff = qualificationDiff();
    phase = "validate_diff";
    const checked = await gitExecution.validate({
      operationId: "trusted-git-stage-0:validate",
      sourceBundlePath: source.transfer.path,
      baseCommit: configuration.baseCommit,
      diff,
    });
    if (checked.validatedDiffDigest !== sha256(diff)) {
      throw new Error("qualification validation observed a different diff");
    }
    phase = "publish_draft";
    const proposal = await provider.publish({
      schemaVersion: 1,
      jobId: "trusted-git-stage-0",
      requestId: "trusted-git-stage-0",
      instanceId: configuration.instanceId,
      bindingId: configuration.bindingId,
      repositoryId: configuration.repositoryId,
      baseCommit: configuration.baseCommit,
      sourceBundlePath: source.transfer.path,
      diff,
      branchName: configuration.branchName,
      targetBranchName: configuration.targetBranchName,
      title: "CompanyOS Builder: qualify isolated trusted Git execution",
      body: [
        "This draft proposal is bounded Stage-0 qualification evidence.",
        "It must remain unmerged and carries no merge or deployment authority.",
      ].join("\n\n"),
      checked,
    });
    return {
      repositoryProvider: { id: provider.id, version: provider.version },
      trustedGitExecution: { id: gitExecution.id, version: gitExecution.version },
      installationPersisted: onboardingEvidence.binding?.status === "active" && persistedBinding.status === "active",
      exactBaseVerified: source.baseCommit === configuration.baseCommit,
      transferFormat: source.transfer.format,
      repositoryCredentialInCodingWorkspace: source.credentialIsolation.repositoryCredentialPresent,
      retainedRemotes: source.credentialIsolation.retainedRemotes,
      validatedDiffDigest: checked.validatedDiffDigest,
      changedPaths: checked.changedPaths,
      workbenchChecks: checked.checks.map((check) => check.id),
      proposal: {
        draftRequired: true,
        branchName: proposal.branchName,
        targetBranchName: configuration.targetBranchName,
        proposalCommit: proposal.proposalCommit,
        proposalUrl: proposal.proposalUrl,
      },
    };
  } catch (error) {
    console.error(`[builder-trusted-git-qualification:${phase}] ${safeDiagnostic(error)}`);
    throw new Error(`Deployed trusted Git qualification failed during '${phase}'.`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function safeDiagnostic(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/((?:authorization|http\.extraheader)(?:=|:)\s*)(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/\bgh[a-z]_[A-Za-z0-9_]+\b/g, "[redacted-github-token]")
    .replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----/g, "[redacted-private-key]")
    .slice(0, 2_000);
}

function qualificationConfiguration() {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value || value.length > 512) throw new Error(`Missing bounded qualification setting '${name}'.`);
    return value;
  };
  const configuration = {
    instanceId: required("COMPANYOS_BUILDER_QUALIFICATION_INSTANCE_ID"),
    bindingId: required("COMPANYOS_BUILDER_QUALIFICATION_BINDING_ID"),
    installationId: required("COMPANYOS_BUILDER_QUALIFICATION_INSTALLATION_ID"),
    repositoryId: required("COMPANYOS_BUILDER_QUALIFICATION_REPOSITORY_ID"),
    providerRepositoryId: required("COMPANYOS_BUILDER_QUALIFICATION_PROVIDER_REPOSITORY_ID"),
    baseCommit: required("COMPANYOS_BUILDER_QUALIFICATION_BASE_COMMIT"),
    onboardingPrincipal: required("COMPANYOS_BUILDER_QUALIFICATION_ONBOARDING_PRINCIPAL"),
    branchName: required("COMPANYOS_BUILDER_QUALIFICATION_BRANCH"),
    targetBranchName: required("COMPANYOS_BUILDER_QUALIFICATION_TARGET_BRANCH"),
  };
  if (!/^\d+$/.test(configuration.installationId) || !/^\d+$/.test(configuration.providerRepositoryId)) {
    throw new Error("Qualification provider identifiers must be decimal.");
  }
  if (!/^[0-9a-f]{40}$/.test(configuration.baseCommit)) {
    throw new Error("Qualification base commit must be exact.");
  }
  if (!/^companyos\/builder\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(configuration.branchName)) {
    throw new Error("Qualification branch is invalid.");
  }
  return configuration;
}

/** @internal Exported only for deterministic fixture verification. */
export function qualificationDiff(): string {
  const plan = `version: 1
plan_id: builder-trusted-git-qualification-2026-08-26
status: approved
author: companyos-builder
created: 2026-08-26
title: Record isolated trusted Git qualification
objective: Record a bounded document proving the proposal-only trusted Git path.
non_goals:
  - Merge or deploy the qualification proposal.
  - Grant repository credentials to a coding agent.
placement: workspace
change_class: documentation
vision_principles_affected:
  - Human authority is explicit
  - Evidence beats claims
files_expected:
  - ${PLAN_PATH}
  - ${EVIDENCE_PATH}
required_approvals:
  - workspace-steward
approvals:
  - role: workspace-steward
    approver: supervised-operator
    approved_at: 2026-08-26
    evidence: explicit-supervised-builder-qualification
validation:
  - companyos validate .
  - companyos inspect . --plan ${PLAN_PATH}
  - companyos security .
  - git diff --check
tests:
  - The draft is produced through a separate trusted Git execution boundary.
  - The coding environment receives no repository credential.
documentation_impact:
  required: true
  affected_documents:
    - handbook.builder-trusted-git-qualification
rollback: Close the unmerged draft proposal and delete its qualification branch.
open_decisions: []
`;
  const evidence = `---
type: evidence
description: Bounded evidence for isolated trusted Git proposal execution.
---
# Builder trusted Git qualification

This unmerged document proves only that source preparation, independent
Workbench validation, and proposal publication can run outside the coding
agent environment. It grants no merge or deployment authority.
`;
  return newFilePatch(PLAN_PATH, plan) + newFilePatch(EVIDENCE_PATH, evidence);
}

function newFilePatch(path: string, content: string): string {
  if (!content.endsWith("\n")) throw new Error("Qualification fixture content must end with a newline.");
  const lines = content.slice(0, -1).split("\n");
  const blob = Buffer.concat([
    Buffer.from(`blob ${Buffer.byteLength(content)}\0`),
    Buffer.from(content),
  ]);
  const blobId = createHash("sha1").update(blob).digest("hex").slice(0, 7);
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    `index 0000000..${blobId}`,
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}
