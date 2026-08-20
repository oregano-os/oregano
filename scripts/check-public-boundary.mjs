import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([".git", ".next", ".pnpm-store", ".vercel", "dist", "node_modules"]);
const ignoredFiles = new Set(["scripts/check-public-boundary.mjs"]);
const forbiddenPaths = [
  /^private(?:\/|$)/i,
  /^spec(?:\/|$)/i,
  /^companies(?:\/|$)/i,
  /^docs\/assessments(?:\/|$)/i,
];
const forbiddenContent = [
  { label: "customer name", pattern: /isle(?:ñ|n)o/iu },
  { label: "customer domain", pattern: /isleno(?:-island-homes)?\.(?:es|monday\.com)/iu },
  { label: "private predecessor repository", pattern: /fylingpete\/oregano/iu },
  { label: "private migration path", pattern: /spec\/(?:aktuell|archiv)/iu },
  { label: "private decision log", pattern: /DECISIONS\.md/u },
  { label: "pilot deployment URL", pattern: /oregano-omega\.vercel\.app/iu },
];
const binaryExtensions = new Set([".docx", ".jpeg", ".jpg", ".pdf", ".png", ".pptx", ".xlsx"]);

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const violations = [];
for (const path of walk(root)) {
  const repositoryPath = relative(root, path).replaceAll("\\", "/");
  if (ignoredFiles.has(repositoryPath)) continue;
  if (forbiddenPaths.some((pattern) => pattern.test(repositoryPath))) {
    violations.push(`${repositoryPath}: forbidden public path`);
    continue;
  }

  const extension = repositoryPath.slice(repositoryPath.lastIndexOf(".")).toLowerCase();
  if (binaryExtensions.has(extension)) {
    violations.push(`${repositoryPath}: binary assets require explicit publication review`);
    continue;
  }

  if (statSync(path).size > 2_000_000) {
    violations.push(`${repositoryPath}: files larger than 2 MB require explicit publication review`);
    continue;
  }

  const content = readFileSync(path, "utf8");
  for (const check of forbiddenContent) {
    if (check.pattern.test(content)) violations.push(`${repositoryPath}: ${check.label}`);
  }
}

if (violations.length) {
  process.stderr.write(`Public boundary check failed:\n${violations.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Public boundary check passed.\n");
}
