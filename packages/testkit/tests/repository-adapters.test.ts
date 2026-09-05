import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CompanyOSWorkbenchProposalValidator } from "../../runtime/builder/workbench-validator.ts";
import type { BuilderJob } from "../../state-store/builder-jobs.ts";
import {
  LocalGitProposalPublisher,
  LocalGitRepositorySourceAdapter,
} from "../../connectors/local-git-repository.ts";
import {
  checkedProposalFromInspection,
  inspectProposalWorkspace,
  sha256,
} from "../../runtime/repository/proposal-inspection.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture(): { root: string; repository: string; baseCommit: string } {
  const root = mkdtempSync(join(tmpdir(), "companyos-repository-adapter-"));
  const repository = join(root, "origin");
  execFileSync("git", ["init", "-q", repository]);
  writeFileSync(join(repository, "company.md"), "base\n");
  git(repository, ["add", "company.md"]);
  git(repository, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base"]);
  return { root, repository, baseCommit: git(repository, ["rev-parse", "HEAD"]) };
}

test("LocalGitRepositorySourceAdapter materializes one exact credential-free checkout idempotently", async () => {
  const source = fixture();
  try {
    const workspace = join(source.root, "workspace");
    const adapter = new LocalGitRepositorySourceAdapter([{
      id: "workspace-source",
      repositoryId: "fixture/workspace",
      repositoryPath: source.repository,
    }]);
    const request = {
      schemaVersion: 1 as const,
      requestId: "request-1",
      instanceId: "fixture",
      bindingId: "workspace-source",
      repositoryId: "fixture/workspace",
      baseCommit: source.baseCommit,
      destinationPath: workspace,
    };
    const first = await adapter.materialize(request);
    const second = await adapter.materialize(request);
    assert.deepEqual(second, first);
    assert.equal(git(workspace, ["rev-parse", "HEAD"]), source.baseCommit);
    assert.equal(git(workspace, ["remote"]), "");
    assert.equal(first.credentialIsolation.repositoryCredentialPresent, false);
    assert.equal(first.credentialIsolation.retainedRemotes, 0);
    assert.equal(JSON.stringify(first).includes(source.repository), false);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test("proposal inspection blocks provider and repository-control paths", async () => {
  const source = fixture();
  try {
    const workspace = join(source.root, "workspace");
    const adapter = new LocalGitRepositorySourceAdapter([{
      id: "workspace-source",
      repositoryId: "fixture/workspace",
      repositoryPath: source.repository,
    }]);
    await adapter.materialize({
      schemaVersion: 1,
      requestId: "request-2",
      instanceId: "fixture",
      bindingId: "workspace-source",
      repositoryId: "fixture/workspace",
      baseCommit: source.baseCommit,
      destinationPath: workspace,
    });
    writeFileSync(join(workspace, ".env"), "SECRET=must-not-publish\n");
    await assert.rejects(() => inspectProposalWorkspace(workspace, source.baseCommit), /forbidden path/);
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});

test("LocalGitProposalPublisher creates one canonical outer commit only after checked evidence", async () => {
  const source = fixture();
  try {
    const workspace = join(source.root, "workspace");
    const binding = {
      id: "workspace-repository",
      repositoryId: "fixture/workspace",
      repositoryPath: source.repository,
    };
    await new LocalGitRepositorySourceAdapter([binding]).materialize({
      schemaVersion: 1,
      requestId: "request-3",
      instanceId: "fixture",
      bindingId: binding.id,
      repositoryId: binding.repositoryId,
      baseCommit: source.baseCommit,
      destinationPath: workspace,
    });
    writeFileSync(join(workspace, "company.md"), "checked change\n");
    const inspection = await inspectProposalWorkspace(workspace, source.baseCommit);
    const checked = checkedProposalFromInspection(inspection, [{
      id: "workbench.validate",
      status: "passed",
      evidenceDigest: sha256("passed"),
    }]);
    const publisher = new LocalGitProposalPublisher([binding]);
    const request = {
      schemaVersion: 1 as const,
      jobId: "job-3",
      requestId: "request-3",
      instanceId: "fixture",
      bindingId: binding.id,
      repositoryId: binding.repositoryId,
      baseCommit: source.baseCommit,
      workspacePath: workspace,
      branchName: "companyos/builder/job-3",
      title: "Builder proposal",
      body: "Checked by CompanyOS.",
      checked,
    };
    const first = await publisher.publish(request);
    const second = await publisher.publish(request);
    assert.equal(second.proposalCommit, first.proposalCommit);
    assert.equal(git(source.repository, ["show", `${first.proposalCommit}:company.md`]), "checked change");
    assert.equal(readFileSync(join(workspace, "company.md"), "utf8"), "checked change\n");
  } finally {
    rmSync(source.root, { recursive: true, force: true });
  }
});


for (const variant of ["untracked", "staged", "committed", "modified", "deleted", "renamed", "case-variant"] as const) {
  test(`real Workbench validator rejects ${variant} operational state changes`, async () => {
    const source = fixture();
    try {
      const directory = variant === "case-variant" ? "State" : "state";
      mkdirSync(join(source.repository, directory));
      writeFileSync(join(source.repository, directory, "audit-proof.json"), "{}\n");
      let baseCommit = source.baseCommit;
      if (["modified", "deleted", "renamed"].includes(variant)) {
        git(source.repository, ["add", directory]);
        git(source.repository, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "retained base state"]);
        baseCommit = git(source.repository, ["rev-parse", "HEAD"]);
        if (variant === "modified") writeFileSync(join(source.repository, directory, "audit-proof.json"), '{"changed":true}\n');
        if (variant === "deleted") git(source.repository, ["rm", `${directory}/audit-proof.json`]);
        if (variant === "renamed") git(source.repository, ["mv", `${directory}/audit-proof.json`, "evidence.json"]);
      }
      if (variant === "staged" || variant === "committed") git(source.repository, ["add", directory]);
      if (variant === "committed") {
        git(source.repository, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "worker commit"]);
        writeFileSync(join(source.repository, "company.md"), "allowed dirty change\n");
      }
      const validator = new CompanyOSWorkbenchProposalValidator({ cliPath: join(import.meta.dirname, "../../cli/src/cli.mjs") });
      await assert.rejects(() => validator.validate({ job: { baseCommit } as BuilderJob, workspacePath: source.repository }), /forbidden path '(?:state|State)\/audit-proof\.json'/);
    } finally { rmSync(source.root, { recursive: true, force: true }); }
  });
}

test("proposal inspection includes legitimate worker commits and ignores state-like sibling names", async () => {
  const source = fixture();
  try {
    writeFileSync(join(source.repository, "company.md"), "reviewed worker change\n");
    git(source.repository, ["add", "company.md"]);
    git(source.repository, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "worker change"]);
    const committed = await inspectProposalWorkspace(source.repository, source.baseCommit);
    assert.deepEqual(committed.changedPaths, ["company.md"]);
    writeFileSync(join(source.repository, "state-guide.md"), "Operating state is managed by Core.\n");
    const mixed = await inspectProposalWorkspace(source.repository, source.baseCommit);
    assert.deepEqual(mixed.changedPaths, ["company.md", "state-guide.md"]);
    assert.match(mixed.diff, /reviewed worker change/);
    assert.match(mixed.diff, /Operating state is managed/);
  } finally { rmSync(source.root, { recursive: true, force: true }); }
});
