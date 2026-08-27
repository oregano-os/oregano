import { Sandbox } from "@vercel/sandbox";
import { sha256 } from "../../../../runtime/canonical.ts";
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

const ADAPTER_ID = "vercel-sandbox";
const ADAPTER_VERSION = "3.1.0";
const QUALIFICATION_IMAGE = "vercel/sandbox/node@sha256:07bbba46c01fc02c9cd7e2e1962fda825ff733c099212ade7f893966df949b78";

interface VercelSandboxRecord {
  readonly requestHash: string;
  readonly timeoutMs: number;
  readonly handle: BuilderExecutionHandle;
  sandbox: Sandbox;
  readonly startedAt: string;
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
    let sandbox: Sandbox;
    try {
      sandbox = await Sandbox.getOrCreate({
        name: sandboxName,
        image: QUALIFICATION_IMAGE,
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
    this.#executions.set(executionId, {
      requestHash,
      timeoutMs: request.limits.timeoutMs,
      handle,
      sandbox,
      startedAt: sandbox.currentSession().startedAt?.toISOString() ?? sandbox.createdAt.toISOString(),
      state: stateFromSandbox(sandbox, request.limits.timeoutMs),
      disposed: false,
    });
    this.#jobs.set(request.jobId, executionId);
    return handle;
  }

  async status(handle: BuilderExecutionHandle): Promise<BuilderExecutionStatus> {
    const record = await this.#fromHandle(handle);
    record.sandbox = await Sandbox.get({ name: record.sandbox.name });
    if (!isTerminal(record.state)) {
      record.state = stateFromSandbox(record.sandbox, record.timeoutMs);
      if (isTerminal(record.state)) record.finishedAt = finishedAt(record.sandbox);
    }
    return { state: record.state, observedAt: new Date().toISOString() };
  }

  async cancel(handle: BuilderExecutionHandle): Promise<void> {
    const record = await this.#fromHandle(handle, true);
    if (record.state !== "starting" && record.state !== "running") return;
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
      },
    };
  }

  async dispose(handle: BuilderExecutionHandle): Promise<void> {
    const record = await this.#fromHandle(handle, true);
    if (record.disposed) return;
    if (record.state === "starting" || record.state === "running") await this.cancel(handle);
    record.disposed = true;
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
