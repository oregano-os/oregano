import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Sandbox } from "@vercel/sandbox";

const execFileAsync = promisify(execFile);
const BASE_IMAGE = "vercel/sandbox/node@sha256:07bbba46c01fc02c9cd7e2e1962fda825ff733c099212ade7f893966df949b78";
const repositoryRoot = process.cwd();
const temporary = await mkdtemp(join(tmpdir(), "companyos-trusted-git-snapshot-"));
const archivePath = join(temporary, "core.tar");

try {
  await execFileAsync("git", ["archive", "--format=tar", "--output", archivePath, "HEAD"], {
    cwd: repositoryRoot,
    env: { ...process.env, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C" },
  });
  const archive = await readFile(archivePath);
  const sandbox = await Sandbox.create({
    name: `companyos-builder-trusted-git-image-${randomUUID()}`,
    image: BASE_IMAGE,
    timeout: 600_000,
    resources: { vcpus: 1 },
    ports: [],
    networkPolicy: "deny-all",
    persistent: false,
    tags: {
      component: "builder-trusted-git-image",
      workbench: "0.1.0-experimental.7",
      core: "0.3.2",
    },
  });
  try {
    await sandbox.fs.mkdir("/vercel/sandbox/input", { recursive: true });
    await sandbox.writeFiles([{ path: "/vercel/sandbox/input/core.tar", content: archive, mode: 0o600 }]);
    await requireSuccess(await sandbox.runCommand({
      cmd: "mkdir",
      args: ["-p", "/vercel/sandbox/core"],
      timeoutMs: 10_000,
    }), "Trusted Git snapshot core directory");
    await requireSuccess(await sandbox.runCommand({
      cmd: "tar",
      args: ["-xf", "/vercel/sandbox/input/core.tar", "-C", "/vercel/sandbox/core"],
      timeoutMs: 60_000,
    }), "Trusted Git snapshot source extraction");
    await sandbox.updateNetworkPolicy({ allow: ["registry.npmjs.org"] });
    await requireSuccess(await sandbox.runCommand({
      cmd: "pnpm",
      args: ["install", "--dir", "/vercel/sandbox/core", "--frozen-lockfile", "--ignore-scripts"],
      timeoutMs: 300_000,
    }), "Trusted Git snapshot dependency installation");
    await sandbox.updateNetworkPolicy("deny-all");
    await requireSuccess(await sandbox.runCommand({
      cmd: "node",
      args: [
        "--experimental-strip-types",
        "/vercel/sandbox/core/packages/cli/src/cli.mjs",
        "validate",
        "/vercel/sandbox/core/packages/testkit/fixtures/acme-casas",
        "--format",
        "json",
      ],
      cwd: "/vercel/sandbox/core",
      timeoutMs: 60_000,
    }), "Trusted Git snapshot Workbench verification");
    const git = await sandbox.runCommand({ cmd: "git", args: ["--version"], timeoutMs: 10_000 });
    await requireSuccess(git, "Trusted Git snapshot Git verification");
    const snapshot = await sandbox.snapshot({ expiration: 0 });
    process.stdout.write(`${JSON.stringify({
      snapshotId: snapshot.snapshotId,
      status: snapshot.status,
      sizeBytes: snapshot.sizeBytes,
      baseImage: BASE_IMAGE,
      gitVersion: (await git.stdout()).trim(),
      workbenchVersion: "0.1.0-experimental.7",
      coreVersion: "0.3.2",
    }, null, 2)}\n`);
  } catch (error) {
    await sandbox.stop().catch(() => undefined);
    throw error;
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function requireSuccess(
  command: Awaited<ReturnType<Sandbox["runCommand"]>>,
  label: string,
): Promise<void> {
  if (command.exitCode !== 0) {
    throw new Error(`${label} failed: ${(await command.stderr()).slice(-4_000)}`);
  }
}
