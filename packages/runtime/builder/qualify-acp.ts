import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isPathInsideBuilderWorkspace, runBuilderAcp } from "./acp-client.ts";
import { resolveBuilderAcpProfile } from "./profiles.ts";

const profile = resolveBuilderAcpProfile(process.argv[2] ?? "");
const repositoryRoot = process.cwd();
const executable = resolve(repositoryRoot, "packages", "builder-worker", "node_modules", ".bin", profile.binaryName);
const cwd = await mkdtemp(join(tmpdir(), `companyos-${profile.id}-qualification-`));

try {
  await writeFile(join(cwd, "fixture.txt"), "base\n", "utf8");
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["add", "fixture.txt"], { cwd });
  execFileSync(
    "git",
    ["-c", "user.name=CompanyOS Qualification", "-c", "user.email=qualification@example.invalid", "commit", "-qm", "base"],
    { cwd },
  );

  const evidence = await runBuilderAcp({
    launch: { profile, executable },
    cwd,
    prompt: [
      "This is a bounded CompanyOS ACP qualification fixture.",
      "Change only fixture.txt by replacing its complete content with exactly:",
      "changed-by-real-acp-agent",
      "Do not run tests, inspect parent directories, access the network directly, or change any other file.",
    ].join("\n"),
    timeoutMs: 120_000,
    environment: localAuthenticationEnvironment(),
    permissionPolicy: (permission) => {
      const locations = permission.toolCall.locations ?? [];
      const bounded = locations.length > 0
        && locations.every((location) => isPathInsideBuilderWorkspace(cwd, location.path));
      if (!bounded) return undefined;
      return permission.options.find((option) => option.kind === "allow_once")?.optionId;
    },
  });
  const diff = execFileSync("git", ["diff", "--no-ext-diff", "--", "fixture.txt"], { cwd, encoding: "utf8" });
  const summary = { evidence, diffObserved: diff.includes("+changed-by-real-acp-agent") };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!diff.includes("+changed-by-real-acp-agent")) {
    throw new Error("ACP qualification completed without the required independently observed diff.");
  }
} finally {
  await rm(cwd, { recursive: true, force: true });
}

function localAuthenticationEnvironment(): Record<string, string> {
  const allowed = ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "SHELL", "USER", "XDG_CONFIG_HOME", "XDG_DATA_HOME"];
  const environment: Record<string, string> = { NO_BROWSER: "1" };
  for (const name of allowed) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}
