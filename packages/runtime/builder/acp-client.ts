import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { assertBuilderAcpProfilePin, type BuilderAcpProfile } from "./profiles.ts";

const MAX_STDERR_BYTES = 32_768;
const PROCESS_STOP_GRACE_MS = 1_500;

export interface BuilderAcpLaunch {
  readonly profile: BuilderAcpProfile;
  readonly executable: string;
  readonly args?: readonly string[];
}

export interface BuilderAcpRunRequest {
  readonly launch: BuilderAcpLaunch;
  readonly cwd: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  /** Explicit allowlist; the parent environment is never inherited implicitly. */
  readonly environment: Readonly<Record<string, string>>;
  /** Omit to deny every permission request. The returned id must name an offered one-shot option. */
  readonly permissionPolicy?: (request: acp.RequestPermissionRequest) => Promise<string | undefined> | string | undefined;
  readonly signal?: AbortSignal;
}

export interface BuilderAcpRunEvidence {
  readonly protocolVersion: number;
  readonly profile: {
    readonly id: string;
    readonly packageName: string;
    readonly version: string;
    readonly sessionMode?: string;
  };
  readonly agent: {
    readonly name: string;
    readonly version?: string;
  };
  readonly sessionId: string;
  readonly stopReason: string;
  readonly updateKinds: readonly string[];
  readonly permissionRequests: number;
  readonly approvedPermissions: number;
  readonly deniedPermissions: number;
  readonly permissionEvidence: readonly {
    readonly toolKind: string;
    readonly locationScope: "inside-workspace" | "outside-workspace" | "none";
    readonly optionKinds: readonly string[];
  }[];
  readonly stderr: string;
}

export class BuilderAcpTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Builder ACP run exceeded its ${timeoutMs}ms timeout.`);
    this.name = "BuilderAcpTimeoutError";
  }
}

export async function probeBuilderAcpLaunch(
  launch: BuilderAcpLaunch,
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  assertBuilderAcpProfilePin(launch.profile);
  const child = spawn(launch.executable, [...(launch.args ?? []), "--version"], {
    env: { ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output = appendBounded(output, chunk); });
  child.stderr.on("data", (chunk: string) => { output = appendBounded(output, chunk); });
  const exit = await waitForExit(child, 5_000);
  if (exit.code !== 0) throw new Error(`Builder ACP profile probe failed with exit ${exit.code ?? "signal"}.`);
  const normalized = output.trim();
  if (!normalized.includes(launch.profile.version)) {
    throw new Error(
      `Builder ACP profile '${launch.profile.id}' reported '${normalized || "no version"}', expected '${launch.profile.version}'.`,
    );
  }
  return normalized;
}

export async function runBuilderAcp(request: BuilderAcpRunRequest): Promise<BuilderAcpRunEvidence> {
  validateRunRequest(request);
  await probeBuilderAcpLaunch(request.launch, request.environment);

  const child = spawn(request.launch.executable, [...(request.launch.args ?? [])], {
    cwd: request.cwd,
    detached: process.platform !== "win32",
    env: { ...request.environment },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = appendBounded(stderr, chunk); });

  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  let cancelActiveSession: (() => Promise<void>) | undefined;
  let timedOut = false;
  let aborted = false;
  let rejectBoundary: ((error: Error) => void) | undefined;
  const boundary = new Promise<never>((_resolve, reject) => { rejectBoundary = reject; });
  const timeout = setTimeout(() => {
    timedOut = true;
    void cancelActiveSession?.().catch(() => undefined);
    rejectBoundary?.(new BuilderAcpTimeoutError(request.timeoutMs));
  }, request.timeoutMs);
  const onAbort = () => {
    aborted = true;
    void cancelActiveSession?.().catch(() => undefined);
    rejectBoundary?.(new Error("Builder ACP run was cancelled."));
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });
  if (request.signal?.aborted) onAbort();

  let permissionRequests = 0;
  let approvedPermissions = 0;
  let deniedPermissions = 0;
  const permissionEvidence: Array<BuilderAcpRunEvidence["permissionEvidence"][number]> = [];
  const updateKinds: string[] = [];
  const app = acp
    .client({ name: "companyos-builder" })
    .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
      permissionRequests += 1;
      const locations = params.toolCall.locations ?? [];
      permissionEvidence.push({
        toolKind: params.toolCall.kind ?? "unknown",
        locationScope: locations.length === 0
          ? "none"
          : locations.every((location) => isPathInsideBuilderWorkspace(request.cwd, location.path))
            ? "inside-workspace"
            : "outside-workspace",
        optionKinds: params.options.map((option) => option.kind),
      });
      const selectedId = await request.permissionPolicy?.(params);
      const selected = params.options.find((option) => option.optionId === selectedId);
      if (selected?.kind === "allow_once") {
        approvedPermissions += 1;
        return { outcome: { outcome: "selected" as const, optionId: selected.optionId } };
      }
      const rejection = params.options.find((option) => option.kind === "reject_always")
        ?? params.options.find((option) => option.kind === "reject_once");
      if (!rejection) return { outcome: { outcome: "cancelled" as const } };
      deniedPermissions += 1;
      return { outcome: { outcome: "selected" as const, optionId: rejection.optionId } };
    });

  const operation = app.connectWith(stream, async (context) => {
    const initialized = await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "companyos-builder", version: "0.1.0" },
    });
    if (initialized.protocolVersion !== acp.PROTOCOL_VERSION) {
      throw new Error(`ACP protocol mismatch: received ${initialized.protocolVersion}.`);
    }
    return context.buildSession({ cwd: request.cwd, mcpServers: [] }).withSession(async (session) => {
      if (request.launch.profile.sessionMode) {
        const available = session.modes?.availableModes ?? [];
        if (!available.some((mode) => mode.id === request.launch.profile.sessionMode)) {
          throw new Error(
            `Builder ACP profile '${request.launch.profile.id}' did not advertise required session mode '${request.launch.profile.sessionMode}'.`,
          );
        }
        await context.request(acp.methods.agent.session.setMode, {
          sessionId: session.sessionId,
          modeId: request.launch.profile.sessionMode,
        });
      }
      cancelActiveSession = () => context.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId });
      void session.prompt(request.prompt).catch(() => undefined);
      for (;;) {
        const message = await session.nextUpdate();
        if (message.kind === "stop") {
          return {
            protocolVersion: initialized.protocolVersion,
            profile: {
              id: request.launch.profile.id,
              packageName: request.launch.profile.packageName,
              version: request.launch.profile.version,
              sessionMode: request.launch.profile.sessionMode,
            },
            agent: {
              name: initialized.agentInfo?.name ?? "unknown",
              version: initialized.agentInfo?.version,
            },
            sessionId: session.sessionId,
            stopReason: message.stopReason,
            updateKinds,
            permissionRequests,
            approvedPermissions,
            deniedPermissions,
            permissionEvidence,
            stderr,
          } satisfies BuilderAcpRunEvidence;
        }
        updateKinds.push(message.update.sessionUpdate);
      }
    });
  });
  void operation.catch(() => undefined);

  try {
    return await Promise.race([operation, boundary]);
  } catch (error) {
    if (timedOut || aborted) throw error;
    const detail = stderr.trim();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(detail ? `${message}\nACP stderr: ${detail}` : message, { cause: error });
  } finally {
    clearTimeout(timeout);
    request.signal?.removeEventListener("abort", onAbort);
    await stopProcessTree(child);
  }
}

function validateRunRequest(request: BuilderAcpRunRequest): void {
  assertBuilderAcpProfilePin(request.launch.profile);
  if (!isAbsolute(request.cwd)) throw new Error("Builder ACP working directory must be absolute.");
  if (request.prompt.trim() === "") throw new Error("Builder ACP prompt cannot be empty.");
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1_000) {
    throw new Error("Builder ACP timeout must be a positive integer of at least 1000ms.");
  }
  if (Object.keys(request.environment).some((name) => name.trim() === "")) {
    throw new Error("Builder ACP environment contains an empty variable name.");
  }
}

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MAX_STDERR_BYTES ? combined : combined.slice(-MAX_STDERR_BYTES);
}

export function isPathInsideBuilderWorkspace(root: string, candidatePath: string): boolean {
  const canonicalRoot = realpathSync(root);
  const absoluteCandidate = isAbsolute(candidatePath) ? candidatePath : resolve(canonicalRoot, candidatePath);
  let canonicalCandidate: string;
  try {
    canonicalCandidate = realpathSync(absoluteCandidate);
  } catch {
    try {
      canonicalCandidate = join(realpathSync(dirname(absoluteCandidate)), basename(absoluteCandidate));
    } catch {
      return false;
    }
  }
  const candidate = relative(canonicalRoot, canonicalCandidate);
  return candidate !== "" && candidate !== ".." && !candidate.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Process did not exit within ${timeoutMs}ms.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function stopProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    return;
  }
  try {
    await waitForExit(child, PROCESS_STOP_GRACE_MS);
  } catch {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    } catch {
      // The process exited between the grace timeout and the final signal.
    }
  }
}
