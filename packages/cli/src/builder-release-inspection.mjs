import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { classifyFiles, CLASS_RANK } from "./inspection.mjs";
import { readChangePlan, validateChangePlan } from "./change-plan.mjs";

/** A proposal cannot lower its own release class by editing governance. */
export function classifyBuilderRelease(root, baseCommit, paths) {
  const original = YAML.parse(execFileSync("git", ["show", `${baseCommit}:.companyos/governance.yaml`], { cwd: root, encoding: "utf8" }));
  const proposed = YAML.parse(readFileSync(join(root, ".companyos/governance.yaml"), "utf8"));
  const planMetadataPaths = new Set(paths.filter((path) => {
    if (!/^\.companyos\/changes\/[^/]+\.ya?ml$/.test(path)) return false;
    try { return readChangePlan(join(root, path))?.version === 3 && !validateChangePlan(join(root, path)).some((d) => d.severity === "error"); }
    catch { return false; }
  }));
  const classifications = [original, proposed].map((governance) => classifyFiles(paths, governance, { planMetadataPaths }));
  if (classifications.some((c) => c.classified.some((file) => !file.change_class))) throw new Error("Automated release requires every path to have an explicit governance class.");
  return classifications.map((c) => c.effective).sort((a, b) => CLASS_RANK[b] - CLASS_RANK[a])[0];
}
