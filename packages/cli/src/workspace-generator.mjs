import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import YAML from "yaml";
import { diagnostic } from "./diagnostics.mjs";
import { inspectWorkspaceOnboarding } from "./onboarding.mjs";
import { inspectWorkspaceSecurity } from "./security.mjs";
import { validateWorkspace } from "./workspace-validator.mjs";

export const CREATE_WORKSPACE_FIELDS = [
  "company_name",
  "workspace_slug",
  "language",
  "timezone",
  "steward_name",
  "steward_id",
  "codeowner",
  "target_directory",
];

export const CREATE_WORKSPACE_QUESTIONS = [
  { field: "company_name", question: "What is the company's name?" },
  { field: "workspace_slug", question: "Which stable workspace slug should be used?" },
  { field: "language", question: "Which primary working language should the Company Workspace use?" },
  { field: "timezone", question: "Which IANA timezone should the Company Workspace use?" },
  { field: "steward_name", question: "Which accountable human is the initial Workspace Steward?" },
  { field: "steward_id", question: "Which stable member ID should identify the Workspace Steward?" },
  { field: "codeowner", question: "Which GitHub user or team should review protected Workspace paths?" },
  { field: "target_directory", question: "Which new directory should contain the Company Workspace?" },
];

export const GENERATED_WORKSPACE_PATHS = [
  ".companyos/changes/.gitkeep",
  ".companyos/compatibility.yaml",
  ".companyos/governance.yaml",
  ".companyos/repository-protection.yaml",
  ".github/CODEOWNERS",
  ".github/workflows/check.yml",
  ".gitignore",
  "AGENTS.md",
  "agents/builder/instructions.md",
  "company.md",
  "connections/.gitkeep",
  "handbook/index.md",
  "handbook/roster.md",
  "policies/data-retention.md",
  "policies/risk-levels.md",
  "schedules/.gitkeep",
  "workflows/.gitkeep",
].sort();

const hasErrors = (diagnostics) => diagnostics.some((item) => item.severity === "error");
const text = (value) => String(value ?? "").normalize("NFC").trim();
const document = (frontmatter, body) => `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n${body.trim()}\n`;

const normalizeCoreIdentity = (raw) => {
  const core = {
    repository: text(raw?.repository),
    ref: text(raw?.ref).toLowerCase(),
    core_version: text(raw?.core_version),
    workbench_version: text(raw?.workbench_version),
    clean: raw?.clean === true,
  };
  const diagnostics = [];
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(core.repository)) {
    diagnostics.push(diagnostic("GEN017", "error", "Core repository must be one owner/repository identity.", { field: "core.repository" }));
  }
  if (!/^[0-9a-f]{40}$/.test(core.ref)) {
    diagnostics.push(diagnostic("GEN018", "error", "Core ref must be one immutable 40-character Git commit.", { field: "core.ref" }));
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(core.workbench_version)) {
    diagnostics.push(diagnostic("GEN019", "error", "Workbench version must be one exact semantic version.", { field: "core.workbench_version" }));
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(core.core_version)) {
    diagnostics.push(diagnostic("GEN022", "error", "Core version must be one exact semantic version.", { field: "core.core_version" }));
  }
  if (!core.clean) {
    diagnostics.push(diagnostic("GEN020", "error", "Core checkout must be clean so the generated pin matches the reviewed renderer.", { field: "core.clean" }));
  }
  return { core, diagnostics };
};

export const suggestSlug = (value) => text(value)
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 63)
  .replace(/-+$/g, "");

const validateSingleLine = (value, field, label, diagnostics, { max = 120 } = {}) => {
  if (!value) diagnostics.push(diagnostic("GEN001", "error", `${label} is required.`, { field }));
  if (value.length > max) diagnostics.push(diagnostic("GEN002", "error", `${label} must be at most ${max} characters.`, { field }));
  if (/[\u0000-\u001f\u007f\r\n]/.test(value)) diagnostics.push(diagnostic("GEN003", "error", `${label} must be one line without control characters.`, { field }));
};

export function normalizeCreateWorkspaceInput(raw = {}) {
  const diagnostics = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      input: Object.fromEntries(CREATE_WORKSPACE_FIELDS.map((field) => [field, ""])),
      diagnostics: [diagnostic("GEN014", "error", "Workspace creation answers must be one YAML or JSON object.")],
    };
  }
  for (const field of Object.keys(raw)) {
    if (!CREATE_WORKSPACE_FIELDS.includes(field)) diagnostics.push(diagnostic("GEN015", "error", `Unknown Workspace creation field '${field}'.`, { field }));
  }
  for (const field of CREATE_WORKSPACE_FIELDS) {
    if (raw[field] !== undefined && typeof raw[field] !== "string") {
      diagnostics.push(diagnostic("GEN021", "error", `Workspace creation field '${field}' must be plain text.`, { field }));
    }
  }
  const normalized = Object.fromEntries(CREATE_WORKSPACE_FIELDS.map((field) => [field, text(raw[field])]));

  validateSingleLine(normalized.company_name, "company_name", "Company name", diagnostics);
  validateSingleLine(normalized.workspace_slug, "workspace_slug", "Workspace slug", diagnostics, { max: 63 });
  validateSingleLine(normalized.language, "language", "Working language", diagnostics, { max: 35 });
  validateSingleLine(normalized.timezone, "timezone", "Timezone", diagnostics, { max: 64 });
  validateSingleLine(normalized.steward_name, "steward_name", "Workspace Steward name", diagnostics);
  validateSingleLine(normalized.steward_id, "steward_id", "Workspace Steward ID", diagnostics, { max: 63 });
  validateSingleLine(normalized.codeowner, "codeowner", "GitHub CODEOWNER", diagnostics, { max: 100 });
  validateSingleLine(normalized.target_directory, "target_directory", "Target directory", diagnostics, { max: 80 });

  if (normalized.workspace_slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized.workspace_slug)) {
    diagnostics.push(diagnostic("GEN004", "error", "Workspace slug must contain lowercase letters, digits, and single hyphens only.", { field: "workspace_slug" }));
  }
  if (normalized.steward_id && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized.steward_id)) {
    diagnostics.push(diagnostic("GEN005", "error", "Workspace Steward ID must contain lowercase letters, digits, and single hyphens only.", { field: "steward_id" }));
  }
  if (normalized.language) {
    try { normalized.language = new Intl.Locale(normalized.language).toString(); }
    catch { diagnostics.push(diagnostic("GEN006", "error", "Working language must be a valid language tag such as 'en' or 'de'.", { field: "language" })); }
  }
  if (normalized.timezone) {
    try { new Intl.DateTimeFormat("en", { timeZone: normalized.timezone }).format(); }
    catch { diagnostics.push(diagnostic("GEN007", "error", "Timezone must be a valid IANA timezone such as 'Europe/Berlin'.", { field: "timezone" })); }
  }
  if (normalized.codeowner && !/^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9](?:[A-Za-z0-9_-]{0,99}))?$/.test(normalized.codeowner)) {
    diagnostics.push(diagnostic("GEN008", "error", "CODEOWNER must use GitHub syntax such as '@octocat' or '@company/workspace-stewards'.", { field: "codeowner" }));
  }
  if (normalized.target_directory && (
    normalized.target_directory !== basename(normalized.target_directory) ||
    normalized.target_directory === "." ||
    normalized.target_directory === ".." ||
    normalized.target_directory.startsWith(".") ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(normalized.target_directory)
  )) {
    diagnostics.push(diagnostic("GEN009", "error", "Target directory must be one new directory name, not a path.", { field: "target_directory" }));
  }

  return { input: normalized, diagnostics };
}

export function validateCreateWorkspaceField(field, value) {
  if (!CREATE_WORKSPACE_FIELDS.includes(field)) {
    return [diagnostic("GEN013", "error", `Unknown Workspace creation field '${field}'.`, { field })];
  }
  const valid = {
    company_name: "Example Company",
    workspace_slug: "example-company",
    language: "en",
    timezone: "UTC",
    steward_name: "Example Steward",
    steward_id: "example-steward",
    codeowner: "@example-steward",
    target_directory: "example-company-companyos",
  };
  valid[field] = value;
  return normalizeCreateWorkspaceInput(valid).diagnostics.filter((item) => item.field === field);
}

export function readCreateWorkspaceAnswers(path) {
  const raw = readFileSync(path, "utf8");
  if (path.endsWith(".json")) return JSON.parse(raw);
  return YAML.parse(raw);
}

export function renderWorkspace(input, coreIdentity) {
  const { company_name, workspace_slug, language, timezone, steward_name, steward_id, codeowner } = input;
  const core = {
    repository: coreIdentity.repository,
    ref: coreIdentity.ref,
    version: coreIdentity.core_version,
  };
  const files = new Map();

  files.set("company.md", document({
    name: company_name,
    slug: workspace_slug,
    type: "company",
    language,
    timezone,
    companyos_spec: "0.7-draft",
    workspace_version: "0.1.0",
    workspace_mode: "authoring-only",
  }, `# Company\n\nThis Company Workspace is the company's version-controlled operating model.\nIt begins in authoring-only mode and cannot run operating agents or workflows.`));

  files.set("AGENTS.md", `# Company Workspace agent entrypoint\n\nUse the pinned CompanyOS Workbench and follow its version-matched Guides.\nCreate a Change Plan for behavior or security changes, then run Inspection and\nValidation. Never add provider access, secrets, runtime code, or a weaker safety\nrule to this Workspace.\n`);

  files.set(".gitignore", `.env\n.env.*\n!.env.example\nnode_modules/\n.companyos-cache/\n.companyos-bootstrap/\n.vercel/\n.DS_Store\n`);
  files.set(".companyos/compatibility.yaml", YAML.stringify({
    version: 1,
    mode: "core-checkout",
    core,
    workbench: { version: coreIdentity.workbench_version },
  }));
  files.set(".companyos/governance.yaml", YAML.stringify({
    version: 1,
    review_mode: "steward",
    core_defaults: { may_only_tighten: true },
    roles: {
      workspace_stewards: [steward_id],
      process_stewards: {},
    },
    change_classes: {
      content: {
        paths: ["handbook/**", "agents/*/skills/**"],
        approval: "process-steward",
      },
      behavior: {
        paths: ["workflows/**", "schedules/**", "agents/*/instructions.md"],
        approval: "process-steward",
        change_plan: "required",
        inspection: "required",
      },
      security: {
        paths: ["policies/**", "handbook/roster.md", "agents/*/tools/**", "connections/**", ".companyos/**", ".github/**", "AGENTS.md", "company.md", ".gitignore", "package.json", "agents/builder/**"],
        approval: "workspace-steward",
        change_plan: "required",
        inspection: "required",
      },
    },
  }));
  files.set(".companyos/repository-protection.yaml", YAML.stringify({
    version: 1,
    provider: "github",
    target: { branch: "main" },
    rules: {
      require_pull_request: true,
      required_approvals: 0,
      require_code_owner_review: false,
      dismiss_stale_approvals: true,
      require_conversation_resolution: true,
      required_status_checks: ["check"],
      block_force_pushes: true,
      block_deletions: true,
      bypass: "none",
    },
    verification: {
      status: "pending",
      checked_at: null,
      checked_by: null,
    },
  }));

  const protectedPaths = [
    "/.companyos/", "/.github/", "/AGENTS.md", "/company.md", "/policies/",
    "/handbook/roster.md", "/connections/", "/agents/*/tools/", "/agents/builder/",
  ];
  files.set(".github/CODEOWNERS", `${protectedPaths.map((path) => `${path} ${codeowner}`).join("\n")}\n`);
  files.set(".github/workflows/check.yml", `name: companyos-check
on: [pull_request]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Check out Company Workspace
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Check out pinned Oregano Core
        uses: actions/checkout@v4
        with:
          repository: ${core.repository}
          ref: ${core.ref}
          path: .companyos-core
      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 11.16.0
      - name: Use Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
          cache-dependency-path: .companyos-core/pnpm-lock.yaml
      - name: Install pinned Workbench checkout
        working-directory: .companyos-core
        run: pnpm install --frozen-lockfile
      - name: Validate and inspect Company Workspace
        working-directory: .companyos-core
        run: |
          pnpm companyos validate "$GITHUB_WORKSPACE"
          pnpm companyos inspect "$GITHUB_WORKSPACE" --base origin/main --plan auto
          pnpm companyos security "$GITHUB_WORKSPACE"
          pnpm companyos onboard "$GITHUB_WORKSPACE"
`);

  files.set("handbook/index.md", document({
    type: "index",
    description: `Handbook index for ${company_name}.`,
  }, `# Handbook\n\n| File | What it holds |\n|---|---|\n| \`roster.md\` | accountable roles, identities, and approval rights |`));
  files.set("handbook/roster.md", document({
    type: "concept",
    description: `Accountable roles and identities for ${company_name}.`,
    members: [{
      role: "workspace-steward",
      id: steward_id,
      name: steward_name,
      status: "active",
      identities: { github: codeowner.slice(1) },
      may_approve: ["R1", "R2", "R3", "R4"],
      may_see: ["business", "personal"],
    }],
  }, `# Roster\n\nThe initial Workspace Steward is declared in this document's structured data.\nProvider identities must be verified through their provider before they\nauthorize a hosted change.`));
  files.set("policies/risk-levels.md", document({
    type: "concept",
    description: `Risk constitution for ${company_name}.`,
  }, `# Risk levels\n\n| Level | Meaning | Required behavior |\n|---|---|---|\n| R0 | Read and compute | Run and record evidence |\n| R1 | Internal artifact | Run and log |\n| R2 | Reversible internal change | Run and log |\n| R3 | External or irreversible effect | Wait for verified human approval |\n| R4 | Money, contracts, or people | Prepare only; a human decides |\n\nMissing risk declarations default to R3. Company policy may tighten Core rules\nbut never weaken them.`));
  files.set("policies/data-retention.md", document({
    type: "concept",
    description: `Initial data-retention policy for ${company_name}.`,
  }, `# Data retention\n\n1. Secrets and raw personal material never enter Git.\n2. Retention periods require an approved company decision before operating use.\n3. Identity history remains attributable; offboarding marks identities inactive.\n4. Provider deletion and backup behavior must be verified before activation.`));
  files.set("agents/builder/instructions.md", document({
    description: `Authoring-only Builder entrypoint for ${company_name}.`,
    scope: { read: ["company.md", "handbook/**", "policies/**"] },
    tools: [],
  }, `# Builder\n\nPropose bounded, reviewable Company Workspace changes through the CompanyOS\nWorkbench. This entrypoint has no operating Tool grants and no provider access.`));

  for (const path of [".companyos/changes/.gitkeep", "workflows/.gitkeep", "schedules/.gitkeep", "connections/.gitkeep"]) files.set(path, "");
  return files;
}

const inspectTarget = (parentRoot, targetDirectory) => {
  const diagnostics = [];
  let parent;
  try { parent = realpathSync(resolve(parentRoot)); }
  catch {
    return { parent: null, target: null, diagnostics: [diagnostic("GEN010", "error", `Selected parent directory does not exist: ${resolve(parentRoot)}`)] };
  }
  const target = join(parent, targetDirectory);
  if (dirname(target) !== parent) diagnostics.push(diagnostic("GEN011", "error", "Target directory escapes the selected parent."));
  if (existsSync(target)) {
    const kind = lstatSync(target);
    diagnostics.push(diagnostic("GEN012", "error", kind.isSymbolicLink()
      ? "Target directory is a symbolic link; refusing ambiguous placement."
      : "Target directory already exists; choose a new directory so creation remains atomic."));
  }
  return { parent, target, diagnostics };
};

const writeRenderedWorkspace = (root, files) => {
  for (const [relative, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
  }
};

const validateRenderedWorkspace = (root) => {
  const workspace = validateWorkspace(root);
  const security = inspectWorkspaceSecurity(root);
  const onboarding = inspectWorkspaceOnboarding(root);
  const diagnostics = [...workspace.diagnostics, ...security]
    .filter((item, index, all) => all.findIndex((candidate) => candidate.code === item.code && candidate.file === item.file && candidate.message === item.message) === index);
  return { workspace, security, onboarding, diagnostics };
};

export function previewWorkspaceCreation({ rawInput, parentRoot, coreIdentity }) {
  const normalized = normalizeCreateWorkspaceInput(rawInput);
  const normalizedCore = normalizeCoreIdentity(coreIdentity);
  const target = normalized.input.target_directory
    ? inspectTarget(parentRoot, normalized.input.target_directory)
    : { parent: null, target: null, diagnostics: [] };
  const diagnostics = [...normalized.diagnostics, ...normalizedCore.diagnostics, ...target.diagnostics];
  const preview = {
    input: normalized.input,
    target: target.target,
    core: normalizedCore.core,
    workspace_mode: "authoring-only",
    paths: GENERATED_WORKSPACE_PATHS,
  };
  preview.confirmation_hash = createHash("sha256").update(JSON.stringify({
    input: preview.input,
    target: preview.target,
    core: {
      repository: normalizedCore.core.repository,
      ref: normalizedCore.core.ref,
      core_version: normalizedCore.core.core_version,
      workbench_version: normalizedCore.core.workbench_version,
    },
    workspace_mode: preview.workspace_mode,
    paths: preview.paths,
  })).digest("hex");
  if (hasErrors(diagnostics) || !target.parent) return { preview, diagnostics, validation: null };

  const temporary = mkdtempSync(join(target.parent, ".companyos-preview-"));
  try {
    writeRenderedWorkspace(temporary, renderWorkspace(normalized.input, normalizedCore.core));
    const validation = validateRenderedWorkspace(temporary);
    return { preview, diagnostics: [...diagnostics, ...validation.diagnostics], validation };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function createWorkspace({ rawInput, parentRoot, coreIdentity, confirmationHash }) {
  const inspected = previewWorkspaceCreation({ rawInput, parentRoot, coreIdentity });
  if (hasErrors(inspected.diagnostics)) return { ...inspected, created: false, evidence: null };
  if (confirmationHash !== inspected.preview.confirmation_hash) {
    return {
      ...inspected,
      created: false,
      evidence: null,
      diagnostics: [...inspected.diagnostics, diagnostic("GEN016", "error", "Creation confirmation does not match the current preview. Preview again and confirm that exact result.")],
    };
  }

  const parent = realpathSync(resolve(parentRoot));
  const target = join(parent, inspected.preview.input.target_directory);
  if (existsSync(target)) {
    return {
      ...inspected,
      created: false,
      evidence: null,
      diagnostics: [...inspected.diagnostics, diagnostic("GEN012", "error", "Target directory appeared after preview; refusing to overwrite it.")],
    };
  }

  const temporary = mkdtempSync(join(parent, ".companyos-create-"));
  try {
    writeRenderedWorkspace(temporary, renderWorkspace(inspected.preview.input, inspected.preview.core));
    const validation = validateRenderedWorkspace(temporary);
    if (hasErrors(validation.diagnostics)) {
      return { ...inspected, validation, diagnostics: validation.diagnostics, created: false, evidence: null };
    }
    renameSync(temporary, target);
    return {
      ...inspected,
      validation,
      created: true,
      evidence: {
        target,
        workspace: inspected.preview.input.workspace_slug,
        workspace_mode: "authoring-only",
        core_repository: inspected.preview.core.repository,
        core_ref: inspected.preview.core.ref,
        core_version: inspected.preview.core.core_version,
        workbench_version: inspected.preview.core.workbench_version,
        paths: GENERATED_WORKSPACE_PATHS,
        local_readiness: validation.onboarding.summary.readiness,
      },
    };
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true });
  }
}
