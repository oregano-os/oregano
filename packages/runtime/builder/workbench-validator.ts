import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BuilderJob } from "../../state-store/builder-jobs.ts";
import {
  checkedProposalFromInspection,
  inspectProposalWorkspace,
  sha256,
} from "../repository/proposal-inspection.ts";
import type { CheckedProposal } from "../repository/contracts.ts";
import type { TrustedGitExecutionAdapter } from "../repository/trusted-git-execution.ts";

const execFileAsync = promisify(execFile);

export interface BuilderProposalValidator {
  validate(args: BuilderProposalValidationRequest): Promise<CheckedProposal>;
}

export type BuilderProposalValidationRequest = {
  readonly job: BuilderJob;
  readonly workspacePath: string;
  readonly sourceBundlePath?: never;
  readonly diff?: never;
} | {
  readonly job: BuilderJob;
  readonly workspacePath?: never;
  readonly sourceBundlePath: string;
  readonly diff: string;
};

export class CompanyOSWorkbenchProposalValidator implements BuilderProposalValidator {
  readonly #cliPath: string;
  readonly #nodeExecutable: string;

  constructor(args: { cliPath: string; nodeExecutable?: string }) {
    this.#cliPath = args.cliPath;
    this.#nodeExecutable = args.nodeExecutable ?? process.execPath;
  }

  async validate(args: BuilderProposalValidationRequest): Promise<CheckedProposal> {
    if (!args.workspacePath) {
      throw new Error("Local Workbench proposal validation requires a materialized workspace.");
    }
    const inspection = await inspectProposalWorkspace(args.workspacePath, args.job.baseCommit);
    const checks = [];
    for (const command of [
      ["inspect", args.workspacePath, "--plan", "auto", "--base", args.job.baseCommit, "--format", "json"],
      ["validate", args.workspacePath, "--format", "json"],
      ["security", args.workspacePath, "--format", "json"],
    ]) {
      const result = await execFileAsync(this.#nodeExecutable, [this.#cliPath, ...command], {
        cwd: args.workspacePath,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: {
          NODE_ENV: process.env.NODE_ENV ?? "production",
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          LANG: "C",
          COMPANY_DIR: args.workspacePath,
        },
      });
      checks.push({
        id: `workbench.${command[0]}`,
        status: "passed" as const,
        evidenceDigest: sha256(result.stdout),
      });
    }
    return checkedProposalFromInspection(inspection, checks);
  }
}

export class TrustedGitProposalValidator implements BuilderProposalValidator {
  readonly #gitExecution: TrustedGitExecutionAdapter;

  constructor(gitExecution: TrustedGitExecutionAdapter) {
    this.#gitExecution = gitExecution;
  }

  async validate(args: BuilderProposalValidationRequest): Promise<CheckedProposal> {
    if (!args.sourceBundlePath || !args.diff) {
      throw new Error("Trusted Git proposal validation requires a source bundle and diff.");
    }
    return await this.#gitExecution.validate({
      operationId: `${args.job.jobId}:validate`,
      sourceBundlePath: args.sourceBundlePath,
      baseCommit: args.job.baseCommit,
      diff: args.diff,
    });
  }
}
