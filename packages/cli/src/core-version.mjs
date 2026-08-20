import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireExactSemanticVersion } from "../../runtime/semantic-version.ts";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const packageMetadata = JSON.parse(readFileSync(join(sourceRoot, "..", "..", "..", "package.json"), "utf8"));

export const CORE_VERSION = requireExactSemanticVersion(packageMetadata.version, "Oregano Core package version");
