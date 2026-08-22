#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(process.argv[2] ?? join(root, "dist", "release"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

if (existsSync(output) && readdirSync(output).length > 0) throw new Error(`Release output must be empty: ${output}`);
mkdirSync(output, { recursive: true });
if (git("status", "--porcelain=v1", "--untracked-files=all")) throw new Error("Release assets require a clean reviewed Core checkout.");

const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cliPackage = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8"));
const version = String(rootPackage.version ?? "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Root package.json must declare one exact semantic version.");
const packageManagerMatch = String(rootPackage.packageManager ?? "").match(/^pnpm@(\d+\.\d+\.\d+)\+sha512\.([0-9a-f]{128})$/);
if (!packageManagerMatch) throw new Error("Root package.json must pin pnpm as pnpm@<exact-version>+sha512.<integrity>.");
const pnpmVersion = packageManagerMatch[1];
const tag = git("describe", "--tags", "--exact-match", "HEAD");
if (tag !== `v${version}`) throw new Error(`Release tag '${tag}' does not match package version '${version}'.`);
const coreCommit = git("rev-parse", "HEAD");
const releasedAt = git("show", "-s", "--format=%cI", "HEAD");

const assetNames = ["INSTALL-COMPANYOS.md", "BOOTSTRAP_FOR_AGENTS.md"];
for (const name of assetNames) copyFileSync(join(root, name), join(output, name));

const manifest = {
  schema_version: 1,
  status: version.includes("-") ? "prerelease" : "stable",
  release_version: version,
  tag,
  core_repository: "oregano-os/oregano",
  core_commit: coreCommit,
  workbench_version: cliPackage.version,
  released_at: releasedAt,
  install_runbook: "INSTALL-COMPANYOS.md",
  supported_agent_harnesses: ["codex", "claude-code"],
  default_profile: "vercel-neon-slack",
  default_model: "openai/gpt-5.4-nano",
  requirements: { node: ">=24", pnpm: pnpmVersion, vercel_cli: "56.3.2", git: true },
  checksums: Object.fromEntries(assetNames.map((name) => [name, `sha256:${sha256(join(output, name))}`])),
};
writeFileSync(join(output, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`Prepared ${manifest.status} Oregano ${tag} assets in ${output}\n`);
for (const name of [...assetNames, "release-manifest.json"]) process.stdout.write(`${basename(name)}\n`);
