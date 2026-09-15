import { constants, lstatSync, readdirSync, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { join } from "node:path";
import { assertBrainPath } from "./paths.ts";
import { BrainError } from "./contracts.ts";

/** Read-only operator input. Production repository access uses the bound adapter. */
export function readLocalBrainFilesSync(workspace: string): Record<string, string> {
  const result: Record<string, string> = {};
  const root = join(workspace, "brain");
  const walk = (directory: string, relative: string): void => {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new BrainError("invalid_file", "Brain directories must not be links.");
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = `${relative}/${item.name}`, full = join(directory, item.name);
      if (item.isDirectory()) {
        if (item.name.startsWith(".")) throw new BrainError("invalid_file", "Nested repository/configuration directories are not Brain content.");
        walk(full, path); continue;
      }
      assertBrainPath(path);
      const initial = lstatSync(full);
      if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1 || (initial.mode & 0o111)) throw new BrainError("invalid_file", "Brain files must be non-executable regular files without hardlinks.");
      // O_NOFOLLOW plus fstat checks the opened inode, including hardlink and execute bits.
      const handle = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(handle);
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o111) || stat.size > 400_000 || stat.ino !== initial.ino || stat.dev !== initial.dev) throw new BrainError("invalid_file", "Brain files must be bounded, non-executable regular files without hardlinks.");
        result[path] = readFileSync(handle, "utf8");
      } finally { closeSync(handle); }
    }
  };
  try { lstatSync(root); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  walk(root, "brain");
  return result;
}

export async function readLocalBrainFiles(workspace: string): Promise<Record<string, string>> { return readLocalBrainFilesSync(workspace); }
