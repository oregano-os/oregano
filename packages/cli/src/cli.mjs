#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { standardSetupMain } from "./setup-entry.mjs";
import { inspectBootstrap, verifyBootstrap } from "./bootstrap.mjs";
import { inspectCoreCheckout } from "./core-checkout.mjs";
import { verifyLiveWorkflow } from "./workflow-verification.mjs";
import {
  verifyLiveSetup,
} from "./live-setup.mjs";
import {
  advanceMondayAgentQualification,
  initializeMondayAgentQualification,
  planMondayAgentQualification,
  readMondayAgentQualificationState,
} from "./monday-agent-qualification.mjs";
import {
  applyRecordSourceMaterialization,
  inspectRecordSourceStatus,
  inspectRecordWorkspace,
  planRecordSourceMaterialization,
  planRecordSourceOperation,
  runRecordSourceOperation,
} from "./records-operations.mjs";
import {
  advanceRecordSourceConnect,
  initializeRecordSourceConnect,
  planRecordSourceConnect,
  readRecordSourceConnectState,
  recordSourceConnectRuntimeConfigurationValue,
} from "./record-source-connect.mjs";
import { checkGeneratedDocumentation, generateDocumentation, inspectDocumentation } from "./docs-control.mjs";
import { hasErrors, printDiagnostics } from "./diagnostics.mjs";
import { validateWorkspace } from "./workspace-validator.mjs";
import { validateChangePlan, writeChangePlan } from "./change-plan.mjs";
import { inspectWorkspace } from "./inspection.mjs";
import { inspectWorkspaceSecurity } from "./security.mjs";
import { inspectCore } from "./core-inspection.mjs";
import { inspectWorkspaceOnboarding } from "./onboarding.mjs";
import { inspectCompanyOSPackage } from "./package-inspector.mjs";
import {
  CREATE_WORKSPACE_QUESTIONS,
  createWorkspace,
  previewWorkspaceCreation,
  readCreateWorkspaceAnswers,
  suggestSlug,
  validateCreateWorkspaceField,
} from "./workspace-generator.mjs";
import { WORKBENCH_VERSION } from "./workbench-version.mjs";
import { CORE_VERSION } from "./core-version.mjs";
import { buildCompanyOSArtifact } from "../../companyos-builder/build.ts";
import { resolveWorkspaceInstanceConfiguration, WORKSPACE_INSTANCE_PATH } from "../../companyos-builder/instance-loader.ts";
import { findByCanonicalPrincipal, parseRoster } from "../../state-store/roster.ts";
import { bootstrapCompanyDatabase, inspectCompanyDatabaseState, prepareCompanyDatabase, qualifyCompanyDatabase, withNeonBranchDatabaseHost } from "../../state-postgres/database-bootstrap.ts";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(sourceRoot, "..", "..", "..");
const args = process.argv.slice(2);
const formatIndex = args.indexOf("--format");
const format = formatIndex >= 0 ? args[formatIndex + 1] : "human";
const positional = args.filter((arg, index) =>
  formatIndex < 0 || (index !== formatIndex && index !== formatIndex + 1));

const usage = `CompanyOS Workbench (experimental)

Usage:
  companyos --version
  companyos versions [workspace] [--format human|json]
  companyos docs check
  companyos docs generate
  companyos guide list
  companyos guide show <id>
  companyos plan --output <file> [--placement core|workspace|instance]
  companyos plan --check <file>
  companyos inspect [workspace] [--plan <file|auto>] [--base <git-ref>] [--format human|json]
  companyos inspect-core [--plan <file|auto>] [--base <git-ref>] [--format human|json]
  companyos validate [workspace] [--format human|json]
  companyos security [workspace] [--format human|json]
  companyos onboard [workspace] [--format human|json]
  companyos create workspace [--answers <yaml|json>] [--parent <directory>] [--preview|--confirm <hash>] [--format human|json]
  companyos bootstrap status [workspace] [--format human|json]
  companyos bootstrap verify [workspace] [--format human|json]
  companyos setup [--directory <setup-folder>] [--reply <json>] [--format human|json]
  companyos verify-live --state <file> [--scope starter|workflow] [--format human|json]
  companyos records source inspect --workspace <path> [--source <id>] [--format human|json]
  companyos records projection inspect --workspace <path> [--projection <id>] [--format human|json]
  companyos records source qualify --provider monday --workspace <path> --agent-id <id> --board-access <id>:read|read-write [--board-access <value>] --state <file> [--runtime-profile vercel-neon --runtime-scope <team> --runtime-project <project> --endpoint <preview-url>] --plan [--format human|json]
  companyos records source qualify --provider monday <same options> --apply <hash> [--format human|json]
  companyos records source qualify --provider monday --state <file> --resume [--provider-read-confirmation <hash>] [--identity-confirmation <hash>] [--format human|json]
  companyos records source qualify --provider monday --state <file> --status [--format human|json]
  companyos records source materialize --provider monday --workspace <path> --qualification <state> --board <id> --declaration <yaml|json> --output <records/sources/name.yaml> --plan [--format human|json]
  companyos records source materialize <same-options> --apply <hash> [--format human|json]
  companyos records source sync|reconcile --workspace <path> --source <id> --binding <file> --plan [--format human|json]
  companyos records source sync|reconcile <same-options> --apply <hash> [--format human|json]
  companyos records source status --workspace <path> --source <id> --binding <file> [--format human|json]
  companyos records source connect --profile vercel-neon --workspace <path> --source <id> --binding <file> --runtime-scope <scope> --runtime-project <project> --endpoint <preview-url>/api/records/rehearsal --state <file> --plan [--format human|json]
  companyos records source connect <same-options> --apply <hash> [--format human|json]
  companyos records source connect --state <file> --resume [--migration-confirmation <hash>] [--sync-confirmation <hash>] [--format human|json]
  companyos records source connect --state <file> --status [--show-preview-configuration] [--format human|json]
  companyos package inspect <path> [--format human|json]
  companyos database prepare [--format human|json]
  companyos database bootstrap [--format human|json]
  companyos database status [--format human|json]
  companyos database verify [--format human|json]
  companyos database branch-status --host <neon-host> [--format human|json]
  companyos database branch-prepare --host <neon-host> [--format human|json]
  companyos database branch-verify --host <neon-host> [--format human|json]
  companyos build <workspace> --output <file>
`;

const exitWithDiagnostics = (diagnostics, options) => {
  printDiagnostics(diagnostics, options);
  if (hasErrors(diagnostics)) process.exitCode = 1;
};

const targetWorkspace = (candidate) => {
  const target = candidate ?? process.env.COMPANY_DIR ?? process.cwd();
  if (!existsSync(join(resolve(target), "company.md"))) {
    throw new Error("No Company Workspace found. Pass a path or set COMPANY_DIR.");
  }
  return resolve(target);
};

const optionValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const optionValues = (name) => args.flatMap((arg, index) => arg === name && args[index + 1] ? [args[index + 1]] : []);

const readStructuredFile = (path) => {
  const raw = readFileSync(resolve(path), "utf8");
  return /\.json$/i.test(path) ? JSON.parse(raw) : YAML.parse(raw);
};

const printCreationPreview = (result) => {
  process.stdout.write("\nCompany Workspace preview:\n");
  process.stdout.write(`${YAML.stringify({
    company: result.preview.input.company_name,
    workspace_slug: result.preview.input.workspace_slug,
    working_language: result.preview.input.language,
    timezone: result.preview.input.timezone,
    workspace_steward: { name: result.preview.input.steward_name, id: result.preview.input.steward_id },
    github_codeowner: result.preview.input.codeowner,
    target: result.preview.target,
    workspace_mode: result.preview.workspace_mode,
    core: {
      repository: result.preview.core.repository,
      ref: result.preview.core.ref,
      workbench_version: result.preview.core.workbench_version,
      core_version: result.preview.core.core_version,
    },
    files: result.preview.paths,
    confirmation_hash: result.preview.confirmation_hash,
  })}\n`);
};

const askCreateWorkspaceAnswers = async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Interactive creation needs a terminal. Agent harnesses should use --answers with --preview, then --confirm <hash> after human confirmation.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answers = {};
  try {
    for (const item of CREATE_WORKSPACE_QUESTIONS) {
      let suggestion = "";
      if (item.field === "workspace_slug") suggestion = suggestSlug(answers.company_name);
      if (item.field === "language") suggestion = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).language;
      if (item.field === "timezone") suggestion = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (item.field === "steward_id") suggestion = suggestSlug(answers.steward_name);
      if (item.field === "target_directory") suggestion = `${answers.workspace_slug}-companyos`;
      while (true) {
        const response = await rl.question(`${item.question}${suggestion ? ` [${suggestion}]` : ""} `);
        const value = response.trim() || suggestion;
        const diagnostics = validateCreateWorkspaceField(item.field, value);
        if (diagnostics.length === 0) { answers[item.field] = value; break; }
        for (const entry of diagnostics) process.stdout.write(`${entry.message}\n`);
      }
    }
  } finally { rl.close(); }
  return answers;
};

const sourceGuideRoot = join(repoRoot, "docs", "workbench", "guides");
const packagedGuideRoot = join(sourceRoot, "..", "content", "guides");
const guideRoot = existsSync(sourceGuideRoot) ? sourceGuideRoot : packagedGuideRoot;
const guideMap = new Map(existsSync(guideRoot)
  ? readdirSync(guideRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => [entry.name.replace(/\.md$/, ""), join(guideRoot, entry.name)])
  : []);

try {
  const [command, action, value] = positional;
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${WORKBENCH_VERSION}\n`);
  } else if (!command || ["help", "--help", "-h"].includes(command)) {
    process.stdout.write(usage);
  } else if (command === "versions") {
    const target = targetWorkspace(action);
    const result = validateWorkspace(target);
    if (hasErrors(result.diagnostics)) {
      exitWithDiagnostics(result.diagnostics, { format, summary: result.summary });
    } else {
      const versions = {
        core: CORE_VERSION,
        workspace: result.summary.workspace_version,
        workbench: WORKBENCH_VERSION,
        companyos_spec: result.summary.specification,
      };
      if (format === "json") process.stdout.write(`${JSON.stringify(versions, null, 2)}\n`);
      else {
        process.stdout.write(`Oregano Core: ${versions.core}\n`);
        process.stdout.write(`Company Workspace: ${versions.workspace}\n`);
        process.stdout.write(`CompanyOS Workbench: ${versions.workbench}\n`);
        process.stdout.write(`CompanyOS specification: ${versions.companyos_spec}\n`);
      }
    }
  } else if (command === "docs") {
    const result = inspectDocumentation(repoRoot);
    if (action === "generate") {
      exitWithDiagnostics(result.diagnostics, { format, summary: "Documentation source check" });
      if (!hasErrors(result.diagnostics)) process.stdout.write(`Generated ${generateDocumentation(repoRoot, result.documents)} documentation artifact(s).\n`);
    } else if (action === "check") {
      const generated = checkGeneratedDocumentation(repoRoot, result.documents);
      exitWithDiagnostics([...result.diagnostics, ...generated], { format, summary: "Documentation control plane" });
    } else throw new Error("Use `companyos docs check` or `companyos docs generate`.");
  } else if (command === "guide") {
    if (action === "list" || !action) {
      process.stdout.write(`${[...guideMap.keys()].sort().join("\n")}\n`);
    } else if (action === "show" && guideMap.has(value)) {
      const { readFileSync } = await import("node:fs");
      process.stdout.write(readFileSync(guideMap.get(value), "utf8"));
    } else throw new Error(`Unknown Guide '${value ?? action}'. Run companyos guide list.`);
  } else if (command === "plan") {
    const outputIndex = args.indexOf("--output");
    const checkIndex = args.indexOf("--check");
    if (outputIndex >= 0) {
      const path = args[outputIndex + 1];
      if (!path) throw new Error("--output requires a path.");
      const placementIndex = args.indexOf("--placement");
      const placement = placementIndex >= 0 ? args[placementIndex + 1] : "workspace";
      if (!new Set(["core", "workspace", "instance"]).has(placement)) throw new Error("--placement must be core, workspace, or instance.");
      writeChangePlan(path, placement);
      process.stdout.write(`Created Change Plan: ${path}\n`);
    } else if (checkIndex >= 0) {
      const path = args[checkIndex + 1];
      if (!path) throw new Error("--check requires a path.");
      exitWithDiagnostics(validateChangePlan(path), { format, summary: "Change Plan" });
    } else {
      process.stdout.write("A formal Change Plan is required for behavior and security changes.\nUse --output <file> to create one or --check <file> to validate one.\n");
    }
  } else if (command === "validate") {
    const target = targetWorkspace(action);
    const result = validateWorkspace(target);
    exitWithDiagnostics(result.diagnostics, { format, summary: result.summary });
  } else if (command === "database") {
    if (!new Set(["prepare", "bootstrap", "status", "verify", "branch-status", "branch-prepare", "branch-verify"]).has(action)) throw new Error("Use a documented `companyos database` prepare, bootstrap, status, verify, or branch qualification action.");
    const branchAction = action?.startsWith("branch-");
    const branchHost = branchAction ? optionValue("--host") : undefined;
    if (branchAction && !branchHost) throw new Error(`companyos database ${action} requires --host <neon-host>.`);
    const databaseAction = branchAction ? action.slice("branch-".length) : action;
    const executeDatabaseAction = async () => {
      if (databaseAction === "status") return { ok: true, state: await inspectCompanyDatabaseState() };
      const preparation = databaseAction === "prepare" ? await prepareCompanyDatabase() : undefined;
      const qualification = preparation?.qualification ?? (databaseAction === "bootstrap" ? await bootstrapCompanyDatabase() : await qualifyCompanyDatabase());
      return { ok: true, operation: preparation?.operation ?? databaseAction, ...(preparation ? { previous_manifest_versions: preparation.previousManifestVersions } : {}), qualification };
    };
    if (databaseAction === "status") {
      const result = branchHost ? await withNeonBranchDatabaseHost(branchHost, executeDatabaseAction) : await executeDatabaseAction();
      process.stdout.write(`${JSON.stringify(result, null, format === "json" ? 2 : 0)}\n`);
    } else {
      const result = branchHost ? await withNeonBranchDatabaseHost(branchHost, executeDatabaseAction) : await executeDatabaseAction();
      process.stdout.write(`${JSON.stringify(result, null, format === "json" ? 2 : 0)}\n`);
    }
  } else if (command === "build") {
    if (args.some((arg) => arg === "--instance" || arg.startsWith("--instance="))) throw new Error("--instance is no longer supported. Commit .companyos/instance.yaml in the Company Workspace.");
    const target = targetWorkspace(action);
    const outputIndex = args.indexOf("--output");
    const outputPath = outputIndex >= 0 ? resolve(args[outputIndex + 1]) : undefined;
    if (!outputPath) throw new Error("companyos build requires --output <file>.");
    const git = (cwd, ...gitArgs) => execFileSync("git", gitArgs, { cwd, encoding: "utf8" }).trim();
    const coreCommit = git(repoRoot, "rev-parse", "HEAD");
    const workspaceCommit = git(target, "rev-parse", "HEAD");
    if (git(repoRoot, "status", "--porcelain") || git(target, "status", "--porcelain")) {
      throw new Error("CompanyOS build requires clean Core and Workspace checkouts so the recorded SHA pair is reproducible.");
    }
    const selectedInstance = resolveWorkspaceInstanceConfiguration(target);
    git(target, "ls-files", "--error-unmatch", WORKSPACE_INSTANCE_PATH);
    const artifact = buildCompanyOSArtifact({
      workspaceRoot: target,
      instance: selectedInstance.configuration,
      coreVersion: CORE_VERSION,
      coreCommit,
      workspaceCommit,
      workbenchVersion: WORKBENCH_VERSION,
    });
    if (existsSync(outputPath)) throw new Error("CompanyOS build output path must not already exist.");
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`Built CompanyOS artifact ${artifact.artifactHash} at ${outputPath}\n`);
  } else if (command === "inspect") {
    const planIndex = args.indexOf("--plan");
    const plan = planIndex >= 0 ? args[planIndex + 1] : undefined;
    const baseIndex = args.indexOf("--base");
    const base = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
    const target = targetWorkspace(action?.startsWith("--") ? undefined : action);
    const result = inspectWorkspace(target, plan, base);
    if (format === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      exitWithDiagnostics(result.diagnostics, { format, summary: "Architecture Fitness discovery" });
      process.stdout.write("\nRequired judgments:\n");
      result.report.required_judgments.forEach((question) => process.stdout.write(`- ${question}\n`));
    }
  } else if (command === "security") {
    const target = targetWorkspace(action);
    exitWithDiagnostics(inspectWorkspaceSecurity(target), { format, summary: "Workspace security" });
  } else if (command === "onboard") {
    const target = targetWorkspace(action);
    const result = inspectWorkspaceOnboarding(target);
    if (format === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      exitWithDiagnostics(result.diagnostics, { format, summary: result.summary });
      process.stdout.write("\nOnboarding checklist:\n");
      for (const item of result.checklist) process.stdout.write(`- ${item.status.toUpperCase()} ${item.id}: ${item.next}\n`);
    }
  } else if (command === "create") {
    if (action !== "workspace") throw new Error("Use `companyos create workspace`.");
    const answersPath = optionValue("--answers");
    const parentRoot = resolve(optionValue("--parent") ?? process.cwd());
    const previewOnly = args.includes("--preview");
    const confirmationHash = optionValue("--confirm");
    const confirmed = Boolean(confirmationHash);
    if (args.includes("--confirm") && !/^[0-9a-f]{64}$/.test(confirmationHash ?? "")) throw new Error("--confirm requires the 64-character hash from the successful preview.");
    if (previewOnly && confirmed) throw new Error("Use either --preview or --confirm, not both.");
    if (answersPath && !previewOnly && !confirmed) throw new Error("Agent answers-file mode requires --preview or --confirm <hash>.");
    if (!answersPath && confirmed) throw new Error("Interactive creation confirms its displayed preview in the terminal; do not pass --confirm.");

    const checkout = inspectCoreCheckout(repoRoot, { requireClean: true });
    if (hasErrors(checkout.diagnostics)) {
      if (format === "json") process.stdout.write(`${JSON.stringify({ ok: false, diagnostics: checkout.diagnostics, core: checkout.identity }, null, 2)}\n`);
      else exitWithDiagnostics(checkout.diagnostics, { format, summary: "Oregano Core checkout" });
    } else {
      const answers = answersPath ? readCreateWorkspaceAnswers(resolve(answersPath)) : await askCreateWorkspaceAnswers();
      const preview = previewWorkspaceCreation({ rawInput: answers, parentRoot, coreIdentity: checkout.identity });
      if (format === "json" && (previewOnly || !confirmed)) {
        process.stdout.write(`${JSON.stringify({ ok: !hasErrors(preview.diagnostics), ...preview }, null, 2)}\n`);
        if (hasErrors(preview.diagnostics)) process.exitCode = 1;
      } else if (hasErrors(preview.diagnostics)) {
        exitWithDiagnostics(preview.diagnostics, { format, summary: "Company Workspace preview" });
      } else if (previewOnly) {
        printCreationPreview(preview);
        process.stdout.write("\nPreview only: no Company Workspace was created.\n");
      } else {
        let apply = confirmed;
        if (!answersPath && !confirmed) {
          printCreationPreview(preview);
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try { apply = /^(?:y|yes)$/i.test((await rl.question("Create this authoring-only Company Workspace? [y/N] ")).trim()); }
          finally { rl.close(); }
        }
        if (!apply) {
          process.stdout.write("Cancelled: no Company Workspace was created.\n");
        } else {
          const result = createWorkspace({
            rawInput: answers,
            parentRoot,
            coreIdentity: checkout.identity,
            confirmationHash: confirmationHash ?? preview.preview.confirmation_hash,
          });
          if (format === "json") {
            process.stdout.write(`${JSON.stringify({ ok: result.created && !hasErrors(result.diagnostics), ...result }, null, 2)}\n`);
            if (!result.created || hasErrors(result.diagnostics)) process.exitCode = 1;
          } else if (!result.created || hasErrors(result.diagnostics)) {
            exitWithDiagnostics(result.diagnostics, { format, summary: "Company Workspace creation" });
          } else {
            process.stdout.write(`Created authoring-only Company Workspace: ${result.evidence.target}\n`);
            process.stdout.write("Run `companyos bootstrap verify <workspace>` for the local handoff report.\n");
          }
        }
      }
    }
  } else if (command === "bootstrap") {
    if (!new Set(["status", "verify"]).has(action)) throw new Error("Use `companyos bootstrap status [workspace]` or `companyos bootstrap verify [workspace]`.");
    const candidate = value?.startsWith("--") ? undefined : value;
    const result = action === "verify" ? verifyBootstrap(candidate) : inspectBootstrap(candidate);
    if (format === "json") {
      process.stdout.write(`${JSON.stringify({ ok: !hasErrors(result.diagnostics), ...result }, null, 2)}\n`);
      if (hasErrors(result.diagnostics)) process.exitCode = 1;
    } else {
      exitWithDiagnostics(result.diagnostics, { format, summary: action === "verify" ? "CompanyOS bootstrap verification" : "CompanyOS bootstrap status" });
      process.stdout.write(`\nState: ${result.summary.state}\n`);
      if (result.verification) process.stdout.write(`Scope: ${result.verification.scope}\n${result.verification.statement}\n`);
      process.stdout.write("\nBootstrap phases:\n");
      for (const phase of result.phases) process.stdout.write(`- ${String(phase.status).toUpperCase()} ${phase.id}: ${phase.next}\n`);
    }
  } else if (command === "records" && action === "source" && value !== "qualify") {
    const recordsAction = value;
    const workspacePath = optionValue("--workspace") ?? process.cwd();
    if (recordsAction === "connect") {
      const statePath = optionValue("--state");
      if (!statePath) throw new Error("Record source connect requires --state <outside-workspace-state-file>.");
      if (args.includes("--status")) {
        const state = readRecordSourceConnectState(resolve(statePath));
        const result = {
          ok: state.phase === "complete",
          state_path: resolve(statePath),
          phase: state.phase,
          profile: state.profile,
          source_id: state.source_id,
          configuration_digest: state.configuration_digest,
          expected_preview_environment: state.expected_preview_environment,
          evidence: state.evidence,
          ...(args.includes("--show-preview-configuration") ? { preview_configuration_gzip_base64: recordSourceConnectRuntimeConfigurationValue(state) } : {}),
        };
        if (format === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        else {
          process.stdout.write(`Record Source connect phase: ${state.phase}\nState: ${resolve(statePath)}\nProfile: ${state.profile}\nSource: ${state.source_id}\nConfiguration digest: ${state.configuration_digest}\n`);
          process.stdout.write(`${YAML.stringify({ expected_preview_environment: state.expected_preview_environment })}\n`);
          if (args.includes("--show-preview-configuration")) process.stdout.write(`COMPANYOS_RECORDS_REHEARSAL_CONFIG_GZIP_BASE64=${result.preview_configuration_gzip_base64}\n`);
          else process.stdout.write("Use --show-preview-configuration only in the operator terminal when setting the Preview-only Sensitive value; do not paste it into chat or Git.\n");
        }
      } else if (args.includes("--resume")) {
        const result = await advanceRecordSourceConnect({
          statePath: resolve(statePath),
          migrationConfirmation: optionValue("--migration-confirmation"),
          syncConfirmation: optionValue("--sync-confirmation"),
        });
        if (format === "json") process.stdout.write(`${JSON.stringify({ ok: result.status === "complete", ...result }, null, 2)}\n`);
        else {
          process.stdout.write(`Record Source connect phase: ${result.state.phase}\n${result.message}\n`);
          if (result.next_action) process.stdout.write(`${YAML.stringify({ next_action: result.next_action })}\n`);
          if (result.cleanup) process.stdout.write(`${YAML.stringify({ cleanup: result.cleanup })}\n`);
        }
      } else {
        const sourceId = optionValue("--source");
        const bindingPath = optionValue("--binding");
        if (!sourceId || !bindingPath || !optionValue("--runtime-scope") || !optionValue("--runtime-project") || !optionValue("--endpoint")) {
          throw new Error("Record source connect plan requires --workspace, --source, --binding, --runtime-scope, --runtime-project, --endpoint, and --state.");
        }
        const checkout = inspectCoreCheckout(repoRoot, { requireClean: true });
        const planResult = planRecordSourceConnect({
          workspaceRoot: workspacePath,
          sourceId,
          bindingPath,
          profile: optionValue("--profile") ?? "vercel-neon",
          endpoint: optionValue("--endpoint"),
          runtimeScope: optionValue("--runtime-scope"),
          runtimeProject: optionValue("--runtime-project"),
          statePath,
          coreIdentity: checkout.identity,
        });
        planResult.diagnostics = [...checkout.diagnostics, ...planResult.diagnostics];
        if (args.includes("--plan")) {
          if (format === "json") process.stdout.write(`${JSON.stringify({ ok: !hasErrors(planResult.diagnostics), plan: planResult.plan, diagnostics: planResult.diagnostics }, null, 2)}\n`);
          else {
            exitWithDiagnostics(planResult.diagnostics, { format, summary: "Company Records source connect plan" });
            if (!hasErrors(planResult.diagnostics)) process.stdout.write(`\n${YAML.stringify(planResult.plan)}\n`);
          }
        } else {
          const confirmationHash = optionValue("--apply");
          if (!confirmationHash) throw new Error("Use --plan first, then --apply <confirmation-hash>; initialization itself makes no external change.");
          const result = initializeRecordSourceConnect({ planResult, confirmationHash });
          if (format === "json") process.stdout.write(`${JSON.stringify({ ok: Boolean(result.state) && !hasErrors(result.diagnostics), state_path: result.statePath, phase: result.state?.phase, diagnostics: result.diagnostics }, null, 2)}\n`);
          else {
            exitWithDiagnostics(result.diagnostics, { format, summary: "Company Records source connect" });
            if (result.state) {
              process.stdout.write(`Initialized resumable state: ${result.statePath}\n`);
              process.stdout.write("No provider, database, deployment, or production effect was made. Run --status to review the exact Preview-only environment requirements, then --resume after those values and the protected Preview deployment exist.\n");
            }
          }
        }
      }
    } else if (recordsAction === "inspect") {
      const result = inspectRecordWorkspace({ workspaceRoot: workspacePath, sourceId: optionValue("--source") });
      if (format === "json") {
        process.stdout.write(`${JSON.stringify({ ok: !hasErrors(result.diagnostics), ...result }, null, 2)}\n`);
        if (hasErrors(result.diagnostics)) process.exitCode = 1;
      } else {
        exitWithDiagnostics(result.diagnostics, { format, summary: result.summary });
        if (!hasErrors(result.diagnostics)) process.stdout.write(`\n${YAML.stringify({ sources: result.sources, projections: result.projections })}\n`);
      }
    } else if (recordsAction === "materialize") {
      const provider = optionValue("--provider");
      const qualificationPath = optionValue("--qualification");
      const boardId = optionValue("--board");
      const declarationPath = optionValue("--declaration");
      const outputPath = optionValue("--output");
      if (!provider || !qualificationPath || !boardId || !declarationPath || !outputPath) {
        throw new Error("Record source materialization requires --provider, --workspace, --qualification, --board, --declaration, and --output.");
      }
      const planResult = planRecordSourceMaterialization({ workspaceRoot: workspacePath, provider, qualificationPath, boardId, declarationPath, outputPath });
      if (args.includes("--plan")) {
        if (format === "json") {
          process.stdout.write(`${JSON.stringify({ ok: !hasErrors(planResult.diagnostics), ...planResult }, null, 2)}\n`);
          if (hasErrors(planResult.diagnostics)) process.exitCode = 1;
        } else {
          exitWithDiagnostics(planResult.diagnostics, { format, summary: "Company Records source materialization plan" });
          if (!hasErrors(planResult.diagnostics)) process.stdout.write(`\n${YAML.stringify(planResult.plan)}\n`);
        }
      } else {
        const confirmationHash = optionValue("--apply");
        if (!confirmationHash) throw new Error("Use --plan first, then --apply <confirmation-hash> after reviewing the exact Workspace declaration.");
        const result = applyRecordSourceMaterialization({ planResult, confirmationHash });
        if (format === "json") {
          process.stdout.write(`${JSON.stringify({ ok: result.applied && !hasErrors(result.diagnostics), ...result }, null, 2)}\n`);
          if (!result.applied || hasErrors(result.diagnostics)) process.exitCode = 1;
        } else {
          exitWithDiagnostics(result.diagnostics, { format, summary: "Company Records source materialization" });
          if (result.applied) process.stdout.write(`\nCreated reviewed source declaration: ${result.output}\n`);
        }
      }
    } else if (new Set(["sync", "reconcile"]).has(recordsAction)) {
      const sourceId = optionValue("--source");
      const bindingPath = optionValue("--binding");
      if (!sourceId || !bindingPath) throw new Error(`Record source ${recordsAction} requires --workspace, --source, and --binding.`);
      const checkout = inspectCoreCheckout(repoRoot, { requireClean: true });
      const planResult = planRecordSourceOperation({
        workspaceRoot: workspacePath,
        sourceId,
        bindingPath,
        operation: recordsAction,
        coreIdentity: checkout.identity,
      });
      planResult.diagnostics = [...checkout.diagnostics, ...planResult.diagnostics];
      if (args.includes("--plan")) {
        if (format === "json") {
          process.stdout.write(`${JSON.stringify({ ok: !hasErrors(planResult.diagnostics), plan: planResult.plan, diagnostics: planResult.diagnostics }, null, 2)}\n`);
          if (hasErrors(planResult.diagnostics)) process.exitCode = 1;
        } else {
          exitWithDiagnostics(planResult.diagnostics, { format, summary: `Company Records source ${recordsAction} plan` });
          if (!hasErrors(planResult.diagnostics)) process.stdout.write(`\n${YAML.stringify(planResult.plan)}\n`);
        }
      } else {
        const confirmationHash = optionValue("--apply");
        if (!confirmationHash) throw new Error("Use --plan first, then --apply <confirmation-hash> after explicit human confirmation of the provider read and database write.");
        const result = await runRecordSourceOperation({ planResult, confirmationHash });
        if (format === "json") {
          process.stdout.write(`${JSON.stringify({ ok: result.applied && !hasErrors(result.diagnostics), ...result }, null, 2)}\n`);
          if (!result.applied || hasErrors(result.diagnostics)) process.exitCode = 1;
        } else {
          exitWithDiagnostics(result.diagnostics, { format, summary: `Company Records source ${recordsAction}` });
          if (result.applied) process.stdout.write(`\n${YAML.stringify({ receipt: result.receipt, provider_evidence: result.provider_evidence, credentials_retained: result.credentials_retained })}\n`);
        }
      }
    } else if (recordsAction === "status") {
      const sourceId = optionValue("--source");
      const bindingPath = optionValue("--binding");
      if (!sourceId || !bindingPath) throw new Error("Record source status requires --workspace, --source, and --binding.");
      const result = await inspectRecordSourceStatus({ workspaceRoot: workspacePath, sourceId, bindingPath });
      if (format === "json") {
        process.stdout.write(`${JSON.stringify({ ok: !hasErrors(result.diagnostics), ...result }, null, 2)}\n`);
        if (hasErrors(result.diagnostics)) process.exitCode = 1;
      } else {
        exitWithDiagnostics(result.diagnostics, { format, summary: "Company Records source status" });
        if (!hasErrors(result.diagnostics)) process.stdout.write(`\n${YAML.stringify({ binding: result.binding, status: result.status })}\n`);
      }
    } else {
      throw new Error("Use `companyos records source inspect|qualify|materialize|connect|sync|reconcile|status`.");
    }
  } else if (command === "records" && action === "projection") {
    if (value !== "inspect") throw new Error("Use `companyos records projection inspect`.");
    const result = inspectRecordWorkspace({ workspaceRoot: optionValue("--workspace") ?? process.cwd(), projectionId: optionValue("--projection") });
    if (format === "json") {
      process.stdout.write(`${JSON.stringify({ ok: !hasErrors(result.diagnostics), diagnostics: result.diagnostics, workspace: result.workspace, projections: result.projections, summary: result.summary }, null, 2)}\n`);
      if (hasErrors(result.diagnostics)) process.exitCode = 1;
    } else {
      exitWithDiagnostics(result.diagnostics, { format, summary: result.summary });
      if (!hasErrors(result.diagnostics)) process.stdout.write(`\n${YAML.stringify({ projections: result.projections })}\n`);
    }
  } else if (command === "records" && action === "source" && value === "qualify") {
    if (optionValue("--provider") !== "monday") throw new Error("Record source qualification currently requires --provider monday.");
    const statePath = optionValue("--state");
    if (args.includes("--status")) {
      if (!statePath) throw new Error("Monday qualification status requires --state <file>.");
      const state = readMondayAgentQualificationState(resolve(statePath));
      const result = { ok: state.phase === "complete", state_path: resolve(statePath), phase: state.phase, evidence: state.evidence, history: state.history };
      if (format === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(`Monday external-Agent qualification phase: ${state.phase}\n`);
        process.stdout.write(`State: ${resolve(statePath)}\n`);
        if (state.evidence?.discovery) process.stdout.write(`Discovery receipt: ${state.evidence.discovery.discovery_hash}\n`);
      }
    } else if (args.includes("--resume")) {
      if (!statePath) throw new Error("Monday qualification resume requires --state <file>.");
      const result = await advanceMondayAgentQualification({
        statePath,
        providerReadConfirmationHash: optionValue("--provider-read-confirmation"),
        identityConfirmationHash: optionValue("--identity-confirmation"),
      });
      if (format === "json") process.stdout.write(`${JSON.stringify({ ok: result.status === "complete", ...result }, null, 2)}\n`);
      else {
        exitWithDiagnostics(result.diagnostics, { format, summary: "Monday external-Agent qualification" });
        process.stdout.write(`\nPhase: ${result.state.phase}\n${result.message}\n`);
        if (result.next_action) process.stdout.write(`${YAML.stringify({ next_action: result.next_action })}\n`);
      }
    } else {
      const workspacePath = optionValue("--workspace");
      const agentId = optionValue("--agent-id");
      const boardAccesses = optionValues("--board-access");
      if (!workspacePath || !agentId || boardAccesses.length === 0 || !statePath) {
        throw new Error("Monday qualification planning and apply require --workspace <path>, --agent-id <id>, at least one --board-access <id>:read|read-write, and --state <file>.");
      }
      const checkout = inspectCoreCheckout(repoRoot, { requireClean: true });
      const planResult = planMondayAgentQualification({
        workspaceRoot: workspacePath,
        agentId,
        boardAccesses,
        statePath,
        coreIdentity: checkout.identity,
        runtimeProfile: optionValue("--runtime-profile"),
        endpoint: optionValue("--endpoint"),
        runtimeScope: optionValue("--runtime-scope"),
        runtimeProject: optionValue("--runtime-project"),
      });
      planResult.diagnostics = [...checkout.diagnostics, ...planResult.diagnostics];
      if (args.includes("--plan")) {
        if (format === "json") {
          process.stdout.write(`${JSON.stringify({ ok: !hasErrors(planResult.diagnostics), ...planResult }, null, 2)}\n`);
          if (hasErrors(planResult.diagnostics)) process.exitCode = 1;
        } else {
          exitWithDiagnostics(planResult.diagnostics, { format, summary: "Monday external-Agent qualification plan" });
          if (!hasErrors(planResult.diagnostics)) process.stdout.write(`\n${YAML.stringify(planResult.plan)}\n`);
        }
      } else {
        const confirmationHash = optionValue("--apply");
        if (!confirmationHash) throw new Error("Use --plan first, then --apply <confirmation-hash> after explicit human confirmation.");
        const initialized = initializeMondayAgentQualification({ planResult, confirmationHash });
        if (!initialized.state) {
          if (format === "json") process.stdout.write(`${JSON.stringify({ ok: false, ...initialized }, null, 2)}\n`);
          else exitWithDiagnostics(initialized.diagnostics, { format, summary: "Monday external-Agent qualification initialization" });
          process.exitCode = 1;
        } else {
          const result = await advanceMondayAgentQualification({
            statePath: initialized.statePath,
            providerReadConfirmationHash: optionValue("--provider-read-confirmation"),
            identityConfirmationHash: optionValue("--identity-confirmation"),
          });
          if (format === "json") process.stdout.write(`${JSON.stringify({ ok: result.status === "complete", ...result }, null, 2)}\n`);
          else {
            exitWithDiagnostics(result.diagnostics, { format, summary: "Monday external-Agent qualification" });
            process.stdout.write(`\nPhase: ${result.state.phase}\n${result.message}\n`);
            if (result.next_action) process.stdout.write(`${YAML.stringify({ next_action: result.next_action })}\n`);
          }
        }
      }
    }
  } else if (command === "setup") {
    if (args.some((arg) => arg === "--profile" || arg.startsWith("--profile="))) throw new Error("The legacy --profile setup flow is no longer supported. Use companyos setup for a new installation or resume its current setup session.");
    await standardSetupMain(args.slice(1), repoRoot);
  } else if (command === "verify-live") {
    const statePath = optionValue("--state");
    if (!statePath) throw new Error("verify-live requires --state <file>.");
    const scope = optionValue("--scope") ?? "starter";
    if (scope !== "starter" && scope !== "workflow") throw new Error("verify-live --scope must be starter or workflow.");
    const result = scope === "workflow" ? await verifyLiveWorkflow({ statePath }) : await verifyLiveSetup({ statePath });
    if (format === "json") {
      process.stdout.write(`${JSON.stringify({ ok: result.verification.ok, ...result }, null, 2)}\n`);
      if (!result.verification.ok) process.exitCode = 1;
    } else {
      exitWithDiagnostics(result.diagnostics, { format, summary: "Live CompanyOS verification" });
      process.stdout.write(`\nScope: ${result.verification.scope}\nReadiness: ${result.verification.readiness}\n${result.verification.statement}\n`);
    }
  } else if (command === "package") {
    if (action !== "inspect" || !value) throw new Error("Use `companyos package inspect <path>`.");
    const result = inspectCompanyOSPackage(value, repoRoot);
    if (format === "json") {
      process.stdout.write(`${JSON.stringify({ ok: !hasErrors(result.diagnostics), ...result }, null, 2)}\n`);
      if (hasErrors(result.diagnostics)) process.exitCode = 1;
    }
    else {
      exitWithDiagnostics(result.diagnostics, {
        format,
        summary: result.package
          ? { package: `${result.package.id}@${result.package.version}`, kind: result.package.kind, support: result.package.support }
          : "Package inspection",
      });
      if (result.package) {
        process.stdout.write(`Publisher: ${result.package.publisher}\n`);
        process.stdout.write(`License: ${result.package.license}\n`);
        process.stdout.write(`Components: ${result.package.components.length}\n`);
        process.stdout.write(`Trust tier: ${result.package.trust_tier}\n`);
        process.stdout.write(`CompanyOS spec: ${result.package.compatibility.companyos_spec} (Core ${result.package.compatibility.current_companyos_spec})\n`);
        process.stdout.write(`Installation: ${result.package.installation}\n`);
        process.stdout.write(`Activation: ${result.package.activation}\n`);
      }
    }
  } else if (command === "inspect-core") {
    const planIndex = args.indexOf("--plan");
    const plan = planIndex >= 0 ? args[planIndex + 1] : undefined;
    const baseIndex = args.indexOf("--base");
    const base = baseIndex >= 0 ? args[baseIndex + 1] : undefined;
    const result = inspectCore(repoRoot, plan, base);
    if (format === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      exitWithDiagnostics(result.diagnostics, { format, summary: "Core Architecture Fitness" });
      process.stdout.write("\nRequired judgments:\n");
      result.report.required_judgments.forEach((question) => process.stdout.write(`- ${question}\n`));
    }
  } else {
    throw new Error(`Unknown command '${command}'.\n\n${usage}`);
  }
} catch (error) {
  process.stderr.write(`companyos: ${error.message}\n`);
  process.exitCode = 1;
}
