import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { inspectProposalWorkspace, sha256 } from "../../../../runtime/repository/proposal-inspection.ts";
import { qualificationDiff } from "./deployed-trusted-git-qualification.ts";

const execFileAsync = promisify(execFile);

test("trusted Git qualification fixture matches the independently observed proposal", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "companyos-trusted-git-fixture-"));
  const repository = join(fixture, "repository");
  try {
    await mkdir(repository);
    await git(repository, ["init", "--initial-branch=main"]);
    await git(repository, ["config", "user.name", "CompanyOS Test"]);
    await git(repository, ["config", "user.email", "companyos-test@example.invalid"]);
    await writeFile(join(repository, "README.md"), "# Qualification fixture\n", "utf8");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "Create fixture"]);
    const baseCommit = (await git(repository, ["rev-parse", "HEAD"])).trim();
    const diff = qualificationDiff();
    const patchPath = join(fixture, "qualification.diff");
    await writeFile(patchPath, diff, "utf8");

    await git(repository, ["apply", "--whitespace=nowarn", patchPath]);
    const inspection = await inspectProposalWorkspace(repository, baseCommit);

    assert.equal(inspection.diff, diff);
    assert.equal(inspection.diffDigest, sha256(diff));
    assert.deepEqual(inspection.changedPaths, [
      ".companyos/changes/2026-08-26-builder-trusted-git-qualification.yaml",
      "handbook/builder-trusted-git-qualification.md",
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return result.stdout;
}
