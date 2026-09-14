import { BrainError } from "./contracts.ts";

const SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;
const ENTRYPOINT = /^(?:agents|claude|gemini|skill|config|configuration)\.md$/i;

/** Checks a repository-relative path, before reading or proposing any mutation. */
export function assertBrainPath(path: unknown): asserts path is string {
  if (typeof path !== "string" || path.length > 512 || !path.startsWith("brain/")
    || !path.endsWith(".md") || path.includes("\\") || path.includes("%")
    || path.split("/").some(part => !SEGMENT.test(part) || part === "." || part === "..")
    || ENTRYPOINT.test(path.split("/").at(-1)!)) {
    throw new BrainError("invalid_path", "Only ordinary knowledge Markdown paths beneath brain/ are permitted.");
  }
}

export function brainSlug(path: string): string { assertBrainPath(path); return path.slice(6, -3); }

export function normalizeBrainReference(value: string): string {
  let target = value.trim().replace(/^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/, "$1");
  target = target.split("#")[0].replace(/^brain\//, "").replace(/\.md$/, "");
  return target;
}

/** The Git mode is part of the boundary: Markdown names cannot hide links or code. */
export function assertBrainGitEntry(entry: { path: string; mode: string; type: string }): void {
  assertBrainPath(entry.path);
  if (entry.mode !== "100644" || entry.type !== "blob") {
    throw new BrainError("invalid_file", "Brain files must be non-executable regular Git blobs.");
  }
}
