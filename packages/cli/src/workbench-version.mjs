import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const packageMetadata = JSON.parse(readFileSync(join(sourceRoot, "..", "package.json"), "utf8"));

export const WORKBENCH_VERSION = packageMetadata.version;
