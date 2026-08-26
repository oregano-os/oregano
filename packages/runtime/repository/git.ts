import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { RepositorySourceReceipt, RepositorySourceRequest } from "./contracts.ts";

const execFileAsync = promisify(execFile);
export const REPOSITORY_SOURCE_RECEIPT_PATH = join(".git", "companyos", "source-receipt.json");

export async function runGit(
  cwd: string,
  args: string[],
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: {
      NODE_ENV: process.env.NODE_ENV ?? "production",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C",
      GIT_TERMINAL_PROMPT: "0",
      ...extraEnvironment,
    },
  });
  return result.stdout;
}

export async function runGitOptional(
  cwd: string,
  args: string[],
  extraEnvironment: Readonly<Record<string, string>> = {},
): Promise<string | undefined> {
  try {
    return await runGit(cwd, args, extraEnvironment);
  } catch {
    return undefined;
  }
}

export async function sanitizeMaterializedCheckout(workspacePath: string): Promise<void> {
  const remotes = (await runGit(workspacePath, ["remote"])).split("\n").filter(Boolean);
  for (const remote of remotes) await runGit(workspacePath, ["remote", "remove", remote]);
  await runGitOptional(workspacePath, ["config", "--local", "--unset-all", "credential.helper"]);
  await runGitOptional(workspacePath, ["config", "--local", "--unset-all", "http.extraheader"]);
  await runGitOptional(workspacePath, ["reflog", "expire", "--expire=now", "--all"]);
}

export async function assertSanitizedMaterializedCheckout(
  workspacePath: string,
  baseCommit: string,
): Promise<void> {
  const head = (await runGit(workspacePath, ["rev-parse", "HEAD"])).trim();
  if (head !== baseCommit) throw new Error("Materialized checkout HEAD differs from the exact base commit.");
  const remotes = (await runGit(workspacePath, ["remote"])).trim();
  if (remotes) throw new Error("Materialized checkout retained a Git remote.");
  const config = await runGit(workspacePath, ["config", "--local", "--list"]);
  if (/(credential|extraheader|authorization|token|password|github\.com)/i.test(config)) {
    throw new Error("Materialized checkout retained repository credential or provider configuration.");
  }
}

export async function readExistingSourceReceipt(
  destinationPath: string,
): Promise<RepositorySourceReceipt | undefined> {
  try {
    return JSON.parse(
      await readFile(join(destinationPath, REPOSITORY_SOURCE_RECEIPT_PATH), "utf8"),
    ) as RepositorySourceReceipt;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeSourceReceipt(
  destinationPath: string,
  receipt: RepositorySourceReceipt,
): Promise<void> {
  const path = join(destinationPath, REPOSITORY_SOURCE_RECEIPT_PATH);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function assertMatchingSourceReceipt(
  receipt: RepositorySourceReceipt,
  request: RepositorySourceRequest,
  providerId: string,
  providerVersion: string,
): void {
  if (
    receipt.requestId !== request.requestId
    || receipt.bindingId !== request.bindingId
    || receipt.repositoryId !== request.repositoryId
    || receipt.baseCommit !== request.baseCommit
    || receipt.workspacePath !== request.destinationPath
    || receipt.provider.id !== providerId
    || receipt.provider.version !== providerVersion
  ) {
    throw new Error("Repository source idempotency key conflicts with an existing materialization.");
  }
}

export async function assertRepositoryDestinationAbsent(path: string): Promise<void> {
  try {
    await stat(path);
    throw new Error(`Repository source destination already exists without a matching receipt: ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function applyGitPatch(cwd: string, patch: string): Promise<void> {
  const child = spawn("git", ["apply", "--binary", "--index", "--whitespace=nowarn", "-"], {
    cwd,
    env: {
      NODE_ENV: process.env.NODE_ENV ?? "production",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  child.stdin.end(patch);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const code = await new Promise<number | null>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", resolvePromise);
  });
  if (code !== 0) throw new Error(`Trusted proposal patch application failed: ${stderr.trim()}`);
}
