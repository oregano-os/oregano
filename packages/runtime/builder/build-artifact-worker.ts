import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { buildCompanyOSArtifact } from "../../companyos-builder/build.ts";
import { loadInstanceBuildConfiguration } from "../../companyos-builder/instance-loader.ts";
import YAML from "yaml";
import { buildKnowledgeBundle } from "../../knowledge/okf.ts";

const coreRoot = resolve(import.meta.dirname, "../../..");
const request = JSON.parse(await readFile("/vercel/sandbox/input/build.json", "utf8"));
const provenance = JSON.parse(await readFile(resolve(coreRoot, "core-provenance.json"), "utf8"));
if (request.coreCommit !== provenance.coreCommit || !/^[a-f0-9]{40}$/.test(request.workspaceCommit)) throw new Error("Build image does not match the accepted Core.");
const workspaceRoot = "/vercel/sandbox/workspace";
const git = (...args: string[]) => execFileSync("git", args, { cwd: workspaceRoot, encoding: "utf8" }).trim();
if (git("rev-parse", "HEAD") !== request.workspaceCommit || git("status", "--porcelain")) throw new Error("Production build requires the exact clean merged Workspace.");
const compatibility = YAML.parse(await readFile(resolve(workspaceRoot, ".companyos/compatibility.yaml"), "utf8"));
if (compatibility?.mode !== "core-checkout" || compatibility.core?.ref !== request.coreCommit
  || compatibility.core?.version !== provenance.coreVersion || compatibility.workbench?.version !== provenance.workbenchVersion) throw new Error("Workspace does not pin the accepted Core and Workbench.");
const instance = loadInstanceBuildConfiguration("/vercel/sandbox/input/instance.yaml");
if (instance.instanceId !== request.instanceId || instance.environment !== "production") throw new Error("Build target is not the accepted production Instance.");
const artifact = buildCompanyOSArtifact({ workspaceRoot, instance, ...provenance, workspaceCommit: request.workspaceCommit });
const knowledgeBundle = buildKnowledgeBundle({ workspaceRoot, workspaceCommit: request.workspaceCommit });
await writeFile("/vercel/sandbox/input/artifact.json", JSON.stringify({ artifact, knowledgeBundle }), { mode: 0o600 });
process.stdout.write(JSON.stringify({ artifactHash: artifact.artifactHash }) + "\n");
