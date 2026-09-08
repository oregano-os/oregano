import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "../../../../runtime/repository/proposal-inspection.ts";
import { createPostgresRepositoryInstallationStore } from "../../../../state-postgres/repository-installation-store.ts";
import { getGitHubRepositoryProvider, getTrustedGitExecution } from "./provider-factory.ts";
import { handleGitHubRepositoryOnboarding } from "./repository-onboarding.ts";

const PLAN_PATH = ".companyos/changes/2026-09-08-builder-trusted-git-qualification.yaml";
const EVIDENCE_PATH = "agents/builder/skills/trusted-git-qualification.md";
const TEST_PATH = ".companyos/tests/builder-trusted-git-qualification.test.mjs";

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
  const plan = `version: 3
plan_id: builder-trusted-git-qualification-2026-09-08
created: 2026-09-08
title: Record isolated trusted Git qualification
objective: Record bounded evidence for the proposal-only trusted Git path.
non_goals:
  - Merge or deploy the qualification proposal.
  - Grant repository credentials to a coding agent.
placement: workspace
change_class: security
files_expected:
  - ${PLAN_PATH}
  - ${EVIDENCE_PATH}
  - ${TEST_PATH}
tests:
  - ${TEST_PATH}
documentation_impact:
  required: true
  affected_documents:
    - ${EVIDENCE_PATH}
architecture:
  placement:
    core: Reuse the existing trusted source, validation and publication adapters.
    packages: Use the pinned Workbench without changing package contracts.
    workspace: Add only an unmerged diagnostic note and its Change Plan.
    instance: Use the previously verified repository installation and isolated execution binding.
  mechanisms_extended: []
  new_core_mechanisms: []
  boundary_assertions:
    company_values_in_core: false
    secrets_in_git: false
    public_fixtures: not-applicable
  core_reusability: No company-specific runtime logic or new Core mechanism.
rollback: Close the unmerged draft and delete only its qualification branch.
open_decisions: []
`;
  const evidence = `---
type: note
description: Bounded evidence for isolated trusted Git proposal execution.
---
# Builder trusted Git qualification

This unmerged document proves only that source preparation, independent
Workbench validation, and proposal publication can run outside the coding
agent environment. It grants no merge or deployment authority.
`;
  const test = `import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("trusted Git qualification has no operating or authority changes", () => {
  const allowed = new Set(${JSON.stringify([PLAN_PATH, TEST_PATH, EVIDENCE_PATH])});
  const paths = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" })
    .trimEnd().split("\\n").filter(Boolean).map((line) => line.slice(3));
  assert.ok(paths.every((path) => allowed.has(path)), "qualification must not change operating files");
});
`;
  return newFilePatch(PLAN_PATH, plan) + newFilePatch(TEST_PATH, test) + newFilePatch(EVIDENCE_PATH, evidence);
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
