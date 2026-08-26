import { randomUUID } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import {
  resolveBuilderAcpProfile,
  type BuilderAcpProfileId,
} from "../../../../runtime/builder/profiles.ts";
import {
  createVercelModelCredentialBinding,
  modelCredentialBindingEvidence,
} from "./model-credential-broker.ts";

const WORKSPACE_PATH = "/vercel/sandbox/workspace";
const WORKER_REQUEST_PATH = "/vercel/sandbox/builder-request.json";

export interface DeployedAcpQualificationEvidence {
  readonly profile: {
    readonly id: BuilderAcpProfileId;
    readonly implementation: string;
    readonly version: string;
  };
  readonly execution: {
    readonly adapter: string;
    readonly adapterVersion: string;
    readonly state: "succeeded";
  };
  readonly credentialBroker: unknown;
  readonly worker: unknown;
  readonly hostVerifiedResult: true;
  readonly exactBaseVerified: true;
  readonly realCredentialSentToCodingProcess: false;
}

export async function qualifyDeployedAcp(
  profileId: BuilderAcpProfileId,
): Promise<DeployedAcpQualificationEvidence> {
  const profile = resolveBuilderAcpProfile(profileId);
  const snapshotId = process.env.COMPANYOS_BUILDER_WORKER_SNAPSHOT_ID;
  const credential = profile.id === "claude-code"
    ? process.env.ANTHROPIC_API_KEY
    : process.env.OPENAI_API_KEY;
  if (!snapshotId || !credential) {
    throw new Error("Deployed ACP qualification failed during 'configure'.");
  }
  const broker = createVercelModelCredentialBinding(profile.id, credential);
  let sandbox: Sandbox | undefined;
  let phase = "start_sandbox";
  let safeDetail = "";
  try {
    sandbox = await Sandbox.create({
      name: `companyos-deployed-auth-${profile.id}-${randomUUID()}`,
      source: { type: "snapshot", snapshotId },
      timeout: 210_000,
      resources: { vcpus: 1 },
      ports: [],
      networkPolicy: "deny-all",
      persistent: false,
      tags: { component: "builder", qualification: "deployed-acp", profile: profile.id },
    });
    phase = "prepare_fixture";
    await sandbox.fs.mkdir(WORKSPACE_PATH, { recursive: true });
    await sandbox.fs.mkdir("/vercel/sandbox/home", { recursive: true });
    await sandbox.fs.writeFile(`${WORKSPACE_PATH}/fixture.txt`, "base\n", "utf8");
    await runSandboxGit(sandbox, WORKSPACE_PATH, ["init", "-q"]);
    await runSandboxGit(sandbox, WORKSPACE_PATH, ["add", "fixture.txt"]);
    await runSandboxGit(sandbox, WORKSPACE_PATH, [
      "-c", "user.name=CompanyOS Qualification",
      "-c", "user.email=qualification@companyos.invalid",
      "commit", "-qm", "qualification base",
    ]);
    const baseCommit = (await runSandboxGit(sandbox, WORKSPACE_PATH, ["rev-parse", "HEAD"])).trim();
    const runId = randomUUID();
    await sandbox.fs.writeFile(WORKER_REQUEST_PATH, JSON.stringify({
      schemaVersion: 1,
      jobId: `qualification:${profile.id}:${runId}`,
      requestId: `qualification:${runId}`,
      profileId: profile.id,
      workspacePath: WORKSPACE_PATH,
      prompt: [
        "This is a bounded CompanyOS brokered-authentication qualification fixture.",
        "Change only fixture.txt by replacing its complete content with exactly:",
        `changed-by-${profile.id}-in-sandbox`,
        "Do not inspect parent directories, install software, or change any other file.",
      ].join("\n"),
      timeoutMs: 120_000,
    }), "utf8");

    phase = "run_worker";
    await sandbox.updateNetworkPolicy(broker.networkPolicy);
    const command = await sandbox.runCommand({
      cmd: "node",
      args: [
        "--experimental-strip-types",
        "/vercel/sandbox/packages/builder-worker/src/entrypoint.ts",
        WORKER_REQUEST_PATH,
      ],
      cwd: "/vercel/sandbox",
      env: {
        ...broker.agentEnvironment,
        HOME: "/vercel/sandbox/home",
        LANG: "C.UTF-8",
        PATH: "/vercel/sandbox/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
        TMPDIR: "/tmp",
      },
      timeoutMs: 150_000,
    });
    const stdout = await command.stdout();
    if (command.exitCode !== 0) throw new Error("qualification worker failed");
    const worker = JSON.parse(stdout) as Record<string, unknown>;

    phase = "verify_result";
    await sandbox.updateNetworkPolicy("deny-all");
    const content = await sandbox.fs.readFile(`${WORKSPACE_PATH}/fixture.txt`, "utf8");
    const status = await runSandboxGit(sandbox, WORKSPACE_PATH, [
      "status", "--porcelain=v1", "--untracked-files=all",
    ]);
    const diff = await runSandboxGit(sandbox, WORKSPACE_PATH, [
      "diff", "--binary", "--no-ext-diff", baseCommit, "--",
    ]);
    const verification = {
      exactBase: /^[0-9a-f]{40}$/.test(baseCommit),
      exactContent: content === `changed-by-${profile.id}-in-sandbox\n`,
      status: status.trimEnd(),
      oneExpectedPath: status === " M fixture.txt\n",
      expectedDiffHeader: diff.includes("diff --git a/fixture.txt b/fixture.txt"),
      expectedDiffAddition: diff.includes(`+changed-by-${profile.id}-in-sandbox`),
    };
    if (Object.entries(verification).some(([key, value]) => key !== "status" && value !== true)) {
      safeDetail = JSON.stringify(verification);
      throw new Error("qualification result differs from the bounded expected change");
    }
    return {
      profile: {
        id: profile.id,
        implementation: profile.packageName,
        version: profile.version,
      },
      execution: {
        adapter: "vercel-sandbox",
        adapterVersion: "3.1.0",
        state: "succeeded",
      },
      credentialBroker: modelCredentialBindingEvidence(broker),
      worker,
      hostVerifiedResult: true,
      exactBaseVerified: true,
      realCredentialSentToCodingProcess: false,
    };
  } catch {
    throw new Error(`Deployed ACP qualification failed during '${phase}'.${safeDetail ? ` ${safeDetail}` : ""}`);
  } finally {
    if (sandbox) {
      await sandbox.updateNetworkPolicy("deny-all").catch(() => undefined);
      await sandbox.stop().catch(() => undefined);
    }
  }
}

async function runSandboxGit(
  sandbox: Sandbox,
  cwd: string,
  args: string[],
): Promise<string> {
  const command = await sandbox.runCommand({ cmd: "git", args, cwd, timeoutMs: 30_000 });
  if (command.exitCode !== 0) throw new Error("sandbox Git command failed");
  return await command.stdout();
}

export function isStagedProductionQualificationRequest(
  request: Request,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const deploymentHost = environment.VERCEL_URL?.toLowerCase();
  if (environment.VERCEL_ENV !== "production" || !deploymentHost) return false;
  const requestUrl = new URL(request.url);
  const headerHost = request.headers.get("host")?.toLowerCase();
  return requestUrl.host.toLowerCase() === deploymentHost && headerHost === deploymentHost;
}
