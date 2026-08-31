import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { BUILDER_ACP_PROFILES } from "../../../../runtime/builder/profiles.ts";

const BASE_IMAGE = "vercel/sandbox/node@sha256:07bbba46c01fc02c9cd7e2e1962fda825ff733c099212ade7f893966df949b78";
const repositoryRoot = process.cwd();
const sandbox = await Sandbox.create({
  name: `companyos-builder-worker-image-${randomUUID()}`,
  image: BASE_IMAGE,
  timeout: 300_000,
  resources: { vcpus: 1 },
  ports: [],
  networkPolicy: "deny-all",
  persistent: false,
  tags: {
    component: "builder-worker-image",
    acp: "1.4.0",
    claude: BUILDER_ACP_PROFILES["claude-code"].version,
    codex: BUILDER_ACP_PROFILES.codex.version,
  },
});

try {
  await sandbox.fs.mkdir("/vercel/sandbox/packages/builder-worker/src", { recursive: true });
  await sandbox.fs.mkdir("/vercel/sandbox/packages/runtime/builder", { recursive: true });
  await sandbox.writeFiles([
    {
      path: "/vercel/sandbox/package.json",
      content: JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          "@agentclientprotocol/claude-agent-acp": BUILDER_ACP_PROFILES["claude-code"].version,
          "@agentclientprotocol/codex-acp": BUILDER_ACP_PROFILES.codex.version,
          "@agentclientprotocol/sdk": "1.4.0",
          zod: "4.4.3",
        },
      }),
    },
    {
      path: "/vercel/sandbox/packages/builder-worker/src/contracts.ts",
      content: await readFile(resolve(repositoryRoot, "packages/builder-worker/src/contracts.ts"), "utf8"),
    },
    {
      path: "/vercel/sandbox/packages/builder-worker/src/entrypoint.ts",
      content: await readFile(resolve(repositoryRoot, "packages/builder-worker/src/entrypoint.ts"), "utf8"),
      mode: 0o755,
    },
    {
      path: "/vercel/sandbox/packages/runtime/builder/acp-client.ts",
      content: await readFile(resolve(repositoryRoot, "packages/runtime/builder/acp-client.ts"), "utf8"),
    },
    {
      path: "/vercel/sandbox/packages/runtime/builder/profiles.ts",
      content: await readFile(resolve(repositoryRoot, "packages/runtime/builder/profiles.ts"), "utf8"),
    },
  ]);
  await sandbox.updateNetworkPolicy({ allow: ["registry.npmjs.org"] });
  const install = await sandbox.runCommand({
    cmd: "pnpm",
    args: ["install", "--dir", "/vercel/sandbox", "--prod", "--ignore-workspace"],
    timeoutMs: 180_000,
  });
  if (install.exitCode !== 0) {
    throw new Error(`Builder worker snapshot dependency installation failed: ${(await install.stderr()).slice(-4_000)}`);
  }
  for (const profile of Object.values(BUILDER_ACP_PROFILES)) {
    const probe = await sandbox.runCommand({
      cmd: `/vercel/sandbox/node_modules/.bin/${profile.binaryName}`,
      args: ["--version"],
      timeoutMs: 10_000,
    });
    if (probe.exitCode !== 0 || !(await probe.stdout()).includes(profile.version)) {
      throw new Error(`Builder worker snapshot profile '${profile.id}' failed exact-version verification.`);
    }
  }
  await sandbox.updateNetworkPolicy("deny-all");
  const snapshot = await sandbox.snapshot({ expiration: 0 });
  process.stdout.write(`${JSON.stringify({
    snapshotId: snapshot.snapshotId,
    status: snapshot.status,
    sizeBytes: snapshot.sizeBytes,
    baseImage: BASE_IMAGE,
    acpSdkVersion: "1.4.0",
    profiles: Object.values(BUILDER_ACP_PROFILES).map((profile) => ({
      id: profile.id,
      implementation: profile.packageName,
      version: profile.version,
    })),
  }, null, 2)}\n`);
} catch (error) {
  await sandbox.stop().catch(() => undefined);
  throw error;
}
