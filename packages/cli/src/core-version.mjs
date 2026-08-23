import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireExactSemanticVersion } from "../../runtime/semantic-version.ts";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const packageMetadata = JSON.parse(readFileSync(join(sourceRoot, "..", "..", "..", "package.json"), "utf8"));
const packageManagerMatch = String(packageMetadata.packageManager ?? "").match(/^pnpm@(\d+\.\d+\.\d+)\+sha512\.([0-9a-f]{128})$/);

if (!packageManagerMatch) {
  throw new Error("Oregano Core package.json must pin pnpm as pnpm@<exact-version>+sha512.<integrity>.");
}

export const CORE_VERSION = requireExactSemanticVersion(packageMetadata.version, "Oregano Core package version");
export const PACKAGE_MANAGER_SPEC = packageMetadata.packageManager;
export const PNPM_VERSION = requireExactSemanticVersion(packageManagerMatch[1], "Oregano pnpm version");
