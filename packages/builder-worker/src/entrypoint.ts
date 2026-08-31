#!/usr/bin/env -S node --experimental-strip-types

import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBuilderAcpPermissionPolicy,
  runBuilderAcp,
} from "../../runtime/builder/acp-client.ts";
import { resolveBuilderAcpProfile } from "../../runtime/builder/profiles.ts";
import {
  BUILDER_WORKER_PROGRESS_PATH,
  parseBuilderWorkerRequest,
  type BuilderWorkerProgress,
  type BuilderWorkerResult,
} from "./contracts.ts";

const requestPath = process.argv[2];
if (!requestPath || !isAbsolute(requestPath)) {
  throw new Error("Usage: companyos-builder-worker /absolute/path/to/request.json");
}

const request = parseBuilderWorkerRequest(JSON.parse(await readFile(requestPath, "utf8")));
const profile = resolveBuilderAcpProfile(request.profileId);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "..", "..");
const localExecutable = resolve(packageRoot, "node_modules", ".bin", profile.binaryName);
const executable = existsSync(localExecutable)
  ? localExecutable
  : resolve(repositoryRoot, "node_modules", ".bin", profile.binaryName);
const environment = workerEnvironment(profile.id);

try {
  const evidence = await runBuilderAcp({
    launch: { profile, executable },
    cwd: request.workspacePath,
    prompt: request.prompt,
    timeoutMs: request.timeoutMs,
    environment,
    permissionPolicy: createBuilderAcpPermissionPolicy(profile, request.workspacePath),
    onProgress: async (progress) => {
      await writeProgress({
        schemaVersion: 1,
        jobId: request.jobId,
        requestId: request.requestId,
        profileId: request.profileId,
        ...progress,
        observedAt: new Date().toISOString(),
      });
    },
  });
  await writeResult({
    schemaVersion: 1,
    jobId: request.jobId,
    requestId: request.requestId,
    profileId: request.profileId,
    state: "succeeded",
    evidence,
  });
  // runBuilderAcp has already stopped the ACP child process tree. Exit
  // explicitly after flushing the terminal receipt so SDK-owned handles cannot
  // keep an otherwise completed detached Sandbox command alive until timeout.
  process.exit(0);
} catch (error) {
  await writeResult({
    schemaVersion: 1,
    jobId: request.jobId,
    requestId: request.requestId,
    profileId: request.profileId,
    state: "failed",
    failure: { category: failureCategory(error) },
  });
  process.exit(1);
}

function workerEnvironment(profileId: typeof profile.id): Record<string, string> {
  const environment: Record<string, string> = {
    HOME: process.env.HOME ?? "/vercel/sandbox/home",
    LANG: process.env.LANG ?? "C.UTF-8",
    NO_BROWSER: "1",
    PATH: process.env.PATH ?? "/vercel/sandbox/worker/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
  };
  if (profileId === "claude-code") {
    environment.ANTHROPIC_API_KEY = "companyos-builder-broker-placeholder";
  } else {
    environment.CODEX_API_KEY = "companyos-builder-broker-placeholder";
    environment.DEFAULT_AUTH_REQUEST = JSON.stringify({ methodId: "api-key" });
  }
  return environment;
}

async function writeResult(result: BuilderWorkerResult): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function writeProgress(progress: BuilderWorkerProgress): Promise<void> {
  const temporaryPath = `${BUILDER_WORKER_PROGRESS_PATH}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(progress), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, BUILDER_WORKER_PROGRESS_PATH);
}

function failureCategory(error: unknown): "acp-process-exit" | "acp-run-failed" {
  const message = error instanceof Error ? error.message : String(error);
  return /ACP (?:process exited before the active job completed|connection closed)/.test(message)
    ? "acp-process-exit"
    : "acp-run-failed";
}
