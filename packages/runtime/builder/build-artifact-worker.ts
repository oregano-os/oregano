import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCompanyOSArtifact } from "../../companyos-builder/build.ts";
import { resolveWorkspaceInstanceConfiguration, WORKSPACE_INSTANCE_PATH } from "../../companyos-builder/instance-loader.ts";
import { sha256 } from "../canonical.ts";
import YAML from "yaml";

interface BuildRequest { coreCommit: string; workspaceCommit: string; instanceId: string; configurationDigest: string; }
interface CoreProvenance { coreCommit: string; coreVersion: string; workbenchVersion: string; }

/** Compile the exact checked checkout, preserving the running Instance's release authority. */
export function compileWorkspaceArtifact(workspaceRoot: string, request: BuildRequest, provenance: CoreProvenance) {
  if (request.coreCommit !== provenance.coreCommit || !/^[a-f0-9]{40}$/.test(request.workspaceCommit)) throw new Error("Build image does not match the accepted Core.");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: workspaceRoot, encoding: "utf8" }).trim();
  if (git("rev-parse", "HEAD") !== request.workspaceCommit || git("status", "--porcelain")) throw new Error("Production build requires the exact clean merged Workspace.");
  const compatibility = YAML.parse(readFileSync(resolve(workspaceRoot, ".companyos/compatibility.yaml"), "utf8"));
  if (compatibility?.mode !== "core-checkout" || compatibility.core?.ref !== request.coreCommit
    || compatibility.core?.version !== provenance.coreVersion || compatibility.workbench?.version !== provenance.workbenchVersion) throw new Error("Workspace does not pin the accepted Core and Workbench.");
  const { configuration: instance } = resolveWorkspaceInstanceConfiguration(workspaceRoot);
  git("ls-files", "--error-unmatch", WORKSPACE_INSTANCE_PATH);
  if (instance.instanceId !== request.instanceId || instance.environment !== "production") throw new Error("Build target is not the accepted production Instance.");
  if (!/^[a-f0-9]{64}$/.test(request.configurationDigest) || sha256(instance) !== request.configurationDigest) throw new Error("Workspace Instance declaration differs from the running Artifact's accepted configuration.");
  const artifact = buildCompanyOSArtifact({ workspaceRoot, instance, ...provenance, workspaceCommit: request.workspaceCommit });
  return { artifact };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const coreRoot = resolve(import.meta.dirname, "../../..");
  const request = JSON.parse(readFileSync("/vercel/sandbox/input/build.json", "utf8"));
  const provenance = JSON.parse(readFileSync(resolve(coreRoot, "core-provenance.json"), "utf8"));
  const result = compileWorkspaceArtifact("/vercel/sandbox/workspace", request, provenance);
  writeFileSync("/vercel/sandbox/input/artifact.json", JSON.stringify(result), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ artifactHash: result.artifact.artifactHash }) + "\n");
}
