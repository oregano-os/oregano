#!/usr/bin/env -S node --experimental-strip-types

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isPathInsideBuilderWorkspace,
  runBuilderAcp,
} from "../../runtime/builder/acp-client.ts";
import { resolveBuilderAcpProfile } from "../../runtime/builder/profiles.ts";
import {
  parseBuilderWorkerRequest,
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

const evidence = await runBuilderAcp({
  launch: { profile, executable },
  cwd: request.workspacePath,
  prompt: request.prompt,
  timeoutMs: request.timeoutMs,
  environment,
  permissionPolicy: (permission) => {
    const locations = permission.toolCall.locations ?? [];
    const bounded = locations.length > 0
      && locations.every((location) => isPathInsideBuilderWorkspace(request.workspacePath, location.path));
    if (!bounded) return undefined;
    return permission.options.find((option) => option.kind === "allow_once")?.optionId;
  },
});

const result: BuilderWorkerResult = {
  schemaVersion: 1,
  jobId: request.jobId,
  requestId: request.requestId,
  profileId: request.profileId,
  evidence,
};
process.stdout.write(`${JSON.stringify(result)}\n`);

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
  }
  return environment;
}
