import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Sandbox } from "@vercel/sandbox";
import { resolveBuilderAcpProfile } from "../../../../runtime/builder/profiles.ts";
import {
  createVercelModelCredentialBinding,
  modelCredentialBindingEvidence,
} from "./model-credential-broker.ts";

const QUALIFICATION_IMAGE = "vercel/sandbox/node@sha256:07bbba46c01fc02c9cd7e2e1962fda825ff733c099212ade7f893966df949b78";
const profile = resolveBuilderAcpProfile(process.argv[2] ?? "");
const credentialVariable = profile.id === "claude-code"
  ? "ANTHROPIC_API_KEY"
  : "OPENAI_API_KEY";
const credential = process.env[credentialVariable];
if (!credential) {
  throw new Error(
    `Missing dedicated qualification secret '${credentialVariable}'. Configure it outside chat and rerun.`,
  );
}
const binding = createVercelModelCredentialBinding(profile.id, credential);
const repositoryRoot = process.cwd();
const workerRoot = resolve(repositoryRoot, "packages/runtime/builder");
const sandbox = await Sandbox.create({
  name: `companyos-builder-auth-${randomUUID()}`,
  image: QUALIFICATION_IMAGE,
  timeout: 300_000,
  resources: { vcpus: 1 },
  ports: [],
  networkPolicy: "deny-all",
  persistent: false,
  tags: { component: "builder", qualification: "brokered-acp", profile: profile.id },
});

try {
  await sandbox.fs.mkdir("/vercel/sandbox/worker", { recursive: true });
  await sandbox.fs.mkdir("/vercel/sandbox/workspace", { recursive: true });
  await sandbox.fs.mkdir("/vercel/sandbox/home", { recursive: true });
  await sandbox.writeFiles([
    {
      path: "/vercel/sandbox/worker/package.json",
      content: JSON.stringify({
        private: true,
        type: "module",
        dependencies: {
          "@agentclientprotocol/sdk": "1.4.0",
          [profile.packageName]: profile.version,
          zod: "4.4.3",
        },
      }),
    },
    {
      path: "/vercel/sandbox/worker/acp-client.ts",
      content: await readFile(resolve(workerRoot, "acp-client.ts"), "utf8"),
    },
    {
      path: "/vercel/sandbox/worker/profiles.ts",
      content: await readFile(resolve(workerRoot, "profiles.ts"), "utf8"),
    },
    {
      path: "/vercel/sandbox/worker/qualify-acp-sandbox-worker.ts",
      content: await readFile(resolve(workerRoot, "qualify-acp-sandbox-worker.ts"), "utf8"),
    },
    {
      path: "/vercel/sandbox/workspace/fixture.txt",
      content: "base\n",
    },
  ]);

  await sandbox.updateNetworkPolicy({ allow: ["registry.npmjs.org"] });
  const install = await sandbox.runCommand({
    cmd: "pnpm",
    args: ["install", "--dir", "/vercel/sandbox/worker", "--prod", "--ignore-workspace"],
    timeoutMs: 120_000,
  });
  if (install.exitCode !== 0) {
    throw new Error(`Pinned ACP worker installation failed: ${(await install.stderr()).slice(-2_000)}`);
  }

  await sandbox.updateNetworkPolicy(binding.networkPolicy);
  const run = await sandbox.runCommand({
    cmd: "node",
    args: [
      "--experimental-strip-types",
      "/vercel/sandbox/worker/qualify-acp-sandbox-worker.ts",
      profile.id,
      "/vercel/sandbox/workspace",
    ],
    cwd: "/vercel/sandbox/worker",
    env: { ...binding.agentEnvironment },
    timeoutMs: 150_000,
  });
  const stdout = await run.stdout();
  if (run.exitCode !== 0) {
    throw new Error(`Brokered ACP worker failed: ${(await run.stderr()).slice(-4_000)}`);
  }
  const file = await sandbox.fs.readFile("/vercel/sandbox/workspace/fixture.txt", "utf8");
  const workerEvidence = JSON.parse(stdout) as Record<string, unknown>;
  process.stdout.write(`${JSON.stringify({
    profile: { id: profile.id, implementation: profile.packageName, version: profile.version },
    broker: modelCredentialBindingEvidence(binding),
    workerEvidence,
    hostVerifiedResult: file === `changed-by-${profile.id}-in-sandbox\n`,
    realCredentialSentToSandboxProcess: false,
  }, null, 2)}\n`);
  if (file !== `changed-by-${profile.id}-in-sandbox\n`) {
    throw new Error("Host could not verify the bounded ACP result independently.");
  }
} finally {
  await sandbox.updateNetworkPolicy("deny-all").catch(() => undefined);
  await sandbox.stop().catch(() => undefined);
}
