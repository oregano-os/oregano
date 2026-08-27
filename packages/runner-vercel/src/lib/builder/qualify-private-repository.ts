import { createSign, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Sandbox } from "@vercel/sandbox";

const QUALIFICATION_IMAGE = "vercel/sandbox/node@sha256:07bbba46c01fc02c9cd7e2e1962fda825ff733c099212ade7f893966df949b78";
const repository = requireEnvironment("BUILDER_GITHUB_REPOSITORY");
const baseCommit = requireEnvironment("BUILDER_GITHUB_BASE_COMMIT");
const appId = requireEnvironment("BUILDER_GITHUB_APP_ID");
const installationId = requireEnvironment("BUILDER_GITHUB_INSTALLATION_ID");
if (!/^[0-9a-f]{40}$/.test(baseCommit)) {
  throw new Error("BUILDER_GITHUB_BASE_COMMIT must be an exact lowercase 40-character commit.");
}
const target = parseGitHubRepository(repository);
const privateKey = await resolvePrivateKey();
const installationToken = await createReadOnlyInstallationToken({
  appId,
  installationId,
  privateKey,
  repositoryName: target.repository,
});

const sandbox = await Sandbox.create({
  name: `companyos-builder-private-repo-${randomUUID()}`,
  image: QUALIFICATION_IMAGE,
  source: {
    type: "git",
    url: target.cloneUrl,
    username: "x-access-token",
    password: installationToken.token,
    depth: 1,
    revision: baseCommit,
  },
  timeout: 120_000,
  resources: { vcpus: 1 },
  ports: [],
  networkPolicy: "deny-all",
  persistent: false,
  tags: { component: "builder", qualification: "private-repository" },
});

try {
  const head = await sandbox.runCommand({ cmd: "git", args: ["rev-parse", "HEAD"], timeoutMs: 10_000 });
  const audit = await sandbox.runCommand({
    cmd: "node",
    args: [
      "-e",
      [
        "const fs=require('node:fs');",
        "const cp=require('node:child_process');",
        "const config=fs.readFileSync('.git/config','utf8');",
        "const remote=cp.execFileSync('git',['remote','get-url','origin'],{encoding:'utf8'});",
        "const helper=cp.spawnSync('git',['config','--get','credential.helper'],{encoding:'utf8'}).stdout||'';",
        "const processes=cp.execFileSync('ps',['-eo','command'],{encoding:'utf8'});",
        "const material=[config,remote,helper,processes,JSON.stringify(process.env)].join('\\n');",
        "const cloneUser='x-access'+'-token';",
        "const credentialPattern=new RegExp('(?:gh[opsu]_[A-Za-z0-9]{20,}|'+cloneUser+'|authorization:\\\\s*bearer)','i');",
        "process.stdout.write(JSON.stringify({remoteIsCredentialFree:!credentialPattern.test(remote),configIsCredentialFree:!credentialPattern.test(config),environmentIsCredentialFree:!credentialPattern.test(JSON.stringify(process.env)),processesAreCredentialFree:!credentialPattern.test(processes),credentialHelperAbsent:helper.trim()==='' }));",
        "process.exit(credentialPattern.test(material)?9:0);",
      ].join(""),
    ],
    timeoutMs: 10_000,
  });
  const network = await sandbox.runCommand({
    cmd: "node",
    args: ["-e", "fetch('https://example.com').then(()=>process.exit(8)).catch(()=>process.exit(0))"],
    timeoutMs: 10_000,
  });
  const observedHead = (await head.stdout()).trim();
  const auditEvidence = JSON.parse(await audit.stdout()) as Record<string, unknown>;
  if (head.exitCode !== 0 || observedHead !== baseCommit) {
    throw new Error("Private repository qualification did not check out the exact base commit.");
  }
  if (audit.exitCode !== 0) {
    throw new Error("Private repository qualification found credential material inside the Sandbox.");
  }
  if (network.exitCode !== 0) {
    throw new Error("Private repository qualification did not restore deny-all network access.");
  }
  process.stdout.write(`${JSON.stringify({
    repository: `${target.owner}/${target.repository}`,
    exactBaseCommit: observedHead,
    tokenExpiresAt: installationToken.expiresAt,
    requestedPermissions: { contents: "read" },
    requestedRepositoryScope: "single-repository",
    audit: auditEvidence,
    externalNetworkDeniedBeforeAgent: true,
    installationTokenSentToAgentProcess: false,
  }, null, 2)}\n`);
} finally {
  await sandbox.stop().catch(() => undefined);
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing private-repository qualification input '${name}'.`);
  return value;
}

async function resolvePrivateKey(): Promise<string> {
  const direct = process.env.BUILDER_GITHUB_PRIVATE_KEY;
  const path = process.env.BUILDER_GITHUB_PRIVATE_KEY_PATH;
  if (direct && path) {
    throw new Error("Configure only one GitHub App private-key qualification source.");
  }
  if (direct) return direct.replace(/\\n/g, "\n");
  if (path) return readFile(path, "utf8");
  throw new Error(
    "Missing private-repository qualification input 'BUILDER_GITHUB_PRIVATE_KEY' or 'BUILDER_GITHUB_PRIVATE_KEY_PATH'.",
  );
}

function parseGitHubRepository(value: string): { owner: string; repository: string; cloneUrl: string } {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
  if (!match) throw new Error("BUILDER_GITHUB_REPOSITORY must be a credential-free HTTPS GitHub repository URL.");
  const owner = match[1];
  const repository = match[2];
  return { owner, repository, cloneUrl: `https://github.com/${owner}/${repository}.git` };
}

async function createReadOnlyInstallationToken(input: {
  appId: string;
  installationId: string;
  privateKey: string;
  repositoryName: string;
}): Promise<{ token: string; expiresAt: string }> {
  if (!/^\d+$/.test(input.appId) || !/^\d+$/.test(input.installationId)) {
    throw new Error("GitHub App and installation IDs must be decimal identifiers.");
  }
  const issuedAt = Math.floor(Date.now() / 1_000) - 30;
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify({
    iat: issuedAt,
    exp: issuedAt + 9 * 60,
    iss: input.appId,
  })).toString("base64url");
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const jwt = `${unsigned}.${signer.sign(input.privateKey).toString("base64url")}`;
  const response = await fetch(`https://api.github.com/app/installations/${input.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${jwt}`,
      "content-type": "application/json",
      "user-agent": "companyos-builder-qualification",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      repositories: [input.repositoryName],
      permissions: { contents: "read" },
    }),
  });
  const body = await response.json() as { token?: string; expires_at?: string; message?: string };
  if (!response.ok || !body.token || !body.expires_at) {
    throw new Error(`GitHub App token creation failed with status ${response.status}: ${body.message ?? "unknown error"}.`);
  }
  return { token: body.token, expiresAt: body.expires_at };
}
