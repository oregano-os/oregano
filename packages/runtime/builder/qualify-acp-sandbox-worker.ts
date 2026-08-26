import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isPathInsideBuilderWorkspace, runBuilderAcp } from "./acp-client.ts";
import { resolveBuilderAcpProfile } from "./profiles.ts";

const profile = resolveBuilderAcpProfile(process.argv[2] ?? "");
const workspace = resolve(process.argv[3] ?? "");
const executable = resolve(process.cwd(), "node_modules", ".bin", profile.binaryName);
const environment = agentEnvironment(profile.id);

const evidence = await runBuilderAcp({
  launch: { profile, executable },
  cwd: workspace,
  prompt: [
    "This is a bounded CompanyOS brokered-authentication qualification fixture.",
    "Change only fixture.txt by replacing its complete content with exactly:",
    `changed-by-${profile.id}-in-sandbox`,
    "Do not inspect parent directories, install software, or change any other file.",
  ].join("\n"),
  timeoutMs: 120_000,
  environment,
  permissionPolicy: (permission) => {
    const locations = permission.toolCall.locations ?? [];
    const bounded = locations.length > 0
      && locations.every((location) => isPathInsideBuilderWorkspace(workspace, location.path));
    if (!bounded) return undefined;
    return permission.options.find((option) => option.kind === "allow_once")?.optionId;
  },
});

const content = await readFile(resolve(workspace, "fixture.txt"), "utf8");
const expected = `changed-by-${profile.id}-in-sandbox\n`;
if (content !== expected) {
  throw new Error("Brokered ACP qualification did not produce the required bounded change.");
}
process.stdout.write(`${JSON.stringify({
  evidence,
  resultingFileVerified: true,
  agentReceivedPlaceholderOnly: true,
}, null, 2)}\n`);

function agentEnvironment(profileId: typeof profile.id): Record<string, string> {
  const placeholder = "companyos-builder-broker-placeholder";
  const environment: Record<string, string> = {
    HOME: "/vercel/sandbox/home",
    LANG: "C.UTF-8",
    NO_BROWSER: "1",
    PATH: "/vercel/sandbox/worker/node_modules/.bin:/usr/local/bin:/usr/bin:/bin",
    TMPDIR: "/tmp",
  };
  if (profileId === "claude-code") environment.ANTHROPIC_API_KEY = placeholder;
  else {
    environment.CODEX_API_KEY = placeholder;
    environment.DEFAULT_AUTH_REQUEST = JSON.stringify({ methodId: "api-key" });
  }
  return environment;
}
