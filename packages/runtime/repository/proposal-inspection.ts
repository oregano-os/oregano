import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertGitCommit, type CheckedProposal } from "./contracts.ts";

const execFileAsync = promisify(execFile);

const FORBIDDEN_PATHS = [
  /^\.git(?:\/|$)/,
  /^\.env(?:\.|$)/,
  /^\.vercel(?:\/|$)/,
  /^\.companyos\/repository-protection\.yaml$/,
  /^\.github(?:\/|$)/,
  /(?:^|\/)\.DS_Store$/,
  /(?:^|\/)node_modules(?:\/|$)/,
] as const;

export interface ProposalInspection {
  readonly baseCommit: string;
  readonly diff: string;
  readonly diffDigest: string;
  readonly changedPaths: readonly string[];
}

export async function inspectProposalWorkspace(
  workspacePath: string,
  baseCommit: string,
): Promise<ProposalInspection> {
  assertGitCommit(baseCommit, "Proposal inspection baseCommit");
  const resolved = (await git(workspacePath, ["rev-parse", "--verify", `${baseCommit}^{commit}`])).trim();
  if (resolved !== baseCommit) throw new Error("Proposal workspace does not contain the exact requested base commit.");
  const status = await git(workspacePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const trackedDiff = await git(workspacePath, ["diff", "--binary", "--no-ext-diff", baseCommit, "--"]);
  const untracked = parsePorcelainPaths(status).filter((path) => statusIncludesUntracked(status, path));
  const untrackedDiffs: string[] = [];
  for (const path of untracked.sort()) {
    untrackedDiffs.push(await git(workspacePath, ["diff", "--binary", "--no-index", "--", "/dev/null", path], true));
  }
  const diff = [trackedDiff, ...untrackedDiffs].filter(Boolean).join("\n");
  const changedPaths = parsePorcelainPaths(status).sort();
  if (changedPaths.length === 0 || diff.trim() === "") {
    throw new Error("Builder proposal contains no independently observed changes.");
  }
  for (const path of changedPaths) {
    if (path.startsWith("/") || path.split("/").includes("..") || path.includes("\u0000")) {
      throw new Error(`Builder proposal contains unsafe path '${path}'.`);
    }
    if (FORBIDDEN_PATHS.some((pattern) => pattern.test(path))) {
      throw new Error(`Builder proposal changes forbidden path '${path}'.`);
    }
  }
  return {
    baseCommit,
    diff,
    diffDigest: sha256(diff),
    changedPaths,
  };
}

export function checkedProposalFromInspection(
  inspection: ProposalInspection,
  checks: CheckedProposal["checks"],
): CheckedProposal {
  if (checks.length === 0 || checks.some((check) => check.status !== "passed")) {
    throw new Error("Checked proposal requires at least one passed Workbench check.");
  }
  return {
    validationPassed: true,
    validatedDiffDigest: inspection.diffDigest,
    changedPaths: inspection.changedPaths,
    checks,
  };
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function git(cwd: string, args: string[], allowNonZero = false): Promise<string> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: {
        NODE_ENV: process.env.NODE_ENV ?? "production",
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LANG: "C",
      },
    });
    return result.stdout;
  } catch (error) {
    if (allowNonZero && isExecError(error) && error.code === 1) return error.stdout ?? "";
    throw error;
  }
}

function parsePorcelainPaths(status: string): string[] {
  const entries = status.split("\u0000").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (entry.length < 4) throw new Error("Git returned malformed proposal status.");
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    paths.push(path);
    if ((code.startsWith("R") || code.startsWith("C")) && entries[index + 1]) {
      paths.push(entries[index + 1]!);
      index += 1;
    }
  }
  return [...new Set(paths)];
}

function statusIncludesUntracked(status: string, path: string): boolean {
  return status.split("\u0000").some((entry) => entry.startsWith("?? ") && entry.slice(3) === path);
}

function isExecError(error: unknown): error is { code?: number; stdout?: string } {
  return !!error && typeof error === "object";
}
