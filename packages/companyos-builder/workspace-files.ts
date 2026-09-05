import { readFileSync, readdirSync, lstatSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute, posix } from "node:path";
import YAML from "yaml";

export type WorkspaceFiles = Readonly<Record<string, string>>;

/** Capture bytes once. No subsequent compilation phase reopens Workspace files. */
export function readWorkspaceFiles(root: string): WorkspaceFiles {
  const files: Record<string, string> = {};
  const base = realpathSync(root);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", "node_modules", ".companyos-cache"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink() || lstatSync(path).isSymbolicLink()) throw new Error("Workspace declarations cannot use symlinks");
      const actual = realpathSync(path);
      const within = relative(base, actual);
      if (within.startsWith("../") || isAbsolute(within)) throw new Error("Workspace files cannot escape their root");
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files[relative(base, path).replaceAll("\\", "/")] = readFileSync(path, "utf8");
    }
  };
  visit(base);
  return Object.freeze(files);
}

export function workspaceFile(files: WorkspaceFiles, path: string): string {
  if (!path || posix.normalize(path) !== path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => ["..", ".git"].includes(part))) throw new Error("Workflow paths must remain inside the Workspace");
  if (!Object.hasOwn(files, path)) throw new Error(`Workspace file '${path}' does not exist`);
  return files[path]!;
}

export function workspaceDocument(files: WorkspaceFiles, path: string): { data: any; body: string } {
  const raw = workspaceFile(files, path);
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) return { data: null, body: raw };
  return { data: YAML.parse(match[1]!), body: raw.slice(match[0].length) };
}

export function workspacePaths(files: WorkspaceFiles, prefix: string, pattern: RegExp): string[] {
  return Object.keys(files).filter((path) => path.startsWith(`${prefix}/`) && pattern.test(path)).sort();
}
