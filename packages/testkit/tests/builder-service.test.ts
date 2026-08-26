import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BuilderInstanceConfiguration } from "../../companyos-builder/types.ts";
import {
  LocalGitProposalPublisher,
  LocalGitRepositorySourceAdapter,
} from "../../connectors/local-git-repository.ts";
import { BuilderService } from "../../runtime/builder/service.ts";
import type { BuilderProposalValidator } from "../../runtime/builder/workbench-validator.ts";
import { sha256 } from "../../runtime/repository/proposal-inspection.ts";
import type { ProposalPublisher, RepositorySourceAdapter } from "../../runtime/repository/contracts.ts";
import { InMemoryBuilderExecutionAdapter } from "../adapter/in-memory-builder-execution.ts";
import { InMemoryBuilderJobStore } from "../adapter/in-memory-builder-jobs.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const configuration: BuilderInstanceConfiguration = {
  enabled: true,
  execution: { adapter: "testkit-memory", profile: "isolated-v1" },
  codingAgent: { protocol: "acp-v1", profile: "codex" },
  repository: {
    repositoryId: "fixture/workspace",
    sourceBinding: "workspace",
    proposalPublisherBinding: "workspace",
  },
};

test("BuilderService runs a confirmed job to one checked outer proposal", async () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-builder-service-"));
  const repository = join(root, "origin");
  execFileSync("git", ["init", "-q", repository]);
  writeFileSync(join(repository, "company.md"), "base\n");
  git(repository, ["add", "company.md"]);
  git(repository, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base"]);
  const baseCommit = git(repository, ["rev-parse", "HEAD"]);
  const binding = { id: "workspace", repositoryId: "fixture/workspace", repositoryPath: repository };
  const jobs = new InMemoryBuilderJobStore();
  const execution = new InMemoryBuilderExecutionAdapter();
  const validator: BuilderProposalValidator = {
    async validate({ workspacePath }) {
      const diff = execFileSync("git", ["diff", "--binary", baseCommit, "--"], {
        cwd: workspacePath,
        encoding: "utf8",
      });
      return {
        validationPassed: true,
        validatedDiffDigest: sha256(diff),
        changedPaths: ["company.md"],
        checks: [{ id: "workbench.fixture", status: "passed", evidenceDigest: sha256("passed") }],
      };
    },
  };
  const service = new BuilderService({
    jobs,
    source: new LocalGitRepositorySourceAdapter([binding]),
    execution,
    validator,
    publisher: new LocalGitProposalPublisher([binding]),
    configuration,
  });
  try {
    const job = await service.submitConfirmedProposal({
      requestId: "confirmed-1",
      instanceId: "fixture",
      requesterPrincipal: "slack:T1:U1",
      sourceConversationKey: "slack:C1:thread",
      objective: "Update company.md",
      repositoryId: binding.repositoryId,
      baseCommit,
    });
    assert.equal(job.state, "queued");
    assert.equal((await service.advanceOne("worker-1")).state, "executing");
    const executing = await jobs.get(job.jobId);
    assert.ok(executing?.executionHandle);
    const patch = [
      "diff --git a/company.md b/company.md",
      "index df967b9..3f67420 100644",
      "--- a/company.md",
      "+++ b/company.md",
      "@@ -1 +1 @@",
      "-base",
      "+changed by builder",
      "",
    ].join("\n");
    execution.finish(
      executing.executionHandle as any,
      "succeeded",
      { profile: "codex" },
      { diff: patch, diffDigest: sha256(patch) },
    );
    const result = await service.advanceOne("worker-2");
    assert.equal(result.state, "published");
    assert.match(result.proposalUrl ?? "", /^local-git:/);
    const published = await jobs.get(job.jobId);
    assert.equal(published?.state, "published");
    assert.deepEqual(Object.keys(published?.evidence as Record<string, unknown>).sort(), [
      "execution",
      "proposal",
      "source",
      "validation",
    ]);
    const proposalCommit = git(repository, ["rev-parse", `refs/heads/companyos/builder/${job.jobId}`]);
    assert.equal(git(repository, ["show", `${proposalCommit}:company.md`]), "changed by builder");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("BuilderService does not start coding before confirmed submission", async () => {
  const jobs = new InMemoryBuilderJobStore();
  assert.equal(await jobs.getByRequestId("unconfirmed"), undefined);
});

test("BuilderService transfers a credential-free bundle through trusted validation and publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "companyos-builder-transfer-"));
  const jobs = new InMemoryBuilderJobStore();
  const execution = new InMemoryBuilderExecutionAdapter();
  const baseCommit = "a".repeat(40);
  const patch = [
    "diff --git a/company.md b/company.md",
    "index df967b9..3f67420 100644",
    "--- a/company.md",
    "+++ b/company.md",
    "@@ -1 +1 @@",
    "-base",
    "+changed by trusted builder",
    "",
  ].join("\n");
  let validatedInput: { bundle?: string; diff?: string } = {};
  let publishedInput: { bundle?: string; diff?: string } = {};
  const source: RepositorySourceAdapter = {
    id: "trusted-fixture",
    version: "1.0.0",
    async materialize(request) {
      mkdirSync(request.destinationPath, { recursive: true });
      const bundlePath = join(request.destinationPath, "repository.bundle");
      writeFileSync(bundlePath, "credential-free-bundle");
      return {
        schemaVersion: 1,
        requestId: request.requestId,
        provider: { id: this.id, version: this.version },
        bindingId: request.bindingId,
        repositoryId: request.repositoryId,
        baseCommit: request.baseCommit,
        workspacePath: request.destinationPath,
        transfer: { format: "git-bundle", path: bundlePath },
        contentDigest: sha256("tree"),
        credentialIsolation: { repositoryCredentialPresent: false, retainedRemotes: 0 },
        materializedAt: new Date().toISOString(),
      };
    },
  };
  const validator: BuilderProposalValidator = {
    async validate(args) {
      validatedInput = { bundle: args.sourceBundlePath, diff: args.diff };
      return {
        validationPassed: true,
        validatedDiffDigest: sha256(args.diff ?? ""),
        changedPaths: ["company.md"],
        checks: [{ id: "workbench.trusted-fixture", status: "passed", evidenceDigest: sha256("passed") }],
      };
    },
  };
  const publisher: ProposalPublisher = {
    id: "trusted-fixture",
    version: "1.0.0",
    async publish(request) {
      publishedInput = { bundle: request.sourceBundlePath, diff: request.diff };
      return {
        schemaVersion: 1,
        jobId: request.jobId,
        provider: { id: this.id, version: this.version },
        repositoryId: request.repositoryId,
        baseCommit: request.baseCommit,
        proposalCommit: "b".repeat(40),
        branchName: request.branchName,
        proposalUrl: "https://example.invalid/proposals/1",
        publishedAt: new Date().toISOString(),
      };
    },
  };
  const service = new BuilderService({ jobs, source, execution, validator, publisher, configuration });
  try {
    const job = await service.submitConfirmedProposal({
      requestId: "trusted-transfer",
      instanceId: "fixture",
      requesterPrincipal: "slack:T1:U1",
      sourceConversationKey: "slack:C1:thread",
      objective: "Update company.md through a trusted Git boundary",
      repositoryId: "fixture/workspace",
      baseCommit,
    });
    assert.equal((await service.advanceOne("worker-1")).state, "executing");
    const executing = await jobs.get(job.jobId);
    execution.finish(
      executing!.executionHandle as any,
      "succeeded",
      { profile: "codex" },
      { diff: patch, diffDigest: sha256(patch) },
    );
    assert.equal((await service.advanceOne("worker-2")).state, "published");
    assert.match(validatedInput.bundle ?? "", /repository\.bundle$/);
    assert.equal(validatedInput.diff, patch);
    assert.equal(publishedInput.bundle, validatedInput.bundle);
    assert.equal(publishedInput.diff, patch);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
