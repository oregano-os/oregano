import { createHash } from "node:crypto";
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
  { label: "private migration path", pattern: /spec\/(?:aktuell|archiv)/iu },
  { label: "private decision log", pattern: /DECISIONS\.md/u },
];
// The readable source values remain in the private publication-review repository.
const restrictedIdentifierFingerprints = new Set([
  "1076f1e1c136ba7b70f013ba0ed13b2298490d3f219b4157201f2d90046da9ac",
  "24ff0a83e2d8ca2514e3f560007e1e769784999c3be7dc8a029d09a972d97aac",
  "7d187cc819b6e0680924ad0f76f4723fc14078ae8d928e1a9483f2340d1d232e",
  "85e1180bb1fb610930cc8e9c0a8eb0dc5309f9918505e28f1a8f2888c6c84b1f",
  "9656ea11548ad5c3aee7fd6b57b8d31f0c3180de5926ce7d324e23d325d87268",
  "bf357c42f50ba54d46ca5fd2639357c638bd695fecd371151681531b0c9a48cd",
]);
const binaryExtensions = new Set([".docx", ".jpeg", ".jpg", ".pdf", ".png", ".pptx", ".xlsx"]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function identifierCandidates(content) {
  const normalized = content.normalize("NFKD").replace(/\p{Mark}/gu, "").toLowerCase();
  const candidates = new Set();
  for (const rawToken of normalized.match(/[a-z0-9][a-z0-9._/-]*/g) ?? []) {
    const token = rawToken.replace(/[._/-]+$/g, "");
    if (!token) continue;
    candidates.add(token);
    candidates.add(token.replace(/\.git$/u, ""));
    for (const component of token.split(/[._/-]+/u).filter(Boolean)) candidates.add(component);
    const pathParts = token.split("/").filter(Boolean);
    for (let start = 0; start < pathParts.length; start += 1) {
      for (let end = start + 1; end <= pathParts.length; end += 1) {
        const pathCandidate = pathParts.slice(start, end).join("/");
        candidates.add(pathCandidate);
        candidates.add(pathCandidate.replace(/\.git$/u, ""));
      }
    }
  }
  return candidates;
}

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
  if ([...identifierCandidates(content)].some((candidate) => restrictedIdentifierFingerprints.has(sha256(candidate)))) {
    violations.push(`${repositoryPath}: restricted private identifier fingerprint`);
  }
}

if (violations.length) {
  process.stderr.write(`Public boundary check failed:\n${violations.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Public boundary check passed.\n");
}
