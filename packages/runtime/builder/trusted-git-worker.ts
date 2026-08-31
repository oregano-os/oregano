#!/usr/bin/env -S node --experimental-strip-types

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  checkedProposalFromInspection,
  inspectProposalWorkspace,
  sha256,
} from "../repository/proposal-inspection.ts";

const execFileAsync = promisify(execFile);
const requestPath = process.argv[2];
if (!requestPath?.startsWith("/")) {
  throw new Error("Usage: trusted-git-worker /absolute/path/to/request.json");
}

const request = JSON.parse(await readFile(requestPath, "utf8")) as {
  mode?: "inspect" | "validate";
  workspacePath?: string;
  baseCommit?: string;
};
if (!request.workspacePath?.startsWith("/") || !/^[0-9a-f]{40}$/.test(request.baseCommit ?? "")) {
  throw new Error("Trusted Git worker request is invalid.");
}
const workspacePath = resolve(request.workspacePath);
const baseCommit = request.baseCommit!;
const inspection = await inspectProposalWorkspace(workspacePath, baseCommit);

if (request.mode === "inspect") {
  process.stdout.write(`${JSON.stringify(inspection)}\n`);
} else if (request.mode === "validate") {
  const coreRoot = resolve(import.meta.dirname, "..", "..", "..");
  const cliPath = resolve(coreRoot, "packages", "cli", "src", "cli.mjs");
  const checks = [];
  for (const command of [
    ["inspect", workspacePath, "--plan", "auto", "--base", baseCommit, "--format", "json"],
    ["validate", workspacePath, "--format", "json"],
    ["security", workspacePath, "--format", "json"],
  ]) {
    const result = await execFileAsync(process.execPath, ["--experimental-strip-types", cliPath, ...command], {
      cwd: workspacePath,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        NODE_ENV: "production",
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        LANG: "C",
        COMPANY_DIR: workspacePath,
      },
    });
    checks.push({
      id: `workbench.${command[0]}`,
      status: "passed" as const,
      evidenceDigest: sha256(result.stdout),
    });
  }
  process.stdout.write(`${JSON.stringify(checkedProposalFromInspection(inspection, checks))}\n`);
} else {
  throw new Error("Trusted Git worker mode is unsupported.");
}
