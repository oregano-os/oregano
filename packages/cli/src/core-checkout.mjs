import { readFileSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { diagnostic } from "./diagnostics.mjs";
import { WORKBENCH_VERSION } from "./workbench-version.mjs";

const git = (root, args) => spawnSync("git", ["-C", root, ...args], {
  encoding: "utf8",
  windowsHide: true,
});

export const normalizeRepositoryIdentity = (remote) => {
  const value = String(remote ?? "").trim().replace(/\.git$/, "");
  const scp = value.match(/^[^@\s]+@[^:\s]+:([^/\s]+\/[^/\s]+)$/);
  if (scp) return scp[1];
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/^\//, "");
    return /^[^/\s]+\/[^/\s]+$/.test(path) ? path : null;
  } catch {
    return /^[^/\s]+\/[^/\s]+$/.test(value) ? value : null;
  }
};

export function inspectCoreCheckout(root, { requireClean = true } = {}) {
  const diagnostics = [];
  const requestedRoot = resolve(root);
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(requestedRoot);
  } catch {
    return {
      identity: null,
      diagnostics: [diagnostic("CORE001", "error", `Core checkout does not exist: ${requestedRoot}`)],
    };
  }

  const topLevel = git(canonicalRoot, ["rev-parse", "--show-toplevel"]);
  if (topLevel.status !== 0) {
    return {
      identity: null,
      diagnostics: [diagnostic("CORE002", "error", "The Workbench must run from a Git checkout of Oregano Core.")],
    };
  }
  let actualRoot;
  try { actualRoot = realpathSync(topLevel.stdout.trim()); }
  catch { actualRoot = resolve(topLevel.stdout.trim()); }
  if (actualRoot !== canonicalRoot) {
    diagnostics.push(diagnostic("CORE003", "error", `Expected the Oregano Core repository root '${canonicalRoot}', but Git resolved '${actualRoot}'.`));
  }

  const remoteResult = git(actualRoot, ["config", "--get", "remote.origin.url"]);
  const remote = remoteResult.status === 0 ? remoteResult.stdout.trim() : "";
  const repository = normalizeRepositoryIdentity(remote);
  if (!repository) {
    diagnostics.push(diagnostic("CORE004", "error", "Oregano Core needs an origin remote that resolves to an owner/repository identity."));
  }

  const headResult = git(actualRoot, ["rev-parse", "HEAD"]);
  const ref = headResult.status === 0 ? headResult.stdout.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(ref)) {
    diagnostics.push(diagnostic("CORE005", "error", "Oregano Core HEAD could not be resolved to one immutable 40-character commit."));
  }

  const statusResult = git(actualRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const dirtyEntries = statusResult.status === 0
    ? statusResult.stdout.split("\n").map((item) => item.trimEnd()).filter(Boolean)
    : [];
  if (statusResult.status !== 0) {
    diagnostics.push(diagnostic("CORE006", "error", "Oregano Core worktree status could not be inspected."));
  } else if (requireClean && dirtyEntries.length > 0) {
    diagnostics.push(diagnostic("CORE007", "error", "Oregano Core has uncommitted material changes. Bootstrap from a clean, reviewed release checkout so generated pins match the code that rendered the Workspace."));
  }

  let coreVersion = "";
  try {
    coreVersion = JSON.parse(readFileSync(join(actualRoot, "package.json"), "utf8")).version ?? "";
  } catch {
    diagnostics.push(diagnostic("CORE008", "error", "Oregano Core package metadata could not be read."));
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(coreVersion)) {
    diagnostics.push(diagnostic("CORE009", "error", "Oregano Core package.json must declare one exact semantic version."));
  }

  return {
    identity: {
      root: actualRoot,
      remote,
      repository,
      ref,
      core_version: coreVersion,
      workbench_version: WORKBENCH_VERSION,
      clean: dirtyEntries.length === 0,
      dirty_entries: dirtyEntries,
    },
    diagnostics,
  };
}
