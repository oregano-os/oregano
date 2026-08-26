import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import type { CheckedProposal } from "../../../../runtime/repository/contracts.ts";
import { sha256, type ProposalInspection } from "../../../../runtime/repository/proposal-inspection.ts";
import {
  assertTrustedGitBundlePath,
  assertTrustedGitCredentialBinding,
  type TrustedGitExecutionAdapter,
  type TrustedGitMaterializationRequest,
  type TrustedGitPublicationRequest,
  type TrustedGitValidationRequest,
} from "../../../../runtime/repository/trusted-git-execution.ts";

const ADAPTER_ID = "vercel-sandbox-trusted-git";
const ADAPTER_VERSION = "1.0.0";
const CORE_ROOT = "/vercel/sandbox/core";
const WORKSPACE_PATH = "/vercel/sandbox/workspace";
const INPUT_ROOT = "/vercel/sandbox/input";
const SOURCE_BUNDLE_PATH = `${INPUT_ROOT}/repository.bundle`;
const DIFF_PATH = `${INPUT_ROOT}/proposal.diff`;
const REQUEST_PATH = `${INPUT_ROOT}/request.json`;
const WORKER_PATH = `${CORE_ROOT}/packages/runtime/builder/trusted-git-worker.ts`;
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const MAX_DIFF_BYTES = 5 * 1024 * 1024;

export interface VercelSandboxTrustedGitConfiguration {
  readonly snapshotId?: string;
}

export class VercelSandboxTrustedGitExecutionAdapter implements TrustedGitExecutionAdapter {
  readonly id = ADAPTER_ID;
  readonly version = ADAPTER_VERSION;
  readonly #snapshotId: string;

  constructor(configuration: VercelSandboxTrustedGitConfiguration = {
    snapshotId: process.env.COMPANYOS_BUILDER_TRUSTED_GIT_SNAPSHOT_ID,
  }) {
    if (!configuration.snapshotId?.startsWith("snap_")) {
      throw new Error("COMPANYOS_BUILDER_TRUSTED_GIT_SNAPSHOT_ID is required for trusted Git execution.");
    }
    this.#snapshotId = configuration.snapshotId;
  }

  async materialize(request: TrustedGitMaterializationRequest) {
    assertOperationId(request.operationId);
    assertRemote(request.remoteUrl, request.credential);
    assertCommit(request.baseCommit);
    assertTrustedGitBundlePath(request.destinationBundlePath, "Trusted Git destinationBundlePath");
    const sandbox = await this.#createSandbox(request.operationId, "source", credentialPolicy(request.credential));
    try {
      const clone = await sandbox.runCommand({
        cmd: "git",
        args: ["clone", "--no-checkout", "--", request.remoteUrl, WORKSPACE_PATH],
        env: gitEnvironment(request.credential),
        timeoutMs: 90_000,
      });
      await requireSuccess(clone, "Trusted Git source clone");
      const resolved = await runGit(sandbox, ["rev-parse", "--verify", `${request.baseCommit}^{commit}`]);
      if (resolved.trim() !== request.baseCommit) {
        throw new Error("Trusted Git source did not resolve the exact base commit.");
      }
      await requireSuccess(await sandbox.runCommand({
        cmd: "git",
        args: ["checkout", "--detach", "--force", request.baseCommit],
        cwd: WORKSPACE_PATH,
        env: gitEnvironment(request.credential),
        timeoutMs: 60_000,
      }), "Trusted Git exact-base checkout");
      await sandbox.updateNetworkPolicy("deny-all");
      await sanitizeWorkspace(sandbox);
      const tree = await runGit(sandbox, ["ls-tree", "-r", "--full-tree", request.baseCommit]);
      await requireSuccess(await sandbox.runCommand({
        cmd: "git",
        args: ["bundle", "create", SOURCE_BUNDLE_PATH, "HEAD"],
        cwd: WORKSPACE_PATH,
        timeoutMs: 60_000,
      }), "Trusted Git source bundle");
      const bundle = await sandbox.fs.readFile(SOURCE_BUNDLE_PATH);
      if (bundle.byteLength === 0 || bundle.byteLength > MAX_BUNDLE_BYTES) {
        throw new Error(`Trusted Git source bundle must be between 1 and ${MAX_BUNDLE_BYTES} bytes.`);
      }
      await mkdir(dirname(request.destinationBundlePath), { recursive: true });
      await writeFile(request.destinationBundlePath, bundle, { mode: 0o600 });
      return {
        contentDigest: sha256(tree),
        evidence: {
          adapter: this.id,
          adapterVersion: this.version,
          exactBase: true,
          credentialBrokered: true,
          credentialInGitEnvironment: false,
          retainedRemotes: 0,
          bundleBytes: bundle.byteLength,
        },
      };
    } finally {
      await sandbox.updateNetworkPolicy("deny-all").catch(() => undefined);
      await sandbox.stop().catch(() => undefined);
    }
  }

  async validate(request: TrustedGitValidationRequest): Promise<CheckedProposal> {
    validateTransferredRequest(request);
    const sandbox = await this.#createSandbox(request.operationId, "validate", "deny-all");
    try {
      await prepareTransferredWorkspace(sandbox, request);
      return await runTrustedWorker<CheckedProposal>(sandbox, "validate", request.baseCommit);
    } finally {
      await sandbox.stop().catch(() => undefined);
    }
  }

  async publish(request: TrustedGitPublicationRequest) {
    validateTransferredRequest(request);
    assertRemote(request.remoteUrl, request.credential);
    if (!/^companyos\/builder\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(request.branchName)) {
      throw new Error("Trusted Git publication branch is invalid.");
    }
    if (!request.title || request.title.length > 512) throw new Error("Trusted Git publication title is invalid.");
    const sandbox = await this.#createSandbox(request.operationId, "publish", "deny-all");
    try {
      await prepareTransferredWorkspace(sandbox, request);
      const inspection = await runTrustedWorker<ProposalInspection>(sandbox, "inspect", request.baseCommit);
      if (inspection.diffDigest !== request.checked.validatedDiffDigest) {
        throw new Error("Trusted Git publication diff changed after validation.");
      }
      if (JSON.stringify(inspection.changedPaths) !== JSON.stringify([...request.checked.changedPaths].sort())) {
        throw new Error("Trusted Git publication paths differ from checked evidence.");
      }
      await runGit(sandbox, ["add", "--all"]);
      await runGit(sandbox, [
        "-c", "user.name=CompanyOS Builder",
        "-c", "user.email=builder@companyos.invalid",
        "commit", "-m", request.title,
      ]);
      const proposalCommit = (await runGit(sandbox, ["rev-parse", "HEAD"])).trim();
      assertCommit(proposalCommit);
      await runGit(sandbox, ["remote", "add", "origin", request.remoteUrl]);
      await sandbox.updateNetworkPolicy(credentialPolicy(request.credential));
      await requireSuccess(await sandbox.runCommand({
        cmd: "git",
        args: ["push", "origin", `HEAD:refs/heads/${request.branchName}`],
        cwd: WORKSPACE_PATH,
        env: gitEnvironment(request.credential),
        timeoutMs: 90_000,
      }), "Trusted Git proposal push");
      await sandbox.updateNetworkPolicy("deny-all");
      return {
        proposalCommit,
        evidence: {
          adapter: this.id,
          adapterVersion: this.version,
          diffDigest: inspection.diffDigest,
          changedPaths: inspection.changedPaths,
          credentialBrokered: true,
          credentialInGitEnvironment: false,
        },
      };
    } finally {
      await sandbox.updateNetworkPolicy("deny-all").catch(() => undefined);
      await sandbox.stop().catch(() => undefined);
    }
  }

  async #createSandbox(
    operationId: string,
    phase: "source" | "validate" | "publish",
    networkPolicy: NetworkPolicy,
  ): Promise<Sandbox> {
    return await Sandbox.create({
      name: `companyos-trusted-git-${sha256(operationId).slice(0, 12)}-${randomUUID().slice(0, 8)}`,
      source: { type: "snapshot", snapshotId: this.#snapshotId },
      timeout: 240_000,
      resources: { vcpus: 1 },
      ports: [],
      networkPolicy,
      persistent: false,
      tags: {
        component: "builder-trusted-git",
        operation: sha256(operationId).slice(0, 16),
        phase,
      },
    });
  }
}

async function prepareTransferredWorkspace(
  sandbox: Sandbox,
  request: TrustedGitValidationRequest,
): Promise<void> {
  const bundle = await readFile(request.sourceBundlePath);
  if (bundle.byteLength === 0 || bundle.byteLength > MAX_BUNDLE_BYTES) {
    throw new Error(`Trusted Git input bundle must be between 1 and ${MAX_BUNDLE_BYTES} bytes.`);
  }
  if (Buffer.byteLength(request.diff) === 0 || Buffer.byteLength(request.diff) > MAX_DIFF_BYTES) {
    throw new Error(`Trusted Git proposal diff must be between 1 and ${MAX_DIFF_BYTES} bytes.`);
  }
  await sandbox.fs.mkdir(INPUT_ROOT, { recursive: true });
  await sandbox.writeFiles([
    { path: SOURCE_BUNDLE_PATH, content: bundle, mode: 0o600 },
    { path: DIFF_PATH, content: request.diff, mode: 0o600 },
  ]);
  await requireSuccess(await sandbox.runCommand({
    cmd: "git",
    args: ["clone", "--no-checkout", SOURCE_BUNDLE_PATH, WORKSPACE_PATH],
    timeoutMs: 60_000,
  }), "Trusted Git bundle clone");
  const resolved = await runGit(sandbox, ["rev-parse", "--verify", `${request.baseCommit}^{commit}`]);
  if (resolved.trim() !== request.baseCommit) throw new Error("Trusted Git bundle lacks the exact base commit.");
  await runGit(sandbox, ["checkout", "--detach", "--force", request.baseCommit]);
  await sanitizeWorkspace(sandbox);
  await requireSuccess(await sandbox.runCommand({
    cmd: "git",
    args: ["apply", "--binary", "--whitespace=nowarn", DIFF_PATH],
    cwd: WORKSPACE_PATH,
    timeoutMs: 60_000,
  }), "Trusted Git proposal patch application");
}

async function runTrustedWorker<T>(
  sandbox: Sandbox,
  mode: "inspect" | "validate",
  baseCommit: string,
): Promise<T> {
  await sandbox.fs.writeFile(REQUEST_PATH, JSON.stringify({ mode, workspacePath: WORKSPACE_PATH, baseCommit }), "utf8");
  const command = await sandbox.runCommand({
    cmd: "node",
    args: ["--experimental-strip-types", WORKER_PATH, REQUEST_PATH],
    cwd: CORE_ROOT,
    env: {
      HOME: "/vercel/sandbox/home",
      LANG: "C.UTF-8",
      NODE_ENV: "production",
      PATH: `${CORE_ROOT}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
      TMPDIR: "/tmp",
    },
    timeoutMs: 120_000,
  });
  await requireSuccess(command, `Trusted Git ${mode} worker`);
  return parseLastJson(await command.stdout()) as T;
}

async function sanitizeWorkspace(sandbox: Sandbox): Promise<void> {
  const remotes = (await runGit(sandbox, ["remote"])).trim().split("\n").filter(Boolean);
  for (const remote of remotes) await runGit(sandbox, ["remote", "remove", remote]);
  await sandbox.runCommand({
    cmd: "git",
    args: ["config", "--local", "--unset-all", "http.extraHeader"],
    cwd: WORKSPACE_PATH,
    timeoutMs: 10_000,
  });
  const retainedRemotes = (await runGit(sandbox, ["remote"])).trim();
  const config = await runGit(sandbox, ["config", "--local", "--list"]);
  if (retainedRemotes || /(credential|extraheader|authorization|token|password|github\.com)/i.test(config)) {
    throw new Error("Trusted Git workspace retained provider or credential configuration.");
  }
}

async function runGit(sandbox: Sandbox, args: string[]): Promise<string> {
  const command = await sandbox.runCommand({ cmd: "git", args, cwd: WORKSPACE_PATH, timeoutMs: 60_000 });
  await requireSuccess(command, `Trusted Git command '${args[0] ?? "unknown"}'`);
  return await command.stdout();
}

async function requireSuccess(
  command: Awaited<ReturnType<Sandbox["runCommand"]>>,
  label: string,
): Promise<void> {
  if (command.exitCode !== 0) {
    throw new Error(`${label} failed: ${(await command.stderr()).slice(-2_000)}`);
  }
}

function credentialPolicy(credential: TrustedGitPublicationRequest["credential"]): NetworkPolicy {
  assertTrustedGitCredentialBinding(credential);
  return {
    allow: {
      [credential.host]: [{
        transform: [{ headers: { authorization: credential.realAuthorization } }],
      }],
    },
  };
}

function gitEnvironment(credential: TrustedGitPublicationRequest["credential"]): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: ${credential.placeholderAuthorization}`,
    GIT_TERMINAL_PROMPT: "0",
    HOME: "/vercel/sandbox/home",
    LANG: "C",
    PATH: "/usr/local/bin:/usr/bin:/bin",
  };
}

function validateTransferredRequest(request: TrustedGitValidationRequest): void {
  assertOperationId(request.operationId);
  assertTrustedGitBundlePath(request.sourceBundlePath, "Trusted Git sourceBundlePath");
  assertCommit(request.baseCommit);
  if (!request.diff || Buffer.byteLength(request.diff) > MAX_DIFF_BYTES) {
    throw new Error("Trusted Git diff is empty or exceeds the transfer limit.");
  }
}

function assertRemote(remoteUrl: string, credential: TrustedGitPublicationRequest["credential"]): void {
  assertTrustedGitCredentialBinding(credential);
  const url = new URL(remoteUrl);
  if (url.protocol !== "https:" || url.hostname !== credential.host || url.username || url.password) {
    throw new Error("Trusted Git remote must be credential-free HTTPS on the brokered host.");
  }
}

function assertOperationId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,180}$/.test(value)) {
    throw new Error("Trusted Git operation id is invalid.");
  }
}

function assertCommit(value: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error("Trusted Git base commit must be exact.");
}

function parseLastJson(output: string): unknown {
  const lines = output.trim().split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]!);
    } catch {
      continue;
    }
  }
  throw new Error("Trusted Git worker emitted no structured result.");
}
