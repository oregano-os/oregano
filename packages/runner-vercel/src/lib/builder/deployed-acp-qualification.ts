import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sha256 } from "../../../../runtime/canonical.ts";
import {
  type BuilderExecutionHandle,
  type BuilderExecutionState,
} from "../../../../runtime/builder/execution.ts";
import {
  resolveBuilderAcpProfile,
  type BuilderAcpProfileId,
} from "../../../../runtime/builder/profiles.ts";
import {
  applyGitPatch,
  runGit,
} from "../../../../runtime/repository/git.ts";
import { inspectProposalWorkspace } from "../../../../runtime/repository/proposal-inspection.ts";
import { VercelSandboxBuilderExecutionAdapter } from "./sandbox-execution-adapter.ts";

const TERMINAL_STATES = new Set<BuilderExecutionState>([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

export interface DeployedAcpQualificationEvidence {
  readonly profile: {
    readonly id: BuilderAcpProfileId;
    readonly implementation: string;
    readonly version: string;
  };
  readonly execution: {
    readonly adapter: string;
    readonly adapterVersion: string;
    readonly state: "succeeded";
  };
  readonly credentialBroker: unknown;
  readonly worker: unknown;
  readonly hostVerifiedResult: true;
  readonly exactBaseVerified: true;
  readonly realCredentialSentToCodingProcess: false;
}

export async function qualifyDeployedAcp(
  profileId: BuilderAcpProfileId,
): Promise<DeployedAcpQualificationEvidence> {
  const profile = resolveBuilderAcpProfile(profileId);
  const adapter = new VercelSandboxBuilderExecutionAdapter();
  const root = await mkdtemp(join(tmpdir(), "companyos-deployed-acp-qualification-"));
  const workspacePath = join(root, "workspace");
  let handle: BuilderExecutionHandle | undefined;
  let phase = "prepare_fixture";
  try {
    await mkdir(workspacePath);
    await runGit(workspacePath, ["init", "-q"]);
    await writeFile(join(workspacePath, "fixture.txt"), "base\n");
    await runGit(workspacePath, ["add", "fixture.txt"]);
    await runGit(workspacePath, [
      "-c", "user.name=CompanyOS Qualification",
      "-c", "user.email=qualification@companyos.invalid",
      "commit", "-qm", "qualification base",
    ]);
    const baseCommit = (await runGit(workspacePath, ["rev-parse", "HEAD"])).trim();
    const tree = await runGit(workspacePath, ["ls-tree", "-r", "--full-tree", baseCommit]);
    const runId = randomUUID();
    phase = "start_sandbox";
    handle = await adapter.start({
      schemaVersion: 1,
      jobId: `qualification:${profile.id}:${runId}`,
      source: {
        repository: "companyos/deployed-acp-qualification",
        baseCommit,
        workspacePath,
        contentDigest: sha256(tree),
      },
      operation: {
        requestId: `qualification:${runId}`,
        prompt: [
          "This is a bounded CompanyOS brokered-authentication qualification fixture.",
          "Change only fixture.txt by replacing its complete content with exactly:",
          `changed-by-${profile.id}-in-sandbox`,
          "Do not inspect parent directories, install software, or change any other file.",
        ].join("\n"),
      },
      codingAgent: {
        profileId: profile.id,
        implementation: profile.packageName,
        version: profile.version,
      },
      limits: { timeoutMs: 180_000 },
      networkPolicyId: `brokered-${profile.id}`,
    });

    phase = "wait_for_worker";
    let state: BuilderExecutionState = "starting";
    const deadline = Date.now() + 210_000;
    while (!TERMINAL_STATES.has(state)) {
      if (Date.now() >= deadline) throw new Error("qualification polling deadline exceeded");
      await delay(2_000);
      state = (await adapter.status(handle)).state;
    }

    phase = "collect_result";
    const result = await adapter.collect(handle);
    if (result.state !== "succeeded" || !result.artifacts?.diff) {
      throw new Error("qualification worker did not return a successful diff");
    }
    phase = "verify_result";
    await applyGitPatch(workspacePath, result.artifacts.diff);
    const inspection = await inspectProposalWorkspace(workspacePath, baseCommit);
    const content = await readFile(join(workspacePath, "fixture.txt"), "utf8");
    if (
      content !== `changed-by-${profile.id}-in-sandbox\n`
      || inspection.changedPaths.length !== 1
      || inspection.changedPaths[0] !== "fixture.txt"
      || inspection.diffDigest !== result.artifacts.diffDigest
    ) {
      throw new Error("qualification result differs from the bounded expected change");
    }
    return {
      profile: {
        id: profile.id,
        implementation: profile.packageName,
        version: profile.version,
      },
      execution: {
        adapter: String(result.evidence.adapter),
        adapterVersion: String(result.evidence.adapterVersion),
        state: "succeeded",
      },
      credentialBroker: result.evidence.credentialBroker,
      worker: result.evidence.worker,
      hostVerifiedResult: true,
      exactBaseVerified: true,
      realCredentialSentToCodingProcess: false,
    };
  } catch {
    throw new Error(`Deployed ACP qualification failed during '${phase}'.`);
  } finally {
    if (handle) await adapter.dispose(handle).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

export function isStagedProductionQualificationRequest(
  request: Request,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const deploymentHost = environment.VERCEL_URL?.toLowerCase();
  if (environment.VERCEL_ENV !== "production" || !deploymentHost) return false;
  const requestUrl = new URL(request.url);
  const headerHost = request.headers.get("host")?.toLowerCase();
  return requestUrl.host.toLowerCase() === deploymentHost && headerHost === deploymentHost;
}
