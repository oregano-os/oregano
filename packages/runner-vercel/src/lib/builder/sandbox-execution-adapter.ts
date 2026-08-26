import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Sandbox } from "@vercel/sandbox";
import { sha256 } from "../../../../runtime/canonical.ts";
import { resolveBuilderAcpProfile } from "../../../../runtime/builder/profiles.ts";
import {
  assertBuilderExecutionHandle,
  assertBuilderExecutionRequest,
  type BuilderExecutionAdapter,
  type BuilderExecutionHandle,
  type BuilderExecutionRequest,
  type BuilderExecutionResult,
  type BuilderExecutionState,
  type BuilderExecutionStatus,
} from "../../../../runtime/builder/execution.ts";
import {
  createVercelModelCredentialBinding,
  modelCredentialBindingEvidence,
} from "./model-credential-broker.ts";

const ADAPTER_ID = "vercel-sandbox";
const ADAPTER_VERSION = "3.1.0";
const QUALIFICATION_IMAGE = "vercel/sandbox/node@sha256:07bbba46c01fc02c9cd7e2e1962fda825ff733c099212ade7f893966df949b78";
const WORKER_REQUEST_PATH = "/vercel/sandbox/builder-request.json";
const WORKER_COMMAND_PATH = "/vercel/sandbox/builder-command.json";
const WORKSPACE_PATH = "/vercel/sandbox/workspace";
const MAX_DIFF_BYTES = 5 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export interface VercelSandboxBuilderConfiguration {
  readonly workerSnapshotId?: string;
  readonly anthropicApiKey?: string;
  readonly openAiApiKey?: string;
}

interface VercelSandboxRecord {
  readonly requestHash: string;
  readonly timeoutMs: number;
  readonly handle: BuilderExecutionHandle;
  sandbox: Sandbox;
  readonly startedAt: string;
  request?: BuilderExecutionRequest;
  commandId?: string;
  brokerEvidence?: Readonly<Record<string, unknown>>;
  state: BuilderExecutionState;
  finishedAt?: string;
  disposed: boolean;
}

export interface VercelSandboxQualificationEvidence {
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly image: string | undefined;
  readonly persistent: boolean;
  readonly exposedPorts: number;
  readonly networkPolicy: "deny-all";
  readonly nodeVersion: string;
  readonly filesystemRoundTrip: boolean;
  readonly externalNetworkDenied: boolean;
  readonly credentialTransformApplied: boolean;
}

export interface VercelSandboxRecoveryEvidence {
  readonly recoveredByName: boolean;
  readonly markerPreserved: boolean;
  readonly state: BuilderExecutionState;
}

export class VercelSandboxBuilderExecutionAdapter implements BuilderExecutionAdapter {
  readonly id = ADAPTER_ID;
  readonly version = ADAPTER_VERSION;
  readonly #executions = new Map<string, VercelSandboxRecord>();
  readonly #jobs = new Map<string, string>();
  readonly #configuration: VercelSandboxBuilderConfiguration;

  constructor(configuration: VercelSandboxBuilderConfiguration = {
    workerSnapshotId: process.env.COMPANYOS_BUILDER_WORKER_SNAPSHOT_ID,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openAiApiKey: process.env.OPENAI_API_KEY,
  }) {
    this.#configuration = configuration;
  }

  async start(request: BuilderExecutionRequest): Promise<BuilderExecutionHandle> {
    assertBuilderExecutionRequest(request);
    const requestHash = sha256(request);
    const existingId = this.#jobs.get(request.jobId);
    if (existingId) {
      const existing = this.#required(existingId);
      if (existing.requestHash !== requestHash) {
        throw new Error("Builder job id was reused with a different execution request.");
      }
      return existing.handle;
    }

    const jobHash = sha256(request.jobId).slice(0, 12);
    const sandboxName = `companyos-builder-${sha256(request.jobId).slice(0, 16)}`;
    const production = request.operation !== undefined;
    const workerSnapshotId = production ? this.#configuration.workerSnapshotId : undefined;
    if (production && !workerSnapshotId) {
      throw new Error("COMPANYOS_BUILDER_WORKER_SNAPSHOT_ID is required for production Builder execution.");
    }
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.getOrCreate({
        name: sandboxName,
        ...(workerSnapshotId
          ? { source: { type: "snapshot" as const, snapshotId: workerSnapshotId } }
          : { image: QUALIFICATION_IMAGE }),
        timeout: request.limits.timeoutMs,
        resources: { vcpus: 1 },
        ports: [],
        networkPolicy: "deny-all",
        persistent: false,
        tags: {
          component: "builder",
          job: jobHash,
          request: requestHash.slice(0, 16),
          timeout: String(request.limits.timeoutMs),
          mode: production ? "worker" : "qualification",
        },
      });
    } catch (createError) {
      try {
        // getOrCreate is not atomic when two coordinators race after the same
        // not-found response. Reconcile the named winner instead of creating a
        // second execution. Identity and request tags are verified below.
        sandbox = await Sandbox.get({ name: sandboxName });
      } catch {
        throw createError;
      }
    }
    if (sandbox.tags?.component !== "builder" || sandbox.tags.job !== jobHash) {
      throw new Error("Named Vercel Sandbox belongs to a different Builder job.");
    }
    if (sandbox.tags.request !== requestHash.slice(0, 16)) {
      throw new Error("Builder job id was reused with a different execution request.");
    }
    const executionId = sandbox.name;
    const handle: BuilderExecutionHandle = {
      jobId: request.jobId,
      executionId,
      adapter: { id: this.id, version: this.version },
    };
    const record: VercelSandboxRecord = {
      requestHash,
      timeoutMs: request.limits.timeoutMs,
      handle,
      sandbox,
      startedAt: sandbox.currentSession().startedAt?.toISOString() ?? sandbox.createdAt.toISOString(),
      request,
      state: stateFromSandbox(sandbox, request.limits.timeoutMs),
      disposed: false,
    };
    this.#executions.set(executionId, record);
    this.#jobs.set(request.jobId, executionId);
    if (request.operation) await this.#ensureWorkerLaunched(record);
    return handle;
  }

  async status(handle: BuilderExecutionHandle): Promise<BuilderExecutionStatus> {
    const record = await this.#fromHandle(handle);
    record.sandbox = await Sandbox.get({ name: record.sandbox.name });
    if (record.request?.operation || record.sandbox.tags?.mode === "worker") {
      await this.#loadRecoveredWorker(record);
      if (!record.commandId) {
        return {
          state: "starting",
          observedAt: new Date().toISOString(),
          detail: "Builder worker launch marker is not available yet.",
        };
      }
      const command = await record.sandbox.getCommand(record.commandId);
      record.state = command.exitCode === null ? "running" : command.exitCode === 0 ? "succeeded" : "failed";
      if (isTerminal(record.state)) record.finishedAt ??= new Date().toISOString();
      return { state: record.state, observedAt: new Date().toISOString() };
    }
    if (!isTerminal(record.state)) {
      record.state = stateFromSandbox(record.sandbox, record.timeoutMs);
      if (isTerminal(record.state)) record.finishedAt = finishedAt(record.sandbox);
    }
    return { state: record.state, observedAt: new Date().toISOString() };
  }

  async cancel(handle: BuilderExecutionHandle): Promise<void> {
    const record = await this.#fromHandle(handle, true);
    if (record.state !== "starting" && record.state !== "running") return;
    await this.#loadRecoveredWorker(record);
    if (record.commandId) {
      const command = await record.sandbox.getCommand(record.commandId);
      if (command.exitCode === null) await command.kill("SIGTERM").catch(() => undefined);
    }
    await record.sandbox.stop();
    record.state = "cancelled";
    record.finishedAt = new Date().toISOString();
  }

  async collect(handle: BuilderExecutionHandle): Promise<BuilderExecutionResult> {
    await this.status(handle);
    const record = await this.#fromHandle(handle, true);
    if (!record.finishedAt || !isTerminal(record.state)) {
      throw new Error("Builder execution result is unavailable before a terminal state.");
    }
    let artifacts: BuilderExecutionResult["artifacts"];
    let workerEvidence: unknown;
    let workerStderr = "";
    if (record.commandId && record.request?.operation) {
      const command = await record.sandbox.getCommand(record.commandId);
      workerStderr = (await command.stderr()).slice(-32_768);
      const stdout = await command.stdout();
      if (record.state === "succeeded") {
        workerEvidence = parseWorkerOutput(stdout);
        const addIntent = await record.sandbox.runCommand({
          cmd: "git",
          args: ["add", "-N", "--all"],
          cwd: WORKSPACE_PATH,
          timeoutMs: 30_000,
        });
        if (addIntent.exitCode !== 0) {
          throw new Error(`Builder result preparation failed: ${(await addIntent.stderr()).slice(-2_000)}`);
        }
        const diffCommand = await record.sandbox.runCommand({
          cmd: "git",
          args: ["diff", "--binary", "--no-ext-diff", record.request.source.baseCommit, "--"],
          cwd: WORKSPACE_PATH,
          timeoutMs: 30_000,
        });
        if (diffCommand.exitCode !== 0) {
          throw new Error(`Builder result diff failed: ${(await diffCommand.stderr()).slice(-2_000)}`);
        }
        const diff = await diffCommand.stdout();
        if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) {
          throw new Error(`Builder result diff exceeds the ${MAX_DIFF_BYTES}-byte limit.`);
        }
        artifacts = { diff, diffDigest: sha256(diff) };
      }
    }
    return {
      state: record.state,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      evidence: {
        adapter: this.id,
        adapterVersion: this.version,
        image: record.sandbox.image,
        region: record.sandbox.currentSession().region,
        vcpus: record.sandbox.vcpus,
        memoryMb: record.sandbox.memory,
        activeCpuUsageMs: record.sandbox.activeCpuUsageMs,
        ingressBytes: record.sandbox.networkTransfer?.ingress,
        egressBytes: record.sandbox.networkTransfer?.egress,
        worker: workerEvidence,
        workerStderr,
        credentialBroker: record.brokerEvidence,
        repositoryCredentialInWorker: false,
      },
      artifacts,
    };
  }

  async dispose(handle: BuilderExecutionHandle): Promise<void> {
    const record = await this.#fromHandle(handle, true);
    if (record.disposed) return;
    if (record.state === "starting" || record.state === "running") {
      await this.cancel(handle);
    } else if (record.sandbox.status !== "stopped") {
      await record.sandbox.stop().catch(() => undefined);
    }
    record.disposed = true;
  }

  async #ensureWorkerLaunched(record: VercelSandboxRecord): Promise<void> {
    const request = record.request;
    if (!request?.operation || !request.source.contentDigest) return;
    await this.#loadRecoveredWorker(record);
    if (record.commandId) return;
    const profile = resolveBuilderAcpProfile(request.codingAgent.profileId);
    if (
      profile.packageName !== request.codingAgent.implementation
      || profile.version !== request.codingAgent.version
    ) {
      throw new Error("Builder execution coding profile differs from the qualified exact profile.");
    }
    const credential = profile.id === "claude-code"
      ? this.#configuration.anthropicApiKey
      : this.#configuration.openAiApiKey;
    if (!credential) throw new Error(`Builder model credential for '${profile.id}' is unavailable.`);
    const broker = createVercelModelCredentialBinding(profile.id, credential);
    const temporary = await mkdtemp(join(tmpdir(), "companyos-builder-bundle-"));
    try {
      const bundlePath = join(temporary, "repository.bundle");
      const bundle = request.source.sourceBundlePath
        ? await readFile(request.source.sourceBundlePath)
        : await createLocalSourceBundle(request.source.workspacePath!, bundlePath);
      await record.sandbox.fs.mkdir("/vercel/sandbox/input", { recursive: true });
      await record.sandbox.writeFiles([
        { path: "/vercel/sandbox/input/repository.bundle", content: bundle, mode: 0o600 },
        {
          path: WORKER_REQUEST_PATH,
          content: JSON.stringify({
            schemaVersion: 1,
            jobId: request.jobId,
            requestId: request.operation.requestId,
            profileId: profile.id,
            workspacePath: WORKSPACE_PATH,
            prompt: request.operation.prompt,
            timeoutMs: request.limits.timeoutMs - 10_000,
            _executionRequest: request,
          }),
          mode: 0o600,
        },
      ]);
      const clone = await record.sandbox.runCommand({
        cmd: "git",
        args: ["clone", "--no-checkout", "/vercel/sandbox/input/repository.bundle", WORKSPACE_PATH],
        timeoutMs: 60_000,
      });
      if (clone.exitCode !== 0) {
        throw new Error(`Builder workspace transfer failed: ${(await clone.stderr()).slice(-2_000)}`);
      }
      const checkout = await record.sandbox.runCommand({
        cmd: "git",
        args: ["checkout", "--detach", "--force", request.source.baseCommit],
        cwd: WORKSPACE_PATH,
        timeoutMs: 30_000,
      });
      if (checkout.exitCode !== 0) {
        throw new Error(`Builder workspace checkout failed: ${(await checkout.stderr()).slice(-2_000)}`);
      }
      await record.sandbox.runCommand({
        cmd: "git",
        args: ["remote", "remove", "origin"],
        cwd: WORKSPACE_PATH,
        timeoutMs: 10_000,
      });
      const digest = await record.sandbox.runCommand({
        cmd: "git",
        args: ["ls-tree", "-r", "--full-tree", request.source.baseCommit],
        cwd: WORKSPACE_PATH,
        timeoutMs: 30_000,
      });
      if (digest.exitCode !== 0 || sha256(await digest.stdout()) !== request.source.contentDigest) {
        throw new Error("Builder workspace transfer content digest mismatch.");
      }
      await record.sandbox.updateNetworkPolicy(broker.networkPolicy);
      const command = await record.sandbox.runCommand({
        cmd: "node",
        args: [
          "--experimental-strip-types",
          "/vercel/sandbox/packages/builder-worker/src/entrypoint.ts",
          WORKER_REQUEST_PATH,
        ],
        cwd: "/vercel/sandbox",
        env: {
          ...broker.agentEnvironment,
          HOME: "/vercel/sandbox/home",
          LANG: "C.UTF-8",
          PATH: "/vercel/sandbox/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
          TMPDIR: "/tmp",
        },
        detached: true,
        timeoutMs: request.limits.timeoutMs - 5_000,
      });
      record.commandId = command.cmdId;
      record.brokerEvidence = modelCredentialBindingEvidence(broker);
      await record.sandbox.fs.writeFile(WORKER_COMMAND_PATH, JSON.stringify({
        jobId: request.jobId,
        requestHash: record.requestHash.slice(0, 16),
        commandId: command.cmdId,
        credentialBroker: record.brokerEvidence,
      }), "utf8");
      record.state = "running";
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  async #loadRecoveredWorker(record: VercelSandboxRecord): Promise<void> {
    if (record.commandId) return;
    try {
      const marker = JSON.parse(await record.sandbox.fs.readFile(WORKER_COMMAND_PATH, "utf8")) as {
        jobId?: string;
        requestHash?: string;
        commandId?: string;
        credentialBroker?: Readonly<Record<string, unknown>>;
      };
      if (
        marker.jobId !== record.handle.jobId
        || marker.requestHash !== record.requestHash.slice(0, 16)
        || !marker.commandId
      ) {
        throw new Error("Recovered Builder worker marker does not match the execution handle.");
      }
      record.commandId = marker.commandId;
      record.brokerEvidence = marker.credentialBroker;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async qualificationProbe(handle: BuilderExecutionHandle): Promise<VercelSandboxQualificationEvidence> {
    const record = await this.#fromHandle(handle);
    await record.sandbox.fs.writeFile("qualification.txt", "companyos-builder-sandbox\n", "utf8");
    const content = await record.sandbox.fs.readFile("qualification.txt", "utf8");
    const node = await record.sandbox.runCommand({ cmd: "node", args: ["--version"], timeoutMs: 10_000 });
    if (node.exitCode !== 0) throw new Error("Vercel Sandbox Node qualification command failed.");
    const network = await record.sandbox.runCommand({
      cmd: "node",
      args: [
        "-e",
        "fetch('https://example.com').then(() => process.exit(7)).catch(() => process.exit(0))",
      ],
      timeoutMs: 10_000,
    });
    if (network.exitCode !== 0) throw new Error("Vercel Sandbox deny-all network policy did not block external access.");
    let credentialTransformApplied = false;
    try {
      await record.sandbox.updateNetworkPolicy({
        allow: {
          "httpbin.org": [{
            transform: [{ headers: { authorization: "Bearer companyos-brokered-qualification" } }],
          }],
        },
      });
      const broker = await record.sandbox.runCommand({
        cmd: "node",
        args: [
          "-e",
          [
            "const response=await fetch('https://httpbin.org/bearer',{headers:{authorization:'Bearer sandbox-placeholder'}});",
            "const body=await response.json();",
            "process.exit(response.ok&&body.authenticated===true&&body.token==='companyos-brokered-qualification'?0:9);",
          ].join(""),
        ],
        timeoutMs: 10_000,
      });
      credentialTransformApplied = broker.exitCode === 0;
      if (!credentialTransformApplied) throw new Error("Vercel Sandbox credential-transform qualification failed.");
    } finally {
      await record.sandbox.updateNetworkPolicy("deny-all");
    }
    return {
      adapter: this.id,
      adapterVersion: this.version,
      image: record.sandbox.image,
      persistent: record.sandbox.persistent,
      exposedPorts: record.sandbox.routes.length,
      networkPolicy: "deny-all",
      nodeVersion: (await node.stdout()).trim(),
      filesystemRoundTrip: content === "companyos-builder-sandbox\n",
      externalNetworkDenied: true,
      credentialTransformApplied,
    };
  }

  async qualificationRecoveryProbe(handle: BuilderExecutionHandle): Promise<VercelSandboxRecoveryEvidence> {
    const record = await this.#fromHandle(handle);
    const marker = await record.sandbox.fs.readFile("qualification.txt", "utf8");
    return {
      recoveredByName: record.sandbox.name === handle.executionId,
      markerPreserved: marker === "companyos-builder-sandbox\n",
      state: record.state,
    };
  }

  async #fromHandle(handle: BuilderExecutionHandle, allowDisposed = false): Promise<VercelSandboxRecord> {
    assertBuilderExecutionHandle(this, handle);
    let record = this.#executions.get(handle.executionId);
    if (!record) {
      const sandbox = await Sandbox.get({ name: handle.executionId });
      const jobHash = sha256(handle.jobId).slice(0, 12);
      if (sandbox.tags?.component !== "builder" || sandbox.tags.job !== jobHash) {
        throw new Error("Recovered Vercel Sandbox does not belong to the Builder job.");
      }
      const timeoutMs = Number(sandbox.tags.timeout);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
        throw new Error("Recovered Vercel Sandbox has no valid Builder timeout evidence.");
      }
      const state = stateFromSandbox(sandbox, timeoutMs);
      record = {
        requestHash: sandbox.tags.request ?? "",
        timeoutMs,
        handle,
        sandbox,
        startedAt: sandbox.currentSession().startedAt?.toISOString() ?? sandbox.createdAt.toISOString(),
        state,
        finishedAt: isTerminal(state) ? finishedAt(sandbox) : undefined,
        disposed: false,
      };
      if (sandbox.tags?.mode === "worker") {
        try {
          const workerRequest = JSON.parse(await sandbox.fs.readFile(WORKER_REQUEST_PATH, "utf8")) as {
            jobId: string;
            _executionRequest?: BuilderExecutionRequest;
          };
          if (workerRequest.jobId !== handle.jobId || !workerRequest._executionRequest) {
            throw new Error("Recovered Builder request belongs to another job or lacks execution evidence.");
          }
          assertBuilderExecutionRequest(workerRequest._executionRequest);
          record.request = workerRequest._executionRequest;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      this.#executions.set(handle.executionId, record);
      this.#jobs.set(handle.jobId, handle.executionId);
    }
    if (record.handle.jobId !== handle.jobId) throw new Error("Builder execution handle job does not match.");
    if (record.disposed && !allowDisposed) throw new Error("Builder execution environment has been disposed.");
    return record;
  }

  #required(executionId: string): VercelSandboxRecord {
    const record = this.#executions.get(executionId);
    if (!record) throw new Error(`Unknown Vercel Builder execution '${executionId}'.`);
    return record;
  }
}

async function createLocalSourceBundle(workspacePath: string, bundlePath: string): Promise<Buffer> {
  await execFileAsync("git", ["bundle", "create", bundlePath, "--all"], {
    cwd: workspacePath,
    env: { ...process.env, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" },
  });
  return await readFile(bundlePath);
}

function isTerminal(state: BuilderExecutionState): state is BuilderExecutionResult["state"] {
  return state === "succeeded" || state === "failed" || state === "cancelled" || state === "timed_out";
}

function stateFromSandbox(sandbox: Sandbox, timeoutMs: number): BuilderExecutionState {
  if (sandbox.status === "pending") return "starting";
  if (sandbox.status === "running" || sandbox.status === "stopping" || sandbox.status === "snapshotting") return "running";
  if (sandbox.status === "failed" || sandbox.status === "aborted") return "failed";
  const session = sandbox.currentSession();
  if (session.requestedStopAt) return "cancelled";
  if (
    session.startedAt
    && session.stoppedAt
    && session.stoppedAt.getTime() - session.startedAt.getTime() >= timeoutMs - 1_000
  ) return "timed_out";
  return "failed";
}

function finishedAt(sandbox: Sandbox): string {
  const session = sandbox.currentSession();
  return (session.stoppedAt ?? session.abortedAt ?? sandbox.statusUpdatedAt ?? sandbox.updatedAt).toISOString();
}

function parseWorkerOutput(stdout: string): unknown {
  const lines = stdout.trim().split("\n").filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]!);
    } catch {
      continue;
    }
  }
  throw new Error("Builder worker did not emit a structured terminal result.");
}
