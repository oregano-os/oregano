#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setupReleaseMetadata } from "../packages/cli/src/setup/release-defaults.mjs";

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

copyFileSync(join(root, 'scripts/install-companyos.mjs'), join(output, 'install-companyos.mjs'));
assetNames.push('install-companyos.mjs');
const bundleDirectory = resolve(process.argv[3] ?? join(root, 'dist/setup-bundles'));
const setupBundles = {};
if (!existsSync(bundleDirectory)) throw new Error('Build the platform installer bundles before preparing release assets.');
for (const file of readdirSync(bundleDirectory).filter((name) => /^oregano-setup-[a-z0-9-]+\.json$/.test(name))) {
  const receipt = JSON.parse(readFileSync(join(bundleDirectory, file), 'utf8'));
  if (receipt.core_commit !== coreCommit || !/^[a-z0-9]+-[a-z0-9]+$/.test(receipt.platform)) throw new Error('Installer bundle does not match this release.');
  if (receipt.archive !== `oregano-setup-${receipt.platform}.tar.gz` || sha256(join(bundleDirectory, receipt.archive)) !== receipt.sha256) throw new Error('Installer bundle checksum mismatch.');
  copyFileSync(join(bundleDirectory, receipt.archive), join(output, receipt.archive));
  setupBundles[receipt.platform] = { asset: receipt.archive, sha256: receipt.sha256 };
  assetNames.push(receipt.archive);
}
if (Object.keys(setupBundles).length === 0) throw new Error('No platform installer bundles were supplied.');

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
  ...setupReleaseMetadata(),
  setup_bundles: setupBundles,
  setup_qualification: "pending-live-timing",
  requirements: { node: ">=24", pnpm: pnpmVersion, vercel_cli: "56.3.2", git: true },
  checksums: Object.fromEntries(assetNames.map((name) => [name, `sha256:${sha256(join(output, name))}`])),
};
writeFileSync(join(output, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`Prepared ${manifest.status} Oregano ${tag} assets in ${output}\n`);
for (const name of [...assetNames, "release-manifest.json"]) process.stdout.write(`${basename(name)}\n`);
