import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { satisfies, validRange } from "semver";
import YAML from "yaml";
import { inspectCompatibilityRegistry } from "./compatibility-registry.mjs";
import { diagnostic } from "./diagnostics.mjs";
import { scanCredentialIndicators } from "../../security/credential-scanner.ts";

export const PACKAGE_MANIFEST = "companyos.package.yaml";

const PACKAGE_KINDS = new Set(["blueprint", "tool", "connector"]);
const COMPONENT_RULES = new Map([
  ["agents", {
    description: "an agents/<agent-id>/instructions.md entrypoint",
    accepts: (reference) => reference.startsWith("agents/") && basename(reference) === "instructions.md",
  }],
  ["workflows", {
    description: "a Markdown entrypoint under workflows/",
    accepts: (reference) => reference.startsWith("workflows/") && extname(reference).toLowerCase() === ".md",
  }],
  ["skills", {
    description: "a SKILL.md entrypoint in a skills directory",
    accepts: (reference) => basename(reference) === "SKILL.md" && reference.split("/").includes("skills"),
  }],
]);
const RUNTIME_EXTENSIONS = new Set([
  ".apk", ".app", ".bat", ".bash", ".c", ".cgi", ".cjs", ".class",
  ".cmd", ".com", ".cpp", ".cs", ".dart", ".deb", ".dll", ".dylib",
  ".exe", ".fs", ".fsx", ".go", ".groovy", ".jar", ".java", ".js",
  ".jsx", ".kt", ".kts", ".lua", ".mjs", ".msi", ".node", ".php",
  ".pl", ".pm", ".ps1", ".py", ".r", ".raku", ".rb", ".rpm", ".rs",
  ".scala", ".scr", ".sh", ".so", ".swift", ".ts", ".tsx", ".vb",
  ".vbs", ".wasm", ".zsh",
]);
const DECLARATIVE_TEXT_EXTENSIONS = new Set([
  ".csv", ".json", ".jsonl", ".md", ".toml", ".tsv", ".txt", ".yaml", ".yml",
]);
const DECLARATIVE_BINARY_EXTENSIONS = new Set([
  ".avif", ".gif", ".ico", ".jpeg", ".jpg", ".otf", ".png", ".ttf", ".webp", ".woff", ".woff2",
]);
const DECLARATIVE_EXTENSIONLESS_FILES = new Set(["LICENSE", "NOTICE"]);
const isMapping = (value) => value && typeof value === "object" && !Array.isArray(value);
const within = (root, candidate) => candidate === root || candidate.startsWith(`${root}${sep}`);
const portableRelative = (root, path) => path.slice(root.length + 1).split(sep).join("/");
const canonicalKey = (reference) => normalize(reference).split(sep).join("/").normalize("NFC").toLowerCase();

const schema = JSON.parse(readFileSync(new URL("./package-manifest.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateManifest = ajv.compile(schema);

const schemaLocation = (error) => {
  const suffix = error.keyword === "required"
    ? `/${error.params.missingProperty}`
    : error.keyword === "additionalProperties"
      ? `/${error.params.additionalProperty}`
      : "";
  return `${error.instancePath || "/"}${suffix}`.replaceAll("//", "/");
};

const inspectManifestSchema = (manifest, file) => {
  if (validateManifest(manifest)) return [];
  return [...(validateManifest.errors ?? [])]
    .sort((left, right) => `${schemaLocation(left)}:${left.keyword}`.localeCompare(`${schemaLocation(right)}:${right.keyword}`))
    .map((error) => diagnostic(
      "PKG023",
      "error",
      `Manifest schema violation at '${schemaLocation(error)}': ${error.message}.`,
      { file },
    ));
};

const validateRelativePath = (packageRoot, reference, diagnostics, file) => {
  if (typeof reference !== "string" || !reference || reference.includes("\0") || reference.includes("\\") || isAbsolute(reference)) {
    diagnostics.push(diagnostic("PKG012", "error", `Package path '${String(reference)}' must be a non-empty portable relative path.`, { file }));
    return null;
  }
  const normalized = normalize(reference);
  const portable = normalized.split(sep).join("/");
  if (portable !== reference || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    diagnostics.push(diagnostic("PKG013", "error", `Package path '${reference}' must be canonical and remain inside the Package root.`, { file }));
    return null;
  }
  const target = resolve(packageRoot, normalized);
  if (!within(packageRoot, target)) {
    diagnostics.push(diagnostic("PKG013", "error", `Package path '${reference}' escapes the Package root.`, { file }));
    return null;
  }
  if (!existsSync(target)) {
    diagnostics.push(diagnostic("PKG014", "error", `Referenced Package path '${reference}' does not exist.`, { file }));
    return null;
  }
  let stat;
  try { stat = lstatSync(target); }
  catch (error) {
    diagnostics.push(diagnostic("PKG014", "error", `Referenced Package path '${reference}' cannot be inspected: ${error.message}`, { file }));
    return null;
  }
  if (stat.isSymbolicLink()) {
    diagnostics.push(diagnostic("PKG015", "error", `Referenced Package path '${reference}' is a symbolic link.`, { file }));
    return null;
  }
  const real = realpathSync(target);
  if (!within(packageRoot, real)) {
    diagnostics.push(diagnostic("PKG013", "error", `Referenced Package path '${reference}' resolves outside the Package root.`, { file }));
    return null;
  }
  return { target, stat, canonical: canonicalKey(reference) };
};

const inspectCredentialIndicators = (path, relative, diagnostics) => {
  const content = readFileSync(path, "utf8");
  for (const finding of scanCredentialIndicators(content)) {
    diagnostics.push(diagnostic("PKG027", "error", `Blueprint Package contains a ${finding.label} indicator.`, { file: relative }));
  }
};

const inspectBlueprintTree = (packageRoot, diagnostics) => {
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const child = join(path, entry.name);
      const relative = portableRelative(packageRoot, child);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink()) {
        diagnostics.push(diagnostic("PKG015", "error", "Blueprint Packages cannot contain symbolic links.", { file: relative }));
      } else if (stat.isDirectory()) {
        if (entry.name.startsWith(".")) diagnostics.push(diagnostic("PKG026", "error", "Blueprint Packages cannot contain hidden control directories.", { file: relative }));
        else visit(child);
      } else if (!stat.isFile()) {
        diagnostics.push(diagnostic("PKG016", "error", "Blueprint Packages may contain only regular files and directories.", { file: relative }));
      } else {
        if (stat.nlink > 1) diagnostics.push(diagnostic("PKG017", "error", "Blueprint Packages cannot contain hard-linked files.", { file: relative }));
        const fileExtension = extname(entry.name).toLowerCase();
        if ((stat.mode & 0o111) !== 0 || RUNTIME_EXTENSIONS.has(fileExtension)) {
          diagnostics.push(diagnostic("PKG018", "error", "Blueprint Packages cannot contain executable runtime code.", { file: relative }));
          continue;
        }
        const allowedText = DECLARATIVE_TEXT_EXTENSIONS.has(fileExtension);
        const allowedBinary = DECLARATIVE_BINARY_EXTENSIONS.has(fileExtension);
        const allowedExtensionless = !fileExtension && DECLARATIVE_EXTENSIONLESS_FILES.has(entry.name);
        if (!allowedText && !allowedBinary && !allowedExtensionless) {
          diagnostics.push(diagnostic("PKG026", "error", "Blueprint Package file type is outside the declarative content allowlist.", { file: relative }));
        } else if (allowedText || allowedExtensionless) {
          inspectCredentialIndicators(child, relative, diagnostics);
        }
      }
    }
  };
  visit(packageRoot);
};

const claimReference = (claimed, reference, type, diagnostics, file) => {
  const key = canonicalKey(reference);
  const previous = claimed.get(key);
  if (previous) {
    diagnostics.push(diagnostic("PKG028", "error", `Package path '${reference}' duplicates canonical path '${previous.reference}' declared as ${previous.type}.`, { file }));
  } else claimed.set(key, { reference, type });
};

export function inspectCompanyOSPackage(inputRoot, coreRoot) {
  const requestedRoot = resolve(inputRoot);
  const diagnostics = [];

  if (!existsSync(requestedRoot)) {
    return { diagnostics: [diagnostic("PKG001", "error", "Package path does not exist.", { file: requestedRoot })], package: null };
  }
  const rootStat = lstatSync(requestedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { diagnostics: [diagnostic("PKG002", "error", "Package path must be a real directory, not a link or file.", { file: requestedRoot })], package: null };
  }
  const packageRoot = realpathSync(requestedRoot);
  const resolvedManifest = join(packageRoot, PACKAGE_MANIFEST);
  if (!existsSync(resolvedManifest)) {
    return { diagnostics: [diagnostic("PKG003", "error", `Package root does not contain ${PACKAGE_MANIFEST}.`, { file: resolvedManifest })], package: null };
  }
  const manifestStat = lstatSync(resolvedManifest);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    return { diagnostics: [diagnostic("PKG004", "error", `${PACKAGE_MANIFEST} must be a regular file, not a link.`, { file: resolvedManifest })], package: null };
  }

  let manifest;
  try { manifest = YAML.parse(readFileSync(resolvedManifest, "utf8")); }
  catch (error) {
    return { diagnostics: [diagnostic("PKG005", "error", `Package manifest cannot be parsed: ${error.message.split("\n")[0]}`, { file: resolvedManifest })], package: null };
  }
  if (!isMapping(manifest)) {
    return { diagnostics: [diagnostic("PKG006", "error", "Package manifest root must be a mapping.", { file: resolvedManifest })], package: null };
  }

  const schemaDiagnostics = inspectManifestSchema(manifest, resolvedManifest);
  if (schemaDiagnostics.length > 0) return { diagnostics: schemaDiagnostics, package: null };

  if (!manifest.id.startsWith(`${manifest.publisher.id}/`)) {
    diagnostics.push(diagnostic("PKG009", "error", "Package ID namespace must match publisher.id.", { file: resolvedManifest }));
  }

  const registry = coreRoot ? inspectCompatibilityRegistry(coreRoot) : { diagnostics: [], byKey: new Map() };
  diagnostics.push(...registry.diagnostics);
  const currentCompanyOSSpec = registry.registry?.companyos_spec?.current
    ? String(registry.registry.companyos_spec.current)
    : null;
  if (!coreRoot) diagnostics.push(diagnostic("PKG031", "error", "Package compatibility inspection requires an Oregano Core root.", { file: resolvedManifest }));

  const range = validRange(manifest.compatibility.companyos_spec);
  if (!range) {
    diagnostics.push(diagnostic("PKG024", "error", `Invalid CompanyOS specification range '${manifest.compatibility.companyos_spec}'.`, { file: resolvedManifest }));
  } else if (currentCompanyOSSpec && !satisfies(currentCompanyOSSpec, range)) {
    diagnostics.push(diagnostic("PKG025", "error", `Package requires CompanyOS specification '${manifest.compatibility.companyos_spec}', but this Core implements '${currentCompanyOSSpec}'.`, { file: resolvedManifest }));
  }
  if (coreRoot && !registry.byKey.has(`companyos.package-manifest@${manifest.compatibility.package_contract}`)) {
    diagnostics.push(diagnostic("PKG019", "error", `Unknown Package contract '${manifest.compatibility.package_contract}'.`, { file: resolvedManifest }));
  }

  const componentEntries = [];
  if (manifest.kind === "blueprint") {
    const claimedReferences = new Map();
    for (const [key, rule] of COMPONENT_RULES) {
      for (const reference of manifest.components[key]) {
        claimReference(claimedReferences, reference, `components.${key}`, diagnostics, resolvedManifest);
        const resolved = validateRelativePath(packageRoot, reference, diagnostics, resolvedManifest);
        if (!resolved) continue;
        if (!resolved.stat.isFile()) {
          diagnostics.push(diagnostic("PKG016", "error", `Component '${reference}' must identify a regular file.`, { file: resolvedManifest }));
        } else {
          if (!rule.accepts(reference)) {
            diagnostics.push(diagnostic("PKG029", "error", `${key.slice(0, -1)} Component '${reference}' must identify ${rule.description}.`, { file: resolvedManifest }));
          }
          componentEntries.push({ type: key.slice(0, -1), path: reference });
        }
      }
    }
    for (const fixture of manifest.tests.fixtures) {
      claimReference(claimedReferences, fixture, "tests.fixtures", diagnostics, resolvedManifest);
      const resolved = validateRelativePath(packageRoot, fixture, diagnostics, resolvedManifest);
      if (resolved && !resolved.stat.isFile()) diagnostics.push(diagnostic("PKG030", "error", `Fixture '${fixture}' must identify a regular file.`, { file: resolvedManifest }));
    }
    inspectBlueprintTree(packageRoot, diagnostics);

    const packageJson = join(packageRoot, "package.json");
    if (existsSync(packageJson)) {
      try {
        const metadata = JSON.parse(readFileSync(packageJson, "utf8"));
        if (isMapping(metadata.scripts) && Object.keys(metadata.scripts).length > 0) diagnostics.push(diagnostic("PKG021", "error", "Blueprint Packages cannot contain Package lifecycle scripts.", { file: "package.json" }));
      } catch (error) {
        diagnostics.push(diagnostic("PKG021", "error", `Blueprint package.json cannot be parsed: ${error.message}`, { file: "package.json" }));
      }
    }
  } else if (PACKAGE_KINDS.has(manifest.kind)) {
    diagnostics.push(diagnostic("PKG022", "warning", `${manifest.kind} Packages are recognized but not supported by this Inspector implementation.`, { file: resolvedManifest }));
  }

  const inspectionSupported = manifest.kind === "blueprint";
  return {
    diagnostics,
    package: {
      root: packageRoot,
      source: { kind: "local-directory", location: packageRoot },
      manifest: PACKAGE_MANIFEST,
      id: manifest.id,
      version: manifest.version,
      kind: manifest.kind,
      name: manifest.name,
      description: manifest.description,
      license: manifest.license,
      publisher: manifest.publisher.id,
      support: inspectionSupported ? "inspectable" : "recognized-unsupported",
      inspection: inspectionSupported ? "supported" : "recognition-only",
      installation: "not-implemented",
      activation: "not-implemented",
      trust_tier: manifest.kind === "blueprint" ? "declarative" : manifest.kind === "tool" ? "restricted" : "privileged",
      components: componentEntries,
      requires: manifest.requires,
      permissions: manifest.permissions,
      compatibility: {
        ...manifest.compatibility,
        current_companyos_spec: currentCompanyOSSpec,
        companyos_spec_satisfied: Boolean(range && currentCompanyOSSpec && satisfies(currentCompanyOSSpec, range)),
      },
    },
  };
}
