import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import { validateJsonSchemaValue } from "../../capabilities/validation.ts";
import {
  MONDAY_RECORD_SOURCE_CONNECTOR_ID,
  MONDAY_RECORD_SOURCE_CONNECTOR_VERSION,
  MondayRecordSourceConnector,
} from "../../connectors/monday/records-source.ts";
import { normalizeRecordObject } from "../../records/normalize.ts";
import { reconcileRecordSnapshot } from "../../records/reconciliation.ts";
import { CompanyRecordsRegistry } from "../../records/registry.ts";
import { CompanyRecordsService } from "../../records/service.ts";
import { RecordSourceConnectorRegistry } from "../../records/source-connector.ts";
import {
  createPostgresCompanyRecordsStore,
  inspectPostgresCompanyRecordSourceStatus,
} from "../../state-postgres/records-store.ts";
import { diagnostic } from "./diagnostics.mjs";
import { readMondayAgentQualificationState } from "./monday-agent-qualification.mjs";
import { inspectStructuredDeclarations } from "./structured-declarations.mjs";

const schema = (name) => JSON.parse(readFileSync(new URL(`../../schema/${name}`, import.meta.url), "utf8"));
const SOURCE_SCHEMA = schema("company-record-source-v1.schema.json");
const BINDING_SCHEMA = schema("company-record-source-binding-v1.schema.json");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hasErrors = (diagnostics) => diagnostics.some((item) => item.severity === "error");
const parseStructured = (path) => {
  const raw = readFileSync(resolve(path), "utf8");
  return extname(path).toLowerCase() === ".json" ? JSON.parse(raw) : YAML.parse(raw);
};

const inspectValue = (contract, value, code, label, file) =>
  validateJsonSchemaValue(contract, value).map((message) => diagnostic(code, "error", `${label}: ${message}.`, { file }));

const forbiddenBindingKey = /(?:^|_)(?:access_token|api_key|authorization|client_secret|credential|database_url|password|private_key|refresh_token|secret|token)(?:_|$)/i;
const inspectNoInlineSecrets = (value, path = "binding") => {
  const diagnostics = [];
  if (!value || typeof value !== "object") return diagnostics;
  for (const [key, entry] of Object.entries(value)) {
    if ((key === "secret_ref" && path !== "binding") || (key !== "secret_ref" && forbiddenBindingKey.test(key))) {
      diagnostics.push(diagnostic("REC004", "error", `Instance binding field '${path}.${key}' could contain inline credential material; use secret_ref only.`));
    }
    if (entry && typeof entry === "object") diagnostics.push(...inspectNoInlineSecrets(entry, `${path}.${key}`));
  }
  return diagnostics;
};

export function loadRecordSourceBinding(path) {
  const absolute = resolve(path);
  const value = parseStructured(absolute);
  const diagnostics = [
    ...inspectValue(BINDING_SCHEMA, value, "REC003", "Record Source binding violates its contract", absolute),
    ...inspectNoInlineSecrets(value),
  ];
  if (hasErrors(diagnostics)) {
    const error = new Error(`Invalid Company Records source binding '${absolute}'.`);
    error.diagnostics = diagnostics;
    throw error;
  }
  return value;
}

const loadBindingQualification = (binding, bindingPath) => {
  const reference = binding.qualification.receipt_ref;
  const qualificationPath = isAbsolute(reference) ? resolve(reference) : resolve(dirname(resolve(bindingPath)), reference);
  const value = binding.connector === MONDAY_RECORD_SOURCE_CONNECTOR_ID
    ? readMondayAgentQualificationState(qualificationPath)
    : parseStructured(qualificationPath);
  return { path: qualificationPath, value };
};

const loadSourceDraft = (path) => {
  const absolute = resolve(path);
  const value = parseStructured(absolute);
  const diagnostics = inspectValue(SOURCE_SCHEMA, value, "REC002", "Record Source declaration violates its contract", absolute);
  return { absolute, value, diagnostics };
};

const workspaceInside = (workspace, path) => {
  const fromWorkspace = relative(workspace, path);
  return fromWorkspace !== ".." && !fromWorkspace.startsWith(`..${sep}`) && !isAbsolute(fromWorkspace);
};

const recordOutputInsideWorkspace = (workspace, output) => {
  if (!workspaceInside(workspace, output)) return false;
  const relativeOutput = relative(workspace, output).replaceAll("\\", "/");
  return /^records\/sources\/[a-zA-Z0-9._-]+\.ya?ml$/.test(relativeOutput);
};

const selectDeclaration = (workspaceRoot, sourceId) => {
  const workspace = resolve(workspaceRoot);
  if (!existsSync(join(workspace, "company.md"))) throw new Error("Company Records commands require a Company Workspace with company.md.");
  const inspected = inspectStructuredDeclarations(workspace);
  const sources = sourceId
    ? inspected.declarations.sources.filter((source) => source.id === sourceId)
    : inspected.declarations.sources;
  if (sourceId && sources.length === 0) {
    inspected.diagnostics.push(diagnostic("REC001", "error", `Unknown Company Records source '${sourceId}'.`, { field: "source" }));
  }
  return { workspace, inspected, sources };
};

export function inspectRecordWorkspace({ workspaceRoot, sourceId, projectionId } = {}) {
  const selected = selectDeclaration(workspaceRoot, sourceId);
  let projections = selected.inspected.declarations.projections;
  if (projectionId) {
    projections = projections.filter((projection) => projection.id === projectionId);
    if (projections.length === 0) selected.inspected.diagnostics.push(diagnostic("REC005", "error", `Unknown Company Records projection '${projectionId}'.`, { field: "projection" }));
  }
  return {
    diagnostics: selected.inspected.diagnostics,
    workspace: selected.workspace,
    sources: selected.sources,
    projections,
    summary: {
      record_sources: selected.sources.length,
      record_projections: projections.length,
    },
  };
}

const mondaySourcePaths = (source) => [source.identity.source_field, ...source.fields.map((field) => field.source)];
const knownMondayPath = (path, columns) => {
  if (new Set([
    "id", "source_id", "object_kind", "is_work_item", "provider_id", "name", "updated_at", "created_at", "state", "url",
    "root_board_id", "board_id", "group_id", "parent_item_id", "provider_payload",
  ]).has(path)) return true;
  const [root, columnId] = path.split(".");
  return new Set(["columns", "column_text"]).has(root) && Boolean(columnId) && columns.has(columnId);
};

export function planRecordSourceMaterialization({
  workspaceRoot,
  provider,
  qualificationPath,
  boardId,
  declarationPath,
  outputPath,
}) {
  const diagnostics = [];
  const workspace = resolve(workspaceRoot);
  if (!existsSync(join(workspace, "company.md"))) diagnostics.push(diagnostic("REC006", "error", "Materialization requires a Company Workspace with company.md.", { file: workspace }));
  if (provider !== "monday") diagnostics.push(diagnostic("REC007", "error", "The maintained materializer currently supports provider 'monday' only.", { field: "provider" }));
  let qualification;
  try { qualification = readMondayAgentQualificationState(resolve(qualificationPath)); }
  catch (error) { diagnostics.push(diagnostic("REC008", "error", error.message, { file: resolve(qualificationPath) })); }
  const draft = loadSourceDraft(declarationPath);
  diagnostics.push(...draft.diagnostics);
  const output = resolve(outputPath);
  if (workspaceInside(workspace, resolve(qualificationPath))) diagnostics.push(diagnostic("REC021", "error", "Qualification evidence must stay outside the Company Workspace.", { file: resolve(qualificationPath) }));
  if (!recordOutputInsideWorkspace(workspace, output)) diagnostics.push(diagnostic("REC009", "error", "Materialized source output must be a YAML file directly under records/sources/ in the selected Company Workspace.", { file: output }));
  if (existsSync(output)) diagnostics.push(diagnostic("REC010", "error", "Materialization refuses to overwrite an existing source declaration.", { file: output }));
  if (qualification && qualification.phase !== "complete") diagnostics.push(diagnostic("REC011", "error", "The qualification receipt is not complete.", { file: resolve(qualificationPath) }));
  if (qualification && resolve(qualification.workspace) !== workspace) diagnostics.push(diagnostic("REC012", "error", "The qualification receipt belongs to another Company Workspace.", { file: resolve(qualificationPath) }));
  if (qualification?.phase === "complete") {
    const discovery = qualification.evidence?.discovery;
    if (qualification.kind !== "monday-external-agent-qualification" || discovery?.authentication_mode !== "external-agent" || discovery?.credentials_retained !== false) {
      diagnostics.push(diagnostic("REC024", "error", "The Monday qualification receipt must prove one external-Agent identity and no retained credential.", { file: resolve(qualificationPath) }));
    }
  }
  const board = qualification?.evidence?.discovery?.boards?.find((candidate) => String(candidate.id) === String(boardId));
  if (qualification?.phase === "complete" && !board) diagnostics.push(diagnostic("REC013", "error", `Qualified Monday evidence does not contain exact board '${boardId}'.`, { field: "board" }));
  if (board && draft.value) {
    const columns = new Set(board.columns.filter((column) => !column.archived).map((column) => String(column.id)));
    for (const path of mondaySourcePaths(draft.value)) {
      if (!knownMondayPath(path, columns)) diagnostics.push(diagnostic("REC014", "error", `Monday source path '${path}' is neither a supported item field nor a column from the qualified board.`, { file: draft.absolute }));
    }
    for (const referenced of [draft.value.connection, draft.value.reconcile_schedule].filter(Boolean)) {
      if (!existsSync(join(workspace, referenced))) diagnostics.push(diagnostic("REC015", "error", `Source draft references missing Workspace file '${referenced}'.`, { file: draft.absolute }));
    }
  }
  const plan = {
    schema_version: 1,
    kind: "company-record-source-materialization",
    provider,
    workspace,
    qualification: resolve(qualificationPath),
    qualification_digest: qualification?.evidence?.discovery?.discovery_hash ?? null,
    board_id: String(boardId),
    declaration_source: draft.absolute,
    declaration_digest: sha256(JSON.stringify(draft.value)),
    output,
    source: draft.value,
    external_changes: [
      `Create one reviewed Company Workspace declaration at ${output}.`,
      "Do not modify Monday, Neon/Postgres, provider permissions, schedules, Git, or deployment state.",
    ],
    required_human_actions: [
      "Review every company-specific record type, logical resource binding, field mapping, access group, and schedule reference.",
      "Confirm only if the qualification digest and exact board are still the intended source.",
    ],
  };
  plan.confirmation_hash = sha256(JSON.stringify(plan));
  return { plan, diagnostics };
}

export function applyRecordSourceMaterialization({ planResult, confirmationHash }) {
  if (!planResult?.plan || hasErrors(planResult.diagnostics)) return { applied: false, diagnostics: planResult?.diagnostics ?? [] };
  if (confirmationHash !== planResult.plan.confirmation_hash) {
    return { applied: false, diagnostics: [...planResult.diagnostics, diagnostic("REC016", "error", "Materialization confirmation does not match the current plan.")] };
  }
  if (existsSync(planResult.plan.output)) {
    return { applied: false, diagnostics: [...planResult.diagnostics, diagnostic("REC010", "error", "Materialization refuses to overwrite an existing source declaration.", { file: planResult.plan.output })] };
  }
  mkdirSync(dirname(planResult.plan.output), { recursive: true });
  writeFileSync(planResult.plan.output, YAML.stringify(planResult.plan.source), { encoding: "utf8", flag: "wx" });
  return {
    applied: true,
    output: planResult.plan.output,
    evidence: {
      confirmation_hash: confirmationHash,
      qualification_digest: planResult.plan.qualification_digest,
      declaration_digest: planResult.plan.declaration_digest,
      provider_effects: [],
      database_effects: [],
      git_effects: [],
    },
    diagnostics: planResult.diagnostics,
  };
}

export const resolveEnvironmentSecretRef = (secretRef) => {
  const match = /^env:([A-Z][A-Z0-9_]{0,127})$/.exec(String(secretRef));
  if (!match) throw new Error(`Unsupported secret reference '${secretRef}'; maintained bindings use env:NAME.`);
  const value = process.env[match[1]];
  if (!value) throw new Error(`Required Instance secret '${secretRef}' is not available to this process.`);
  return value;
};

export function createMaintainedRecordSourceConnectorRegistry({ resolveSecret = resolveEnvironmentSecretRef, fetcher, now } = {}) {
  return new RecordSourceConnectorRegistry([
    new MondayRecordSourceConnector({ resolveSecret, ...(fetcher ? { fetcher } : {}), ...(now ? { now } : {}) }),
  ]);
}

const registeredRecords = (inspected) => {
  const registry = new CompanyRecordsRegistry();
  for (const source of inspected.declarations.sources) registry.registerSource(source);
  for (const projection of inspected.declarations.projections) registry.registerProjection(projection);
  return registry;
};

export function planRecordSourceOperation({
  workspaceRoot,
  sourceId,
  bindingPath,
  operation,
  coreIdentity,
  connectorRegistry = createMaintainedRecordSourceConnectorRegistry({ resolveSecret: () => "plan-only" }),
}) {
  if (!new Set(["sync", "reconcile"]).has(operation)) throw new Error(`Unsupported Company Records operation '${operation}'.`);
  const selected = selectDeclaration(workspaceRoot, sourceId);
  const diagnostics = [...selected.inspected.diagnostics];
  if (!coreIdentity || !coreIdentity.repository || !/^[0-9a-f]{40}$/.test(String(coreIdentity.ref ?? "")) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(coreIdentity.core_version ?? "")) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(coreIdentity.workbench_version ?? "")) ||
      coreIdentity.clean !== true) {
    diagnostics.push(diagnostic("REC025", "error", "Company Records database operations require one clean exact Oregano Core identity.", { field: "core" }));
  }
  let binding;
  let qualification;
  try { binding = loadRecordSourceBinding(bindingPath); }
  catch (error) { diagnostics.push(...(error.diagnostics ?? [diagnostic("REC003", "error", error.message, { file: resolve(bindingPath) })])); }
  if (workspaceInside(selected.workspace, resolve(bindingPath))) diagnostics.push(diagnostic("REC022", "error", "Record Source Instance bindings must stay outside the Company Workspace.", { file: resolve(bindingPath) }));
  if (binding) {
    try {
      qualification = loadBindingQualification(binding, bindingPath);
      if (workspaceInside(selected.workspace, qualification.path)) diagnostics.push(diagnostic("REC021", "error", "Qualification evidence must stay outside the Company Workspace.", { file: qualification.path }));
    } catch (error) {
      diagnostics.push(diagnostic("REC023", "error", `Record Source qualification evidence is unavailable or invalid: ${error.message}`, { file: resolve(bindingPath) }));
    }
  }
  const source = selected.sources[0];
  if (binding && source && qualification) {
    if (binding.source_id !== source.id) diagnostics.push(diagnostic("REC017", "error", `Binding source '${binding.source_id}' does not match declaration '${source.id}'.`, { file: resolve(bindingPath) }));
    if (binding.resource_binding !== source.resource_binding) diagnostics.push(diagnostic("REC018", "error", `Binding resource '${binding.resource_binding}' does not match declaration '${source.resource_binding}'.`, { file: resolve(bindingPath) }));
    try { connectorRegistry.validate(source, binding, qualification.value); }
    catch (error) { diagnostics.push(diagnostic("REC019", "error", error.message, { file: resolve(bindingPath) })); }
  }
  const projections = source
    ? selected.inspected.declarations.projections.filter((projection) => projection.record_type === source.record_type)
    : [];
  const plan = {
    schema_version: 1,
    kind: "company-record-source-operation",
    operation,
    workspace: selected.workspace,
    core: coreIdentity ?? null,
    source_id: sourceId,
    source_digest: source ? sha256(JSON.stringify(source)) : null,
    projection_digests: projections.map((projection) => ({ id: projection.id, digest: sha256(JSON.stringify(projection)) })),
    binding_path: resolve(bindingPath),
    binding_digest: binding ? sha256(JSON.stringify(binding)) : null,
    instance_id: binding?.instance_id ?? null,
    resource_binding: binding?.resource_binding ?? null,
    connector: binding ? `${binding.connector}@${binding.connector_version}` : null,
    provider_secret_ref: binding?.secret_ref ?? null,
    qualification_ref: qualification?.path ?? null,
    qualification_digest: binding?.qualification?.digest ?? null,
    database_secret_ref: "env:DATABASE_URL",
    provider_access: "read-only-complete-inventory",
    database_effect: operation === "sync"
      ? "Append immutable observations, update current pointers and projections, and advance the watermark; do not infer provider deletion."
      : "Reconcile one complete inventory under a lease, including provider-absence tombstones, projection repair, and watermark advancement.",
    external_changes: [
      "Read the exact provider resource through the selected read-only Record Source Connector.",
      operation === "sync"
        ? "Write idempotent Company Records observations and projections to the existing Company Instance database without deleting missing records."
        : "Write idempotent Company Records observations and projections and mark records absent only after one complete provider inventory.",
      "Do not modify provider objects, provider permissions, Workspace files, Git, schedules, or deployments.",
    ],
    required_human_actions: [
      "Inject the provider SecretRef and DATABASE_URL only through the selected Instance runtime secret surface.",
      "Review the exact environment, source, resource binding, Connector version, declaration digest, projection digests, and database effect before applying.",
    ],
  };
  plan.confirmation_hash = sha256(JSON.stringify(plan));
  return { plan, diagnostics, source, projections, binding, qualification: qualification?.value, inspected: selected.inspected };
}

const syncWithoutDeletion = async ({ instanceId, source, inventory, registry, store, runId, leaseOwner, leaseToken, leaseExpiresAt }) => {
  const claimed = await store.claimSyncLease({
    instanceId,
    sourceId: source.id,
    owner: leaseOwner,
    token: leaseToken,
    now: inventory.observed_at,
    expiresAt: leaseExpiresAt,
  });
  if (!claimed) throw new Error(`Record source '${source.id}' already has an active synchronization lease`);
  let inserted = 0;
  let unchanged = 0;
  const service = new CompanyRecordsService({ instanceId, registry, store, now: () => new Date(inventory.observed_at) });
  try {
    for (const raw of inventory.objects) {
      const normalized = normalizeRecordObject({
        instanceId,
        source,
        raw,
        observedAt: inventory.observed_at,
        receipt: { operation: "sync", run_id: runId, inventory_digest: inventory.receipt.inventory_digest },
      });
      const current = await store.getCurrentObjectVersion(instanceId, source.id, normalized.object_id);
      if (current?.digest === normalized.digest) unchanged += 1;
      else inserted += 1;
      await service.ingest({
        event: {
          source_id: source.id,
          event_id: `sync:${runId}:${normalized.object_id}:${normalized.digest}`,
          object_id: normalized.object_id,
          kind: current ? "updated" : "created",
          observed_at: inventory.observed_at,
          receipt: { operation: "sync", run_id: runId, inventory_digest: inventory.receipt.inventory_digest },
        },
        raw,
        receipt: { operation: "sync", run_id: runId, inventory_digest: inventory.receipt.inventory_digest },
      });
    }
    await store.setWatermark(instanceId, source.id, inventory.watermark, inventory.observed_at);
    const receipt = {
      instance_id: instanceId,
      source_id: source.id,
      run_id: runId,
      started_at: inventory.observed_at,
      completed_at: inventory.observed_at,
      watermark: inventory.watermark,
      observed: inventory.objects.length,
      inserted,
      unchanged,
      deleted: 0,
      errors: 0,
    };
    await store.appendSyncReceipt(receipt);
    return receipt;
  } finally {
    await store.releaseSyncLease({ instanceId, sourceId: source.id, token: leaseToken });
  }
};

export async function runRecordSourceOperation({
  planResult,
  confirmationHash,
  connectorRegistry = createMaintainedRecordSourceConnectorRegistry(),
  store,
  prepareDatabaseBinding = store ? () => {} : () => { resolveEnvironmentSecretRef("env:DATABASE_URL"); },
  now = () => new Date(),
}) {
  if (!planResult?.plan || hasErrors(planResult.diagnostics)) return { applied: false, diagnostics: planResult?.diagnostics ?? [] };
  if (confirmationHash !== planResult.plan.confirmation_hash) {
    return { applied: false, diagnostics: [...planResult.diagnostics, diagnostic("REC020", "error", "Company Records operation confirmation does not match the current plan.")] };
  }
  prepareDatabaseBinding();
  const recordsStore = store ?? createPostgresCompanyRecordsStore();
  const connector = connectorRegistry.resolve(planResult.binding);
  connector.validateBinding({ source: planResult.source, binding: planResult.binding, qualification: planResult.qualification });
  const inventory = await connector.readCompleteInventory({ source: planResult.source, binding: planResult.binding, qualification: planResult.qualification });
  if (inventory.complete !== true) throw new Error("Record Source Connector did not return a complete inventory; no watermark or absence decision may be recorded.");
  const registry = registeredRecords(planResult.inspected);
  const runId = `${planResult.plan.operation}-${sha256(`${confirmationHash}:${inventory.watermark}`).slice(0, 32)}`;
  const leaseToken = randomUUID();
  const leaseOwner = `companyos-workbench:${process.pid}`;
  const leaseExpiresAt = new Date(now().getTime() + 15 * 60_000).toISOString();
  const receipt = planResult.plan.operation === "reconcile"
    ? await reconcileRecordSnapshot({
      instanceId: planResult.binding.instance_id,
      sourceId: planResult.source.id,
      runId,
      leaseOwner,
      leaseToken,
      observedAt: inventory.observed_at,
      leaseExpiresAt,
      objects: inventory.objects,
      watermark: inventory.watermark,
      registry,
      store: recordsStore,
    })
    : await syncWithoutDeletion({
      instanceId: planResult.binding.instance_id,
      source: planResult.source,
      inventory,
      registry,
      store: recordsStore,
      runId,
      leaseOwner,
      leaseToken,
      leaseExpiresAt,
    });
  return {
    applied: true,
    receipt,
    provider_evidence: inventory.receipt,
    credentials_retained: false,
    provider_effects: [],
    workspace_effects: [],
    diagnostics: planResult.diagnostics,
  };
}

export async function inspectRecordSourceStatus({
  workspaceRoot,
  sourceId,
  bindingPath,
  inspectStatus = inspectPostgresCompanyRecordSourceStatus,
  connectorRegistry = createMaintainedRecordSourceConnectorRegistry({ resolveSecret: () => "status-does-not-resolve-provider-secret" }),
}) {
  const selected = selectDeclaration(workspaceRoot, sourceId);
  if (hasErrors(selected.inspected.diagnostics)) return { diagnostics: selected.inspected.diagnostics };
  const binding = loadRecordSourceBinding(bindingPath);
  const source = selected.sources[0];
  const diagnostics = [];
  if (workspaceInside(selected.workspace, resolve(bindingPath))) diagnostics.push(diagnostic("REC022", "error", "Record Source Instance bindings must stay outside the Company Workspace.", { file: resolve(bindingPath) }));
  if (binding.source_id !== source.id) diagnostics.push(diagnostic("REC017", "error", `Binding source '${binding.source_id}' does not match declaration '${source.id}'.`, { file: resolve(bindingPath) }));
  if (binding.resource_binding !== source.resource_binding) diagnostics.push(diagnostic("REC018", "error", `Binding resource '${binding.resource_binding}' does not match declaration '${source.resource_binding}'.`, { file: resolve(bindingPath) }));
  try {
    const qualification = loadBindingQualification(binding, bindingPath);
    if (workspaceInside(selected.workspace, qualification.path)) diagnostics.push(diagnostic("REC021", "error", "Qualification evidence must stay outside the Company Workspace.", { file: qualification.path }));
    connectorRegistry.validate(source, binding, qualification.value);
  } catch (error) {
    diagnostics.push(diagnostic("REC023", "error", `Record Source qualification evidence is unavailable or invalid: ${error.message}`, { file: resolve(bindingPath) }));
  }
  if (hasErrors(diagnostics)) return { diagnostics };
  return { diagnostics, status: await inspectStatus(binding.instance_id, source.id), binding: { instance_id: binding.instance_id, connector: `${binding.connector}@${binding.connector_version}`, resource_binding: binding.resource_binding } };
}

export const MAINTAINED_RECORD_SOURCE_CONNECTORS = Object.freeze([
  `${MONDAY_RECORD_SOURCE_CONNECTOR_ID}@${MONDAY_RECORD_SOURCE_CONNECTOR_VERSION}`,
]);
