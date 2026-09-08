import type { BuilderProposalValidator, BuilderProposalValidationRequest } from "./workbench-validator.ts";
import type { CheckedProposal } from "../repository/contracts.ts";
import type { TrustedGitExecutionAdapter } from "../repository/trusted-git-execution.ts";

/** Hosted orchestration imports no local Workbench or checkout metadata. */
export class TrustedGitProposalValidator implements BuilderProposalValidator {
  readonly #gitExecution: TrustedGitExecutionAdapter;

  constructor(gitExecution: TrustedGitExecutionAdapter) {
    this.#gitExecution = gitExecution;
  }

  async validate(args: BuilderProposalValidationRequest): Promise<CheckedProposal> {
    if (!args.sourceBundlePath || !args.diff) {
      throw new Error("Trusted Git proposal validation requires a source bundle and diff.");
    }
    return this.#gitExecution.validate({
      operationId: `${args.job.jobId}:validate`,
      sourceBundlePath: args.sourceBundlePath,
      baseCommit: args.job.baseCommit,
      diff: args.diff,
    });
  }
}
