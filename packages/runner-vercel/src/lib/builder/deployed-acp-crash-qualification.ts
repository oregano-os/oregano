import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { sha256 } from "../../../../runtime/canonical.ts";
import { resolveBuilderAcpProfile } from "../../../../runtime/builder/profiles.ts";
import type {
  BuilderExecutionHandle,
  BuilderExecutionStatus,
} from "../../../../runtime/builder/execution.ts";
import {
  VercelSandboxBuilderExecutionAdapter,
  type VercelSandboxAcpCrashEvidence,
  type VercelSandboxBuilderConfiguration,
} from "./sandbox-execution-adapter.ts";

const SOURCE_WORKSPACE = "/vercel/sandbox/qualification-source";
const SOURCE_BUNDLE = "/vercel/sandbox/qualification-source.bundle";

export interface DeployedAcpCrashRecoveryEvidence {
  readonly profile: {
    readonly id: "claude-code";
    readonly implementation: string;
    readonly version: string;
  };
  readonly execution: {
    readonly adapter: "vercel-sandbox";
    readonly recoveredByReplacementCoordinator: true;
    readonly recoveredState: "failed";
    readonly checkedDiffProduced: false;
    readonly sandboxDisposed: true;
  };
  readonly crash: VercelSandboxAcpCrashEvidence;
  readonly progress: Readonly<Record<string, unknown>>;
  readonly source: {
    readonly exactBase: true;
    readonly credentialFreeBundle: true;
  };
}

export async function qualifyDeployedAcpCrashRecovery(): Promise<DeployedAcpCrashRecoveryEvidence> {
  const profile = resolveBuilderAcpProfile("claude-code");
  const configuration: VercelSandboxBuilderConfiguration = {
    workerSnapshotId: process.env.COMPANYOS_BUILDER_WORKER_SNAPSHOT_ID,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  };
  if (!configuration.workerSnapshotId || !configuration.anthropicApiKey) {
    throw new Error("Deployed ACP crash qualification failed during 'configure'.");
  }
  const source = await createCredentialFreeSourceBundle(configuration.workerSnapshotId);
  const temporary = await mkdtemp(join(tmpdir(), "companyos-builder-crash-"));
  const bundlePath = join(temporary, "repository.bundle");
  await writeFile(bundlePath, source.bundle, { mode: 0o600 });
  const jobId = `qualification:acp-crash:${randomUUID()}`;
  const requestId = `qualification:acp-crash:${randomUUID()}`;
  const originating = new VercelSandboxBuilderExecutionAdapter(configuration);
  let replacement: VercelSandboxBuilderExecutionAdapter | undefined;
  let handle: BuilderExecutionHandle | undefined;
  let disposed = false;
  try {
    handle = await originating.start({
      schemaVersion: 1,
      jobId,
      source: {
        repository: "qualification/credential-free-fixture",
        baseCommit: source.baseCommit,
        sourceBundlePath: bundlePath,
        contentDigest: source.contentDigest,
      },
      operation: {
        requestId,
        prompt: [
          "This is a bounded CompanyOS ACP crash-recovery qualification.",
          "Read fixture.txt and carefully prepare a proposal that would replace its contents with 'changed'.",
          "Do not access any parent directory, provider, secret, or remote repository.",
        ].join("\n"),
      },
      codingAgent: {
        profileId: profile.id,
        implementation: profile.packageName,
        version: profile.version,
      },
      limits: { timeoutMs: 120_000 },
      networkPolicyId: "builder-model-only",
    });
    const crash = await originating.qualificationInjectAcpCrash(handle);

    replacement = new VercelSandboxBuilderExecutionAdapter(configuration);
    const status = await waitForTerminalFailure(replacement, handle);
    if (status.state !== "failed") {
      throw new Error(`Replacement coordinator recovered unexpected Builder state '${status.state}'.`);
    }
    const result = await replacement.collect(handle);
    if (result.state !== "failed" || result.artifacts !== undefined) {
      throw new Error("ACP crash recovery did not fail closed before producing a checked diff.");
    }
    const progress = requiredRecord(result.evidence.workerProgress, "worker progress");
    if (
      progress.jobId !== jobId
      || progress.requestId !== requestId
      || progress.profileId !== profile.id
      || progress.phase !== "prompt_started"
      || progress.processIdObserved !== true
    ) {
      throw new Error("ACP crash recovery did not retain exact job-bound prompt evidence.");
    }
    await replacement.dispose(handle);
    disposed = true;
    const sandbox = await Sandbox.get({ name: handle.executionId });
    if (sandbox.status !== "stopped") {
      throw new Error("ACP crash recovery did not dispose the isolated Builder Sandbox.");
    }
    return {
      profile: {
        id: "claude-code",
        implementation: profile.packageName,
        version: profile.version,
      },
      execution: {
        adapter: "vercel-sandbox",
        recoveredByReplacementCoordinator: true,
        recoveredState: "failed",
        checkedDiffProduced: false,
        sandboxDisposed: true,
      },
      crash,
      progress,
      source: {
        exactBase: true,
        credentialFreeBundle: true,
      },
    };
  } finally {
    if (handle && !disposed) await (replacement ?? originating).dispose(handle).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}

async function createCredentialFreeSourceBundle(snapshotId: string): Promise<{
  bundle: Buffer;
  baseCommit: string;
  contentDigest: string;
}> {
  const sandbox = await Sandbox.create({
    name: `companyos-builder-crash-source-${randomUUID()}`,
    source: { type: "snapshot", snapshotId },
    timeout: 90_000,
    resources: { vcpus: 1 },
    ports: [],
    networkPolicy: "deny-all",
    persistent: false,
    tags: { component: "builder", qualification: "acp-crash-source" },
  });
  try {
    await sandbox.fs.mkdir(SOURCE_WORKSPACE, { recursive: true });
    await sandbox.fs.writeFile(`${SOURCE_WORKSPACE}/fixture.txt`, "base\n", "utf8");
    await requireGit(sandbox, ["init", "-q"]);
    await requireGit(sandbox, ["add", "fixture.txt"]);
    await requireGit(sandbox, [
      "-c", "user.name=CompanyOS Qualification",
      "-c", "user.email=qualification@companyos.invalid",
      "commit", "-qm", "qualification base",
    ]);
    const baseCommit = (await requireGit(sandbox, ["rev-parse", "HEAD"])).trim();
    const tree = await requireGit(sandbox, ["ls-tree", "-r", "--full-tree", baseCommit]);
    await requireGit(sandbox, ["bundle", "create", SOURCE_BUNDLE, "HEAD"]);
    const bundle = await sandbox.fs.readFile(SOURCE_BUNDLE);
    if (!/^[0-9a-f]{40}$/.test(baseCommit) || bundle.byteLength === 0) {
      throw new Error("ACP crash qualification did not create an exact source fixture.");
    }
    return { bundle, baseCommit, contentDigest: sha256(tree) };
  } finally {
    await sandbox.stop().catch(() => undefined);
  }
}

async function requireGit(sandbox: Sandbox, args: string[]): Promise<string> {
  const command = await sandbox.runCommand({
    cmd: "git",
    args,
    cwd: SOURCE_WORKSPACE,
    timeoutMs: 30_000,
  });
  if (command.exitCode !== 0) {
    throw new Error(`ACP crash source preparation failed: ${(await command.stderr()).slice(-2_000)}`);
  }
  return await command.stdout();
}

async function waitForTerminalFailure(
  adapter: VercelSandboxBuilderExecutionAdapter,
  handle: BuilderExecutionHandle,
): Promise<BuilderExecutionStatus> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const status = await adapter.status(handle);
    if (status.state !== "starting" && status.state !== "running") return status;
    if (Date.now() >= deadline) throw new Error("Replacement coordinator did not observe the ACP crash in time.");
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

function requiredRecord(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`ACP crash qualification ${field} is unavailable.`);
  }
  return value as Readonly<Record<string, unknown>>;
}
