import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Sandbox } from "@vercel/sandbox";
import { BUILDER_ACP_PROFILES } from "../../../../runtime/builder/profiles.ts";

const exec = promisify(execFile);
const BASE_IMAGE = "vercel/sandbox/node@sha256:07bbba46c01fc02c9cd7e2e1962fda825ff733c099212ade7f893966df949b78";

/** One source-pinned image, reused in separate coding and trusted sandboxes. */
export async function createQualifiedBuilderSnapshot(repositoryRoot = process.cwd()) {
  const git = async (...args: string[]) => (await exec("git", args, { cwd: repositoryRoot })).stdout.trim();
  if (await git("status", "--porcelain")) throw new Error("Commit the exact Core before qualifying its Builder image.");
  const coreCommit = await git("rev-parse", "HEAD");
  const coreVersion = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")).version;
  const workbenchVersion = JSON.parse(await readFile(join(repositoryRoot, "packages/cli/package.json"), "utf8")).version;
  const temp = await mkdtemp(join(tmpdir(), "companyos-builder-image-"));
  let sandbox: Sandbox | undefined;
  try {
    await exec("git", ["archive", "--format=tar", "--output", join(temp, "core.tar"), coreCommit], { cwd: repositoryRoot });
    sandbox = await Sandbox.create({ name: `companyos-builder-image-${randomUUID()}`, image: BASE_IMAGE,
      timeout: 600000, resources: { vcpus: 2 }, ports: [], networkPolicy: "deny-all", persistent: false,
      tags: { component: "builder-qualified-image", core: coreVersion, commit: coreCommit, workbench: workbenchVersion } });
    const run = async (cmd: string, args: string[], timeoutMs = 60000) => {
      const result = await sandbox!.runCommand({ cmd, args, timeoutMs, cwd: "/vercel/sandbox" });
      if (result.exitCode !== 0) throw new Error(`Builder image qualification failed at ${cmd}: ${(await result.stderr()).slice(-2000)}`);
      return (await result.stdout()).trim();
    };
    await sandbox.fs.mkdir("/vercel/sandbox/core", { recursive: true });
    await sandbox.fs.mkdir("/vercel/sandbox/input", { recursive: true });
    await sandbox.writeFiles([{ path: "/vercel/sandbox/input/core.tar", content: await readFile(join(temp, "core.tar")), mode: 0o600 }]);
    await run("tar", ["-xf", "/vercel/sandbox/input/core.tar", "-C", "/vercel/sandbox/core"]);
    await sandbox.fs.writeFile("/vercel/sandbox/core/core-provenance.json", JSON.stringify({ coreCommit, coreVersion, workbenchVersion }), "utf8");
    await sandbox.updateNetworkPolicy({ allow: ["registry.npmjs.org"] });
    await run("pnpm", ["install", "--dir", "/vercel/sandbox/core", "--frozen-lockfile", "--ignore-scripts"], 300000);
    await sandbox.updateNetworkPolicy("deny-all");
    for (const [name, target] of [["node_modules", "core/node_modules"], ["packages", "core/packages"]]) await run("ln", ["-s", target!, `/vercel/sandbox/${name}`]);
    for (const profile of Object.values(BUILDER_ACP_PROFILES)) {
      const version = await run(`/vercel/sandbox/core/node_modules/.bin/${profile.binaryName}`, ["--version"]);
      if (!version.includes(profile.version)) throw new Error(`Image coding profile '${profile.id}' is not the pinned version.`);
    }
    await run("node", ["/vercel/sandbox/core/packages/cli/src/cli.mjs", "validate", "/vercel/sandbox/core/packages/testkit/fixtures/acme-casas", "--format", "json"]);
    await run("test", ["-s", "/vercel/sandbox/core/packages/cli/content/guides/prepare-builder-change.md"]);
    await run("rm", ["/vercel/sandbox/input/core.tar"]);
    const snapshot = await sandbox.snapshot({ expiration: 0 });
    return { snapshotId: snapshot.snapshotId, status: snapshot.status, sizeBytes: snapshot.sizeBytes,
      baseImage: BASE_IMAGE, coreCommit, coreVersion, workbenchVersion,
      profiles: Object.values(BUILDER_ACP_PROFILES).map(({ id, version }) => ({ id, version })),
      guides: true, workbench: true, isolatedExecutions: true };
  } finally { await sandbox?.stop().catch(() => undefined); await rm(temp, { recursive: true, force: true }); }
}
