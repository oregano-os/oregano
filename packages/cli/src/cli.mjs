#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { inspectBootstrap, verifyBootstrap } from "./bootstrap.mjs";
import { inspectCoreCheckout } from "./core-checkout.mjs";
import {
  advanceLiveSetup,
  initializeLiveSetup,
  LIVE_SETUP_PROFILE,
  planLiveSetup,
  readLiveSetupAnswers,
  readLiveSetupState,
  verifyLiveSetup,
} from "./live-setup.mjs";
import {
  advanceMondayQualification,
  initializeMondayQualification,
  planMondayQualification,
  readMondayQualificationState,
} from "./monday-qualification.mjs";
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
import { loadInstanceBuildConfiguration } from "../../companyos-builder/instance-loader.ts";
import { buildKnowledgeBundle, inspectKnowledgeWorkspace } from "../../knowledge/okf.ts";
import { inspectCurationInbox, proposeKnowledgePromotion } from "../../knowledge/curation.ts";
import { createPostgresKnowledgeProvider, decidePostgresKnowledgeReview, getPostgresKnowledgeReviewCandidate, listPersistedKnowledgeReviewCandidateIds, persistKnowledgeReviewCandidates, rebuildPostgresKnowledgeDerived } from "../../state-postgres/knowledge-store.ts";
import { InMemoryKnowledgeProvider } from "../../knowledge/in-memory-provider.ts";
import { runRetrievalRegression } from "../../knowledge/regression.ts";
import { loadKnowledgeSourceBinding, loadKnowledgeSourceRequirement, resolveEnvironmentSecret } from "../../knowledge/source-config.ts";
import { createMaintainedSourceConnectorRegistry } from "../../connectors/source-registry-maintained.ts";
import { PostgresKnowledgeSourceStore } from "../../state-postgres/knowledge-source-store.ts";
import { proposeSourcedKnowledgePromotion } from "../../knowledge/source-ingestion.ts";
import { PostgresSourcePipelineStore } from "../../state-postgres/source-pipeline-store.ts";
import { createPostgresInlineRawAssetStager } from "../../state-postgres/raw-asset-adapter.ts";
import { syncChangedSourceV2, syncPullSourceV2 } from "../../knowledge/source-sync-v2.ts";
import { ingestExactSourceInputV2, purgeSourceLifecycleDeletion, requestSourceLifecycleDeletion, restoreSourceLifecycleDeletion, setSourceLifecycleLegalHold } from "../../knowledge/source-ingestion-v2.ts";
import { cleanupExpiredSessionCorpus, transferSessionStopBuffer } from "../../knowledge/session-corpus.ts";
import { PostgresSessionCorpusStore } from "../../state-postgres/session-corpus-store.ts";
import { createRuntimeObservation, proposeRuntimeObservationPromotion, runtimeObservationsToReviewCandidates } from "../../knowledge/observations.ts";
import { findByCanonicalPrincipal, parseRoster } from "../../state-store/roster.ts";
import { bootstrapCompanyDatabase, inspectCompanyDatabaseState, prepareCompanyDatabase, qualifyCompanyDatabase, withNeonBranchDatabaseHost } from "../../state-postgres/database-bootstrap.ts";
import { KNOWLEDGE_ADMIN_GROUP_ID } from "../../knowledge/access-control.ts";
import { PostgresKnowledgeRetrievalV3Store, rebuildPostgresKnowledgeRetrievalProjectionV3 } from "../../state-postgres/knowledge-retrieval-v3-store.ts";
import { diagnosePostgresKnowledgeProductionFollowup, qualifyPostgresKnowledgeProductionCanary, verifyPostgresKnowledgeCanaryLive } from "../../state-postgres/knowledge-production-qualification.ts";

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
  companyos setup --profile vercel-neon-slack --workspace <path> --answers <yaml|json> --plan [--state <file>] [--format human|json]
  companyos setup --profile vercel-neon-slack --workspace <path> --answers <yaml|json> --apply <hash> [--state <file>] [--format human|json]
  companyos setup --profile vercel-neon-slack --state <file> --resume [--operating-confirmation <hash>] [--merge-confirmation <hash>] [--production-confirmation <hash>] [--format human|json]
  companyos setup --profile vercel-neon-slack --state <file> --status [--format human|json]
  companyos verify-live --state <file> [--format human|json]
  companyos monday qualify --workspace <path> --client-id <id> --redirect-uri <loopback-url> --board <id> [--board <id>] --state <file> --plan [--format human|json]
  companyos monday qualify --workspace <path> --client-id <id> --redirect-uri <loopback-url> --board <id> [--board <id>] --state <file> --apply <hash> [--format human|json]
  companyos monday qualify --state <file> --resume [--format human|json]
  companyos monday qualify --state <file> --status [--format human|json]
  companyos package inspect <path> [--format human|json]
  companyos database prepare [--format human|json]
  companyos database bootstrap [--format human|json]
  companyos database status [--format human|json]
  companyos database verify [--format human|json]
  companyos database branch-status --host <neon-host> [--format human|json]
  companyos database branch-prepare --host <neon-host> [--format human|json]
  companyos database branch-verify --host <neon-host> [--format human|json]
  companyos build <workspace> --instance <file> --output <file> [--knowledge-output <file>]
  companyos knowledge inspect <workspace> [--format human|json]
  companyos knowledge build <workspace> --output <file>
  companyos knowledge retrieval-v3-build [--format human|json]
  companyos knowledge retrieval-v3-status [--projection <hash>] [--format human|json]
  companyos knowledge retrieval-v3-qualify-production-canary --projection <hash> --environment <id> --company-instance <id> --agent <id> --state-project <id> --state-branch <id> --runtime-project <id> --rehearsal <receipt-id> --backup <receipt-id> --operator-approval <receipt-id> [--format human|json]
  companyos knowledge retrieval-v3-activate --projection <hash> --qualification <receipt-id> [--format human|json]
  companyos knowledge retrieval-v3-verify-live --projection <hash> --agent <id> [--format human|json]
  companyos knowledge retrieval-v3-diagnose-followup --projection <hash> --agent <id> [--format human|json]
  companyos knowledge review <workspace> [--format human|json]
  companyos knowledge decide <workspace> --candidate <id> --decision accepted|rejected|superseded --principal <principal>
  companyos knowledge propose <workspace> --candidate <id> --output <file> --principal <principal>
  companyos knowledge stage --bundle <file> [--format human|json]
  companyos knowledge verify --snapshot <hash> [--format human|json]
  companyos knowledge activate --snapshot <hash> [--format human|json]
  companyos knowledge rebuild --snapshot <hash> [--format human|json]
  companyos knowledge regression <workspace> --ledger <yaml|json> [--format human|json]
  companyos knowledge source verify|sync|health|revoke --requirement <file> --binding <file> [--workspace <path>] [--format human|json]
  companyos knowledge source ingest --requirement <file> --binding <file> --input <exact-file> --object <stable-id> --media-type <type>
  companyos knowledge source delete-request|delete-restore|legal-hold|delete-apply --requirement <file> --binding <file> --workspace <path> --principal <principal>
  companyos knowledge session transfer --input <exact-stop-buffer-json>
  companyos knowledge session cleanup [--now <iso>]
  companyos knowledge session archive --corpus <id> --requirement <file> --binding <file>
  companyos knowledge observation record --input <yaml|json> [--format human|json]
  companyos knowledge observation review [--persist] [--format human|json]
  companyos knowledge observation expire [--now <iso>] [--format human|json]
  companyos knowledge observation delete-request --observation <id> --principal <principal> --reason <text>
  companyos knowledge observation legal-hold --observation <id> --principal <principal> --enabled true|false
  companyos knowledge observation delete-apply --observation <id>
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

const knowledgeAdminSubject = (workspace, principal) => {
  if (!principal) throw new Error("This Knowledge review operation requires --principal <principal>.");
  const roster = parseRoster(readFileSync(join(workspace, "handbook", "roster.md"), "utf8"));
  const member = findByCanonicalPrincipal(roster, principal);
  if (!member || member.type === "agent" || !/^(?:active|aktiv)$/i.test(member.status)) {
    throw new Error(`Knowledge review principal '${principal}' is not an active human in handbook/roster.md.`);
  }
  if (!member.groups?.includes(KNOWLEDGE_ADMIN_GROUP_ID)) {
    throw new Error(`Knowledge review principal '${principal}' is not in the '${KNOWLEDGE_ADMIN_GROUP_ID}' group.`);
  }
  return { principalId: principal, principalType: "human", status: "active", groupIds: [...new Set([...(member.groups ?? []), "company:active"])].sort() };
};

const readStructuredFile = (path) => {
  const raw = readFileSync(resolve(path), "utf8");
  return /\.json$/i.test(path) ? JSON.parse(raw) : YAML.parse(raw);
};

const sourceConfiguration = (operation = "inspect") => {
  const requirementPath = optionValue("--requirement");
  const bindingPath = optionValue("--binding");
  if (!requirementPath || !bindingPath) throw new Error("Knowledge source commands require --requirement <file> and --binding <file>.");
  const requirement = loadKnowledgeSourceRequirement(resolve(requirementPath));
  const binding = loadKnowledgeSourceBinding(resolve(bindingPath), requirement);
  const registry = createMaintainedSourceConnectorRegistry({
    resolveSecret: resolveEnvironmentSecret,
    rawAssetStager: createPostgresInlineRawAssetStager(),
  });
  const resolution = registry.resolve({ requirement, binding, operation });
  return { requirement, binding, connector: resolution.connector, resolution };
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
  } else if (command === "knowledge") {
    if (action === "inspect") {
      const target = targetWorkspace(value?.startsWith("--") ? undefined : value);
      const result = inspectKnowledgeWorkspace({ workspaceRoot: target });
      const summary = result.bundle ? {
        ok: true,
        okf_version: result.bundle.okfVersion,
        bundle_hash: result.bundle.bundleHash,
        documents: result.bundle.documentCount,
        fragments: result.bundle.fragmentCount,
        diagnostics: result.diagnostics,
      } : { ok: false, diagnostics: result.diagnostics };
      if (format === "json") process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      else {
        for (const entry of result.diagnostics) process.stdout.write(`${entry.severity.toUpperCase()} ${entry.code} ${entry.path ?? "workspace"}: ${entry.message}\n`);
        if (result.bundle) process.stdout.write(`OKF ${result.bundle.okfVersion}: ${result.bundle.documentCount} document(s), ${result.bundle.fragmentCount} fragment(s), bundle ${result.bundle.bundleHash}\n`);
      }
      if (!result.bundle) process.exitCode = 1;
    } else if (action === "build") {
      const target = targetWorkspace(value?.startsWith("--") ? undefined : value);
      const output = optionValue("--output");
      if (!output) throw new Error("companyos knowledge build requires --output <file>.");
      const workspaceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: target, encoding: "utf8" }).trim();
      if (execFileSync("git", ["status", "--porcelain", "--", "."], { cwd: target, encoding: "utf8" }).trim()) {
        throw new Error("Company Knowledge build requires a clean Company Workspace so the recorded commit is reproducible.");
      }
      const bundle = buildKnowledgeBundle({ workspaceRoot: target, workspaceCommit });
      const outputPath = resolve(output);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, { flag: "wx" });
      process.stdout.write(`Built Company Knowledge bundle ${bundle.bundleHash} at ${outputPath}\n`);
    } else if (action === "review") {
      const target = targetWorkspace(value?.startsWith("--") ? undefined : value);
      const persist = args.includes("--persist");
      const provider = persist ? createPostgresKnowledgeProvider() : undefined;
      const currentBundle = buildKnowledgeBundle({ workspaceRoot: target, workspaceCommit: "review-preview" });
      const active = provider ? await provider.activeSnapshot() : undefined;
      const previousCandidateIds = persist ? await listPersistedKnowledgeReviewCandidateIds() : [];
      const candidates = inspectCurationInbox({ workspaceRoot: target, activeBundle: active?.bundle ?? currentBundle, previousCandidateIds });
      const inserted = persist ? await persistKnowledgeReviewCandidates(candidates) : 0;
      const result = { ok: true, mode: persist ? "persisted" : "preview", maximum_candidates: 3, inserted, candidates };
      if (format === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(`Review ${persist ? "queue" : "preview"}: ${candidates.length} candidate(s), maximum 3.${persist ? ` ${inserted} new candidate(s) persisted.` : " No Workspace files were changed."}\n`);
        for (const candidate of candidates) process.stdout.write(`- ${candidate.status.toUpperCase()} ${candidate.sourcePath} -> ${candidate.route}: ${candidate.reason}\n`);
      }
    } else if (action === "decide") {
      const target = targetWorkspace(value?.startsWith("--") ? undefined : value);
      const candidateId = optionValue("--candidate");
      const decision = optionValue("--decision");
      const decidedBy = optionValue("--principal");
      if (!candidateId || !new Set(["accepted", "rejected", "superseded"]).has(decision) || !decidedBy) {
        throw new Error("companyos knowledge decide requires --candidate <id> --decision accepted|rejected|superseded --principal <principal>.");
      }
      const subject = knowledgeAdminSubject(target, decidedBy);
      const candidate = await decidePostgresKnowledgeReview({
        candidateId,
        decision,
        decidedBy,
        decidedAt: new Date().toISOString(),
        note: optionValue("--note"),
      }, subject);
      process.stdout.write(`${JSON.stringify({ ok: true, candidate, next: decision === "accepted" ? "Create and review a Workspace diff; this decision does not publish or activate knowledge." : "Archive the reviewed outcome in the Company Workspace." }, null, format === "json" ? 2 : 0)}\n`);
    } else if (action === "propose") {
      const target = targetWorkspace(value?.startsWith("--") ? undefined : value);
      const candidateId = optionValue("--candidate");
      const output = optionValue("--output");
      const principal = optionValue("--principal");
      if (!candidateId || !output || !principal) throw new Error("companyos knowledge propose requires --candidate <id> --output <file> --principal <principal>.");
      const subject = knowledgeAdminSubject(target, principal);
      const candidate = await getPostgresKnowledgeReviewCandidate(candidateId, subject);
      if (!candidate) throw new Error(`Unknown Knowledge review candidate '${candidateId}'.`);
      const sourceStore = new PostgresKnowledgeSourceStore();
      let proposal;
      if (candidate.sourceObject) {
        const reference = candidate.sourceObject;
        const envelope = await sourceStore.getEnvelope(reference.sourceId, reference.providerObjectId, reference.providerVersion);
        if (!envelope) throw new Error(`Source envelope for candidate '${candidateId}' is missing or no longer current.`);
        proposal = proposeSourcedKnowledgePromotion({ candidate, envelope, destinationPath: optionValue("--destination") });
      } else if (candidate.runtimeObservationId) {
        const observation = await sourceStore.getObservation(candidate.runtimeObservationId);
        if (!observation) throw new Error(`Runtime Observation for candidate '${candidateId}' is missing.`);
        proposal = proposeRuntimeObservationPromotion({ candidate, observation, destinationPath: optionValue("--destination") });
      } else {
        proposal = proposeKnowledgePromotion({ workspaceRoot: target, candidate, destinationPath: optionValue("--destination") });
      }
      const outputPath = resolve(output);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(proposal, null, 2)}\n`, { flag: "wx" });
      process.stdout.write(`Wrote review-only Knowledge promotion proposal ${proposal.proposalId} at ${outputPath}\n`);
    } else if (action === "retrieval-v3-build") {
      const projection = await rebuildPostgresKnowledgeRetrievalProjectionV3();
      process.stdout.write(`${JSON.stringify({ ok: true, projection_hash: projection.projectionHash, unit_count: projection.unitCount, status: projection.status, embedding_profile: projection.embeddingProfile ?? null }, null, format === "json" ? 2 : 0)}\n`);
    } else if (action === "retrieval-v3-status") {
      const projectionHash = optionValue("--projection");
      const store = new PostgresKnowledgeRetrievalV3Store();
      const projection = projectionHash ? await store.projection(projectionHash) : await store.activeProjection();
      process.stdout.write(`${JSON.stringify({ ok: Boolean(projection), projection: projection ?? null }, null, format === "json" ? 2 : 0)}\n`);
      if (!projection) process.exitCode = 2;
    } else if (action === "retrieval-v3-qualify-production-canary") {
      const requiredOptions = {
        projectionHash: optionValue("--projection"),
        environmentId: optionValue("--environment"),
        companyInstanceId: optionValue("--company-instance"),
        allowedAgentId: optionValue("--agent"),
        stateProjectId: optionValue("--state-project"),
        stateBranchId: optionValue("--state-branch"),
        runtimeProjectId: optionValue("--runtime-project"),
        stateBranchRehearsalReceiptId: optionValue("--rehearsal"),
        databaseBackupReceiptId: optionValue("--backup"),
        operatorApprovalReceiptId: optionValue("--operator-approval"),
      };
      if (Object.values(requiredOptions).some((entry) => !entry)) {
        throw new Error("companyos knowledge retrieval-v3-qualify-production-canary requires exact projection, environment, Company Instance, Agent, Neon project/branch, Vercel project, rehearsal, backup, and operator-approval identities.");
      }
      const result = await qualifyPostgresKnowledgeProductionCanary(requiredOptions);
      process.stdout.write(`${JSON.stringify(result, null, format === "json" ? 2 : 0)}\n`);
      if (!result.ok) process.exitCode = 1;
    } else if (action === "retrieval-v3-activate") {
      const projectionHash = optionValue("--projection");
      const qualificationReceiptId = optionValue("--qualification");
      if (!projectionHash || !qualificationReceiptId) throw new Error("companyos knowledge retrieval-v3-activate requires --projection <hash> and --qualification <receipt-id>.");
      const projection = await new PostgresKnowledgeRetrievalV3Store().activateQualifiedProjection(projectionHash, qualificationReceiptId);
      process.stdout.write(`${JSON.stringify({ ok: true, projection_hash: projection.projectionHash, unit_count: projection.unitCount, status: projection.status }, null, format === "json" ? 2 : 0)}\n`);
    } else if (action === "retrieval-v3-verify-live") {
      const projectionHash = optionValue("--projection");
      const agentId = optionValue("--agent");
      if (!projectionHash || !agentId) throw new Error("companyos knowledge retrieval-v3-verify-live requires --projection <hash> and --agent <id>.");
      const result = await verifyPostgresKnowledgeCanaryLive({ projectionHash, agentId });
      process.stdout.write(`${JSON.stringify(result, null, format === "json" ? 2 : 0)}\n`);
      if (!result.ok) process.exitCode = 1;
    } else if (action === "retrieval-v3-diagnose-followup") {
      const projectionHash = optionValue("--projection");
      const agentId = optionValue("--agent");
      if (!projectionHash || !agentId) throw new Error("companyos knowledge retrieval-v3-diagnose-followup requires --projection <hash> and --agent <id>.");
      const result = await diagnosePostgresKnowledgeProductionFollowup({ projectionHash, agentId });
      process.stdout.write(`${JSON.stringify(result, null, format === "json" ? 2 : 0)}\n`);
    } else if (action === "stage") {
      const bundlePath = optionValue("--bundle");
      if (!bundlePath) throw new Error("companyos knowledge stage requires --bundle <file>.");
      const bundle = JSON.parse(readFileSync(resolve(bundlePath), "utf8"));
      const snapshot = await createPostgresKnowledgeProvider().stage(bundle);
      process.stdout.write(`${JSON.stringify({ ok: true, snapshot_hash: snapshot.snapshotHash, status: snapshot.status }, null, format === "json" ? 2 : 0)}\n`);
    } else if (action === "verify") {
      const snapshotHash = optionValue("--snapshot");
      if (!snapshotHash) throw new Error("companyos knowledge verify requires --snapshot <hash>.");
      const snapshot = await createPostgresKnowledgeProvider().verify(snapshotHash);
      process.stdout.write(`${JSON.stringify({ ok: true, snapshot_hash: snapshot.snapshotHash, status: snapshot.status }, null, format === "json" ? 2 : 0)}\n`);
    } else if (action === "activate") {
      const snapshotHash = optionValue("--snapshot");
      if (!snapshotHash) throw new Error("companyos knowledge activate requires --snapshot <hash>.");
      const snapshot = await createPostgresKnowledgeProvider().activate(snapshotHash);
      process.stdout.write(`${JSON.stringify({ ok: true, snapshot_hash: snapshot.snapshotHash, status: snapshot.status }, null, format === "json" ? 2 : 0)}\n`);
    } else if (action === "rebuild") {
      const snapshotHash = optionValue("--snapshot");
      if (!snapshotHash) throw new Error("companyos knowledge rebuild requires --snapshot <hash>.");
      const result = await rebuildPostgresKnowledgeDerived({ snapshotHash });
      process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, format === "json" ? 2 : 0)}\n`);
    } else if (action === "regression") {
      const target = targetWorkspace(value?.startsWith("--") ? undefined : value);
      const ledgerPath = optionValue("--ledger");
      if (!ledgerPath) throw new Error("companyos knowledge regression requires --ledger <yaml|json>.");
      const ledger = readStructuredFile(ledgerPath);
      if (ledger?.version !== 1 || !Array.isArray(ledger?.cases)) throw new Error("Retrieval regression ledger must declare version: 1 and a cases list.");
      const bundle = buildKnowledgeBundle({ workspaceRoot: target, workspaceCommit: "regression-preview" });
      const provider = new InMemoryKnowledgeProvider();
      await provider.stage(bundle); await provider.verify(bundle.bundleHash); await provider.activate(bundle.bundleHash);
      const result = await runRetrievalRegression(provider, ledger);
      process.stdout.write(`${JSON.stringify({ ok: result.passed, snapshot_hash: bundle.bundleHash, ...result }, null, 2)}\n`);
      if (!result.passed) process.exitCode = 1;
    } else if (action === "source") {
      const sourceAction = value;
      const lifecycleAction = ["delete-request", "delete-restore", "legal-hold", "delete-apply"].includes(sourceAction);
      const { requirement, binding, connector, resolution } = sourceConfiguration(lifecycleAction ? "inspect" : sourceAction === "ingest" ? "sync" : sourceAction);
      if (!("descriptor" in connector)) throw new Error("The maintained Source registry did not resolve a Source Connector 2.0 implementation.");
      if (sourceAction === "verify") {
        const result = await connector.verify();
        process.stdout.write(`${JSON.stringify({ ...result, resolution_receipt: resolution.receipt }, null, 2)}\n`);
      } else if (sourceAction === "health") {
        const provider = await connector.health();
        const result = {
          ok: provider.ok,
          sourceId: requirement.sourceId,
          resolution: resolution.receipt,
          provider,
          persistence: process.env.DATABASE_URL
            ? { status: "available", note: "Durable event and watermark evidence is evaluated during synchronization." }
            : { status: "unavailable", reason: "DATABASE_URL is not set; durable state could not be evaluated." },
        };
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (!result.ok) process.exitCode = 1;
      } else if (sourceAction === "ingest") {
        const inputPath = optionValue("--input");
        const objectId = optionValue("--object");
        const mediaType = optionValue("--media-type");
        if (!inputPath || !objectId || !mediaType) throw new Error("companyos knowledge source ingest requires --input, --object, and --media-type.");
        const exactPath = resolve(inputPath);
        if (!statSync(exactPath).isFile()) throw new Error("Local Source ingestion accepts exactly one regular file, never a directory or crawl root.");
        const store = new PostgresSourcePipelineStore();
        await store.registerSource(resolution.normalizedRequirement, resolution.normalizedBinding);
        await store.putReceipt(resolution.receipt);
        const result = await ingestExactSourceInputV2({
          exactInput: { providerObjectId: objectId, mediaType, bytes: readFileSync(exactPath), observedAt: optionValue("--observed-at") ?? new Date().toISOString() },
          requirement: resolution.normalizedRequirement,
          connector,
          store,
          workerId: `cli:${process.pid}`,
        });
        process.stdout.write(`${JSON.stringify({ ok: ["processed", "quarantined", "duplicate"].includes(result.outcome), source_id: requirement.sourceId, object_id: objectId, result }, null, 2)}\n`);
        if (!["processed", "quarantined", "duplicate"].includes(result.outcome)) process.exitCode = 1;
      } else if (sourceAction === "sync") {
        const target = targetWorkspace(optionValue("--workspace"));
        const store = new PostgresSourcePipelineStore();
        await store.registerSource(resolution.normalizedRequirement, resolution.normalizedBinding);
        await store.putReceipt(resolution.receipt);
        const result = resolution.normalizedRequirement.deliveryMode === "pull" && connector.enumerate
          ? await syncPullSourceV2({
              connector,
              store,
              requirement: resolution.normalizedRequirement,
              binding: resolution.normalizedBinding,
              workerId: `cli:${process.pid}`,
            })
          : await syncChangedSourceV2({
              connector,
              store,
              requirement: resolution.normalizedRequirement,
              workerId: `cli:${process.pid}`,
            });
        process.stdout.write(`${JSON.stringify({ ok: result.complete, workspace: target, connector_resolution: resolution.receipt, ...result }, null, 2)}\n`);
        if (!result.complete) process.exitCode = 1;
      } else if (sourceAction === "revoke") {
        const store = new PostgresSourcePipelineStore();
        await store.registerSource(resolution.normalizedRequirement, resolution.normalizedBinding);
        const receipt = await connector.revoke();
        await store.putReceipt(receipt);
        await store.setSourceStatus(requirement.sourceId, "revoked");
        process.stdout.write(`${JSON.stringify({ ok: true, source_id: requirement.sourceId, resolution_receipt_id: resolution.receipt.receiptId, receipt_id: receipt.receiptId, status: "revoked" }, null, 2)}\n`);
      } else if (lifecycleAction) {
        const target = targetWorkspace(optionValue("--workspace"));
        const principal = optionValue("--principal");
        if (!principal) throw new Error(`companyos knowledge source ${sourceAction} requires --principal <principal>.`);
        const subject = knowledgeAdminSubject(target, principal);
        const store = new PostgresSourcePipelineStore();
        if (sourceAction === "delete-request") {
          const objectId = optionValue("--object");
          const reason = optionValue("--reason");
          if (!objectId || !reason) throw new Error("companyos knowledge source delete-request requires --object <provider-object-id> and --reason <text>.");
          const evidence = await store.currentRawEvidence(requirement.sourceId, objectId);
          if (!evidence) throw new Error(`Unknown current Source Object '${objectId}'.`);
          const request = await requestSourceLifecycleDeletion({
            store,
            sourceId: requirement.sourceId,
            targetKind: "source-object",
            targetId: objectId,
            targetVersion: optionValue("--version") ?? evidence.envelope.providerVersion,
            requestedBy: subject.principalId,
            reason,
            accessPolicyId: evidence.envelope.accessPolicyId,
            connectorId: connector.descriptor.connectorId,
            connectorVersion: connector.descriptor.connectorVersion,
          });
          process.stdout.write(`${JSON.stringify({ ok: true, request }, null, 2)}\n`);
        } else {
          const requestId = optionValue("--request");
          if (!requestId) throw new Error(`companyos knowledge source ${sourceAction} requires --request <request-id>.`);
          if (sourceAction === "delete-restore") {
            const result = await restoreSourceLifecycleDeletion({ store, requestId, connectorId: connector.descriptor.connectorId, connectorVersion: connector.descriptor.connectorVersion });
            process.stdout.write(`${JSON.stringify({ ok: result === "restored" || result === "unchanged", request_id: requestId, result, principal: subject.principalId }, null, 2)}\n`);
          } else if (sourceAction === "legal-hold") {
            const enabled = optionValue("--enabled");
            if (!new Set(["true", "false"]).has(enabled)) throw new Error("companyos knowledge source legal-hold requires --enabled true|false.");
            const result = await setSourceLifecycleLegalHold({ store, requestId, enabled: enabled === "true", actor: subject.principalId, connectorId: connector.descriptor.connectorId, connectorVersion: connector.descriptor.connectorVersion });
            process.stdout.write(`${JSON.stringify({ ok: result === "updated" || result === "unchanged", request_id: requestId, result, principal: subject.principalId }, null, 2)}\n`);
          } else {
            const result = await purgeSourceLifecycleDeletion({ store, requestId, connectorId: connector.descriptor.connectorId, connectorVersion: connector.descriptor.connectorVersion });
            process.stdout.write(`${JSON.stringify({ ok: result === "purged" || result === "unchanged", request_id: requestId, result, principal: subject.principalId }, null, 2)}\n`);
          }
        }
      } else throw new Error("Use `companyos knowledge source verify|sync|ingest|health|revoke|delete-request|delete-restore|legal-hold|delete-apply`.");
    } else if (action === "session") {
      const sessionAction = value;
      const corpusStore = new PostgresSessionCorpusStore();
      if (sessionAction === "transfer") {
        const inputPath = optionValue("--input");
        if (!inputPath) throw new Error("companyos knowledge session transfer requires --input <exact-stop-buffer-json>.");
        const exactPath = resolve(inputPath);
        if (!statSync(exactPath).isFile()) throw new Error("Session transfer accepts exactly one regular stop-buffer file.");
        const buffer = JSON.parse(readFileSync(exactPath, "utf8"));
        const result = await transferSessionStopBuffer({
          buffer,
          corpusStore,
          stopBufferStore: { remove: async (bufferId) => {
            if (bufferId !== buffer.bufferId) return false;
            unlinkSync(exactPath);
            return true;
          } },
        });
        process.stdout.write(`${JSON.stringify({ ok: true, corpus_id: result.corpus.corpusId, receipt_id: result.receipt.receiptId, stop_buffer_removed: true }, null, 2)}\n`);
      } else if (sessionAction === "cleanup") {
        const result = await cleanupExpiredSessionCorpus({ corpusStore, now: optionValue("--now") });
        process.stdout.write(`${JSON.stringify({ ok: true, expired: result.expired, receipt_id: result.receipt.receiptId }, null, 2)}\n`);
      } else if (sessionAction === "archive") {
        const corpusId = optionValue("--corpus");
        if (!corpusId) throw new Error("companyos knowledge session archive requires --corpus <id>.");
        const corpus = await corpusStore.getCorpus(corpusId);
        if (!corpus || corpus.lifecycleStatus !== "active" || !corpus.content) throw new Error(`Active Session Corpus '${corpusId}' is unavailable.`);
        const { connector, resolution } = sourceConfiguration("sync");
        if (!("descriptor" in connector) || !connector.stageExactInput) throw new Error("Session archive requires an exact-input Source Connector 2.0 implementation.");
        if (resolution.normalizedRequirement.retention.mode !== "retain") throw new Error("Explicit Session archive requires a durable retain Source policy.");
        const sourceStore = new PostgresSourcePipelineStore();
        await sourceStore.registerSource(resolution.normalizedRequirement, resolution.normalizedBinding);
        await sourceStore.putReceipt(resolution.receipt);
        const result = await ingestExactSourceInputV2({
          exactInput: { providerObjectId: `session:${corpus.sessionId}`, mediaType: corpus.normalizedFormat, bytes: Buffer.from(corpus.content, "utf8"), observedAt: corpus.transferredAt },
          requirement: resolution.normalizedRequirement,
          connector,
          store: sourceStore,
          workerId: `cli:${process.pid}`,
        });
        if (!["processed", "quarantined", "duplicate"].includes(result.outcome)) throw new Error("Explicit Session archive did not reach durable Raw Evidence.");
        const receiptId = result.receiptIds.at(-1);
        if (!receiptId) throw new Error("Explicit Session archive lacks a durable receipt.");
        await corpusStore.markArchived(corpus.sessionId, corpus.corpusId, receiptId);
        process.stdout.write(`${JSON.stringify({ ok: true, corpus_id: corpus.corpusId, source_object_id: `session:${corpus.sessionId}`, receipt_id: receiptId, result }, null, 2)}\n`);
      } else throw new Error("Use `companyos knowledge session transfer|cleanup|archive`.");
    } else if (action === "observation") {
      const observationAction = value;
      const store = new PostgresKnowledgeSourceStore();
      if (observationAction === "record") {
        const inputPath = optionValue("--input");
        if (!inputPath) throw new Error("companyos knowledge observation record requires --input <yaml|json>.");
        const data = readStructuredFile(inputPath);
        const observation = createRuntimeObservation({
          subject: data.subject,
          content: data.content,
          observedAt: data.observed_at ?? data.observedAt,
          expiresAt: data.expires_at ?? data.expiresAt,
          runId: data.run_id ?? data.runId,
          agentId: data.agent_id ?? data.agentId,
          evidence: data.evidence ?? {},
          supersedes: data.supersedes,
          personalData: data.personal_data ?? data.personalData,
        });
        const inserted = await store.recordObservation(observation);
        process.stdout.write(`${JSON.stringify({ ok: true, inserted, observation }, null, 2)}\n`);
      } else if (observationAction === "review") {
        const active = await createPostgresKnowledgeProvider().activeSnapshot();
        if (!active) throw new Error("Runtime Observation review requires an active Company Knowledge snapshot.");
        const previousCandidateIds = await listPersistedKnowledgeReviewCandidateIds();
        const observations = await store.listObservationPromotionCandidates(3);
        const candidates = runtimeObservationsToReviewCandidates({ observations, activeBundle: active.bundle, previousCandidateIds });
        const persist = args.includes("--persist");
        const inserted = persist ? await persistKnowledgeReviewCandidates(candidates) : 0;
        process.stdout.write(`${JSON.stringify({ ok: true, mode: persist ? "persisted" : "preview", maximum_candidates: 3, inserted, candidates }, null, 2)}\n`);
      } else if (observationAction === "expire") {
        const now = optionValue("--now") ?? new Date().toISOString();
        const expired = await store.expireObservations(now);
        process.stdout.write(`${JSON.stringify({ ok: true, expired, at: now }, null, 2)}\n`);
      } else if (observationAction === "delete-request") {
        const observationId = optionValue("--observation");
        const principal = optionValue("--principal");
        const reason = optionValue("--reason");
        if (!observationId || !principal || !reason) throw new Error("Observation deletion request requires --observation, --principal, and --reason.");
        const requestId = await store.requestObservationDeletion(observationId, principal, reason);
        process.stdout.write(`${JSON.stringify({ ok: true, observation_id: observationId, request_id: requestId }, null, 2)}\n`);
      } else if (observationAction === "legal-hold") {
        const observationId = optionValue("--observation");
        const principal = optionValue("--principal");
        const enabled = optionValue("--enabled");
        if (!observationId || !principal || !new Set(["true", "false"]).has(enabled)) throw new Error("Observation legal hold requires --observation, --principal, and --enabled true|false.");
        const changed = await store.setObservationLegalHold(observationId, enabled === "true", principal);
        process.stdout.write(`${JSON.stringify({ ok: changed, observation_id: observationId, legal_hold: enabled === "true" }, null, 2)}\n`);
        if (!changed) process.exitCode = 1;
      } else if (observationAction === "delete-apply") {
        const observationId = optionValue("--observation");
        if (!observationId) throw new Error("Observation deletion apply requires --observation <id>.");
        const result = await store.applyObservationDeletion(observationId);
        process.stdout.write(`${JSON.stringify({ ok: result === "deleted", observation_id: observationId, result }, null, 2)}\n`);
        if (result !== "deleted") process.exitCode = 1;
      } else throw new Error("Use `companyos knowledge observation record|review|expire|delete-request|legal-hold|delete-apply`.");
    } else throw new Error("Use `companyos knowledge inspect|build|review|decide|propose|stage|verify|activate|rebuild|regression|source|session|observation`.");
  } else if (command === "build") {
    const target = targetWorkspace(action);
    const instanceIndex = args.indexOf("--instance");
    const outputIndex = args.indexOf("--output");
    const instancePath = instanceIndex >= 0 ? resolve(args[instanceIndex + 1]) : undefined;
    const outputPath = outputIndex >= 0 ? resolve(args[outputIndex + 1]) : undefined;
    if (!instancePath || !outputPath) throw new Error("companyos build requires --instance <file> and --output <file>.");
    const git = (cwd, ...gitArgs) => execFileSync("git", gitArgs, { cwd, encoding: "utf8" }).trim();
    const coreCommit = git(repoRoot, "rev-parse", "HEAD");
    const workspaceCommit = git(target, "rev-parse", "HEAD");
    if (git(repoRoot, "status", "--porcelain") || git(target, "status", "--porcelain")) {
      throw new Error("CompanyOS build requires clean Core and Workspace checkouts so the recorded SHA pair is reproducible.");
    }
    const artifact = buildCompanyOSArtifact({
      workspaceRoot: target,
      instance: loadInstanceBuildConfiguration(instancePath),
      coreVersion: CORE_VERSION,
      coreCommit,
      workspaceCommit,
      workbenchVersion: WORKBENCH_VERSION,
    });
    const knowledgeOutputPath = optionValue("--knowledge-output")
      ? resolve(optionValue("--knowledge-output"))
      : `${outputPath.replace(/\.json$/, "")}.knowledge.json`;
    if (existsSync(outputPath) || existsSync(knowledgeOutputPath)) {
      throw new Error("CompanyOS build output paths must not already exist.");
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
    const knowledgeBundle = buildKnowledgeBundle({ workspaceRoot: target, workspaceCommit });
    mkdirSync(dirname(knowledgeOutputPath), { recursive: true });
    writeFileSync(knowledgeOutputPath, `${JSON.stringify(knowledgeBundle, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`Built CompanyOS artifact ${artifact.artifactHash} at ${outputPath}\n`);
    process.stdout.write(`Built Company Knowledge bundle ${knowledgeBundle.bundleHash} at ${knowledgeOutputPath}\n`);
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
  } else if (command === "monday") {
    if (action !== "qualify") throw new Error("Use `companyos monday qualify`.");
    const statePath = optionValue("--state");
    if (args.includes("--status")) {
      if (!statePath) throw new Error("Monday qualification status requires --state <file>.");
      const state = readMondayQualificationState(resolve(statePath));
      const result = { ok: state.phase === "complete", state_path: resolve(statePath), phase: state.phase, evidence: state.evidence, history: state.history };
      if (format === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(`Monday qualification phase: ${state.phase}\n`);
        process.stdout.write(`State: ${resolve(statePath)}\n`);
        if (state.evidence?.discovery) process.stdout.write(`Discovery receipt: ${state.evidence.discovery.discovery_hash}\n`);
      }
    } else if (args.includes("--resume")) {
      if (!statePath) throw new Error("Monday qualification resume requires --state <file>.");
      const result = await advanceMondayQualification({
        statePath,
        onAuthorization: (authorization) => {
          const notice = {
            consent: "Monday will authorize only boards:read and me:read for the selected account. This creates an app authorization but no board, Agent, webhook, or write effect.",
            ...authorization,
          };
          const output = `${YAML.stringify({ next_action: notice })}\n`;
          if (format === "json") process.stderr.write(output);
          else process.stdout.write(output);
        },
      });
      if (format === "json") process.stdout.write(`${JSON.stringify({ ok: result.status === "complete", ...result }, null, 2)}\n`);
      else {
        exitWithDiagnostics(result.diagnostics, { format, summary: "Monday read-only qualification" });
        process.stdout.write(`\nPhase: ${result.state.phase}\n${result.message}\n`);
        if (result.next_action) process.stdout.write(`${YAML.stringify({ next_action: result.next_action })}\n`);
      }
    } else {
      const workspacePath = optionValue("--workspace");
      const clientId = optionValue("--client-id");
      const redirectUri = optionValue("--redirect-uri");
      const boardIds = optionValues("--board");
      if (!workspacePath || !clientId || !redirectUri || boardIds.length === 0 || !statePath) {
        throw new Error("Monday qualification planning and apply require --workspace <path>, --client-id <id>, --redirect-uri <loopback-url>, at least one --board <id>, and --state <file>.");
      }
      const checkout = inspectCoreCheckout(repoRoot, { requireClean: true });
      const planResult = planMondayQualification({ workspaceRoot: workspacePath, clientId, redirectUri, boardIds, statePath, coreIdentity: checkout.identity });
      planResult.diagnostics = [...checkout.diagnostics, ...planResult.diagnostics];
      if (args.includes("--plan")) {
        if (format === "json") {
          process.stdout.write(`${JSON.stringify({ ok: !hasErrors(planResult.diagnostics), ...planResult }, null, 2)}\n`);
          if (hasErrors(planResult.diagnostics)) process.exitCode = 1;
        } else {
          exitWithDiagnostics(planResult.diagnostics, { format, summary: "Monday read-only qualification plan" });
          if (!hasErrors(planResult.diagnostics)) process.stdout.write(`\n${YAML.stringify(planResult.plan)}\n`);
        }
      } else {
        const confirmationHash = optionValue("--apply");
        if (!confirmationHash) throw new Error("Use --plan first, then --apply <confirmation-hash> after explicit human confirmation.");
        const initialized = initializeMondayQualification({ planResult, confirmationHash });
        if (!initialized.state) {
          if (format === "json") process.stdout.write(`${JSON.stringify({ ok: false, ...initialized }, null, 2)}\n`);
          else exitWithDiagnostics(initialized.diagnostics, { format, summary: "Monday qualification initialization" });
          process.exitCode = 1;
        } else {
          const result = await advanceMondayQualification({
            statePath: initialized.statePath,
            onAuthorization: (authorization) => {
              const output = `${YAML.stringify({ next_action: authorization })}\n`;
              if (format === "json") process.stderr.write(output);
              else process.stdout.write(output);
            },
          });
          if (format === "json") process.stdout.write(`${JSON.stringify({ ok: result.status === "complete", ...result }, null, 2)}\n`);
          else {
            exitWithDiagnostics(result.diagnostics, { format, summary: "Monday read-only qualification" });
            process.stdout.write(`\nPhase: ${result.state.phase}\n${result.message}\n`);
            if (result.next_action) process.stdout.write(`${YAML.stringify({ next_action: result.next_action })}\n`);
          }
        }
      }
    }
  } else if (command === "setup") {
    const profile = optionValue("--profile");
    const statePath = optionValue("--state");
    if (profile !== LIVE_SETUP_PROFILE) throw new Error(`Use --profile ${LIVE_SETUP_PROFILE}.`);
    if (args.includes("--status")) {
      if (!statePath) throw new Error("Setup status requires --state <file>.");
      const state = readLiveSetupState(resolve(statePath));
      const result = { ok: state.phase === "complete", state_path: resolve(statePath), phase: state.phase, history: state.history, resources: state.resources, operating: state.operating, artifact: state.artifact, deployment: state.deployment, verification: state.verification };
      if (format === "json") process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        process.stdout.write(`Live setup phase: ${state.phase}\n`);
        process.stdout.write(`State: ${resolve(statePath)}\n`);
        process.stdout.write(state.phase === "complete" ? "The live starter is recorded as complete; run companyos verify-live for fresh checks.\n" : "Resume with the same state file; do not start a second installation.\n");
      }
    } else if (args.includes("--resume")) {
      if (!statePath) throw new Error("Setup resume requires --state <file>.");
      const result = await advanceLiveSetup({
        statePath,
        operatingConfirmation: optionValue("--operating-confirmation"),
        mergeConfirmation: optionValue("--merge-confirmation"),
        productionConfirmation: optionValue("--production-confirmation"),
      });
      if (format === "json") process.stdout.write(`${JSON.stringify({ ok: result.status === "complete", ...result }, null, 2)}\n`);
      else {
        exitWithDiagnostics(result.diagnostics, { format, summary: "Live CompanyOS setup" });
        process.stdout.write(`\nPhase: ${result.state.phase}\n${result.message}\n`);
        if (result.next_action) process.stdout.write(`${YAML.stringify({ next_action: result.next_action })}\n`);
      }
      if (result.status === "blocked") process.exitCode = 1;
    } else {
      const workspacePath = optionValue("--workspace");
      const answersPath = optionValue("--answers");
      if (!workspacePath || !answersPath) throw new Error("Setup planning and apply require --workspace <path> and --answers <yaml|json>.");
      const checkout = inspectCoreCheckout(repoRoot, { requireClean: true });
      const planResult = planLiveSetup({
        workspaceRoot: workspacePath,
        rawAnswers: readLiveSetupAnswers(resolve(answersPath)),
        coreIdentity: checkout.identity,
        statePath,
      });
      planResult.diagnostics = [...checkout.diagnostics, ...planResult.diagnostics];
      if (args.includes("--plan")) {
        if (format === "json") {
          process.stdout.write(`${JSON.stringify({ ok: !hasErrors(planResult.diagnostics), ...planResult }, null, 2)}\n`);
          if (hasErrors(planResult.diagnostics)) process.exitCode = 1;
        } else {
          exitWithDiagnostics(planResult.diagnostics, { format, summary: "Live setup plan" });
          if (!hasErrors(planResult.diagnostics)) process.stdout.write(`\n${YAML.stringify(planResult.plan)}\n`);
        }
      } else {
        const confirmationHash = optionValue("--apply");
        if (!confirmationHash) throw new Error("Use --plan first, then --apply <confirmation-hash> after explicit human confirmation.");
        const initialized = initializeLiveSetup({ planResult, confirmationHash });
        if (!initialized.state) {
          if (format === "json") process.stdout.write(`${JSON.stringify({ ok: false, ...initialized }, null, 2)}\n`);
          else exitWithDiagnostics(initialized.diagnostics, { format, summary: "Live setup initialization" });
          process.exitCode = 1;
        } else {
          const result = await advanceLiveSetup({ statePath: initialized.statePath });
          if (format === "json") process.stdout.write(`${JSON.stringify({ ok: result.status === "complete", ...result }, null, 2)}\n`);
          else {
            exitWithDiagnostics(result.diagnostics, { format, summary: "Live CompanyOS setup" });
            process.stdout.write(`\nPhase: ${result.state.phase}\n${result.message}\n`);
            if (result.next_action) process.stdout.write(`${YAML.stringify({ next_action: result.next_action })}\n`);
          }
          if (result.status === "blocked") process.exitCode = 1;
        }
      }
    }
  } else if (command === "verify-live") {
    const statePath = optionValue("--state");
    if (!statePath) throw new Error("verify-live requires --state <file>.");
    const result = await verifyLiveSetup({ statePath });
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
