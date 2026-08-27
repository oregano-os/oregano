import { randomUUID } from "node:crypto";
import { Output, generateText, jsonSchema } from "ai";
import { KnowledgeAuthorizer } from "../../../knowledge/access-control.ts";
import { runCompoundingCycle, type CompoundingStateStore } from "../../../knowledge/compounding.ts";
import { extractRawEvidenceToBrain, knowledgeExtractionRunIdentity } from "../../../knowledge/extraction-pipeline.ts";
import {
  executeKnowledgeModel,
  validateKnowledgeModelProfile,
  type KnowledgeModelExecutor,
  type KnowledgeModelProfileBinding,
  type KnowledgeModelProviderResult,
  type KnowledgeModelRequest,
  type KnowledgeModelTaskProfile,
} from "../../../knowledge/knowledge-model-execution.ts";
import {
  CORE_KNOWLEDGE_PROMPT_FIXTURES,
  evaluateKnowledgePromptSignals,
  knowledgePromptOutputSignals,
} from "../../../knowledge/prompt-evaluation.ts";
import { KnowledgePromptRegistry, renderKnowledgePromptUserMessage } from "../../../knowledge/prompt-registry.ts";
import { KNOWLEDGE_CLAIM_EXTRACTION_OUTPUT_SCHEMA } from "../../../knowledge/prompt-schemas.ts";
import {
  createProductiveKnowledgeCompoundingPhases,
  KNOWLEDGE_PRODUCTIVE_COMPOUNDING_CONTRACT_VERSION,
  KNOWLEDGE_PRODUCTIVE_COMPOUNDING_PROMPT_IDS,
  type KnowledgeCompoundingWorkStore,
} from "../../../knowledge/productive-compounding.ts";
import {
  decodeModelRuntimeConfiguration,
  resolveModelExecutionSelection,
  type ModelExecutionRoute,
  type ModelExecutionSelection,
  type ModelRuntimeConfiguration,
} from "../../../runner/model-execution.ts";
import { sha256 } from "../../../runtime/canonical.ts";
import { PostgresBrainStore } from "../../../state-postgres/brain-store.ts";
import { PostgresKnowledgeAccessAuditor } from "../../../state-postgres/knowledge-access-store.ts";
import { PostgresKnowledgeExtractionRunStore } from "../../../state-postgres/extraction-run-store.ts";
import {
  PostgresCompoundingStateStore,
  PostgresKnowledgeCompoundingWorkStore,
} from "../../../state-postgres/knowledge-compounding-store.ts";
import { PostgresSourcePipelineStore } from "../../../state-postgres/source-pipeline-store.ts";
import { resolveModelExecution } from "./model-execution.ts";
import { decodeGranolaRuntimeConfiguration, GRANOLA_RECONCILIATION_STREAM } from "./knowledge-source-runtime.ts";

type StaticJsonSchema = Exclude<Parameters<typeof jsonSchema>[0], PromiseLike<unknown> | (() => unknown)>;

export const KNOWLEDGE_MODEL_CONFIG_ENV = "COMPANYOS_KNOWLEDGE_MODEL_CONFIG_BASE64";
export const GRANOLA_EXTRACTION_STREAM = `${GRANOLA_RECONCILIATION_STREAM}:extraction`;
export const VERCEL_KNOWLEDGE_COMPOUNDING_PHASE_BUDGET = 5 as const;

export interface KnowledgeModelRuntimeConfiguration {
  version: 1;
  tasks: Readonly<Record<string, KnowledgeModelProfileBinding>>;
}

export function productiveKnowledgeCompoundingCycleId(
  frontierDigest: string,
  configuration: KnowledgeModelRuntimeConfiguration,
): string {
  if (!/^[a-f0-9]{64}$/.test(frontierDigest)) throw new Error("Knowledge compounding frontier digest is invalid.");
  const registry = new KnowledgePromptRegistry();
  const contractDigest = sha256({
    version: KNOWLEDGE_PRODUCTIVE_COMPOUNDING_CONTRACT_VERSION,
    prompts: KNOWLEDGE_PRODUCTIVE_COMPOUNDING_PROMPT_IDS.map((promptId) => {
      const prompt = registry.resolveCurrent(promptId);
      const profile = resolveKnowledgeTaskProfile(configuration, promptId);
      return {
        promptId,
        promptVersion: prompt.version,
        promptContentHash: prompt.contentHash,
        profile: profile.profile,
        profileVersion: profile.profileVersion,
        route: profile.route,
        model: profile.model,
      };
    }),
  });
  return `knowledge-compounding@${KNOWLEDGE_PRODUCTIVE_COMPOUNDING_CONTRACT_VERSION}:${contractDigest.slice(0, 16)}:${frontierDigest.slice(0, 16)}`;
}

const knowledgeProfile = (
  profile: KnowledgeModelTaskProfile,
  selection: ModelExecutionSelection,
  defaultMaxOutputTokens: number,
): KnowledgeModelProfileBinding => ({
  contractVersion: "1.0.0",
  profile,
  profileVersion: selection.recipeVersion,
  route: selection.route,
  model: selection.model,
  maxOutputTokens: selection.maxOutputTokens ?? defaultMaxOutputTokens,
});

const defaultMaxOutputTokens = (profile: KnowledgeModelTaskProfile): number =>
  profile === "utility" ? 4_000 : profile === "deep" ? 32_000 : 16_000;

const compileKnowledgeTasks = (
  configuration: ModelRuntimeConfiguration | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, KnowledgeModelProfileBinding>> => Object.fromEntries(
  new KnowledgePromptRegistry().list().map((definition) => {
    const selection = resolveModelExecutionSelection({
      profile: definition.profile,
      task: definition.promptId,
      requiredCapability: "structured-output",
      configuration,
      environment,
    });
    return [definition.promptId, knowledgeProfile(definition.profile, selection, defaultMaxOutputTokens(definition.profile))];
  }),
);

const compileLegacyKnowledgeTasks = (
  utilityValue: unknown,
  reasoningValue: unknown,
): Readonly<Record<string, KnowledgeModelProfileBinding>> => {
  const utility = validateKnowledgeModelProfile(utilityValue as KnowledgeModelProfileBinding, "utility");
  const reasoning = validateKnowledgeModelProfile(reasoningValue as KnowledgeModelProfileBinding, "reasoning");
  return Object.fromEntries(new KnowledgePromptRegistry().list().map((definition) => {
    const inherited = definition.profile === "utility" ? utility : reasoning;
    return [definition.promptId, validateKnowledgeModelProfile({ ...inherited, profile: definition.profile }, definition.profile)];
  }));
};

export function resolveKnowledgeTaskProfile(
  configuration: KnowledgeModelRuntimeConfiguration,
  promptId: string,
): KnowledgeModelProfileBinding {
  const definition = new KnowledgePromptRegistry().resolveCurrent(promptId);
  const binding = configuration.tasks[promptId];
  if (!binding) throw new Error(`Knowledge model task '${promptId}' is not configured.`);
  return validateKnowledgeModelProfile(binding, definition.profile);
}

/** @deprecated Use the task-specific Prompt Registry output schema. */
export const KNOWLEDGE_EXTRACTION_JSON_SCHEMA: StaticJsonSchema = KNOWLEDGE_CLAIM_EXTRACTION_OUTPUT_SCHEMA as unknown as StaticJsonSchema;

export const KNOWLEDGE_SMOKE_TEST_JSON_SCHEMA: StaticJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string", const: "ready" } },
};
const smokeTestSchema = jsonSchema(KNOWLEDGE_SMOKE_TEST_JSON_SCHEMA);

export function decodeKnowledgeModelRuntimeConfiguration(
  encoded = process.env[KNOWLEDGE_MODEL_CONFIG_ENV],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): KnowledgeModelRuntimeConfiguration {
  if (!encoded) {
    return { version: 1, tasks: compileKnowledgeTasks(decodeModelRuntimeConfiguration(environment.COMPANYOS_MODEL_CONFIG_BASE64), environment) };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); } catch { throw new Error(`${KNOWLEDGE_MODEL_CONFIG_ENV} is malformed.`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Knowledge model runtime configuration must be an object.");
  const value = parsed as Record<string, unknown>;
  const legacyKeys = ["version", "utility", "reasoning"];
  if (value.version === 1 && value.utility && value.reasoning && Object.keys(value).every((key) => legacyKeys.includes(key))) {
    return { version: 1, tasks: compileLegacyKnowledgeTasks(value.utility, value.reasoning) };
  }
  const configuration = decodeModelRuntimeConfiguration(encoded);
  if (!configuration) throw new Error("Knowledge model runtime configuration has an unsupported shape.");
  return { version: 1, tasks: compileKnowledgeTasks(configuration, environment) };
}

export const knowledgeModelAdapterDigest = (route: string, model: string): string => sha256({ adapter: "oregano/model-recipe-knowledge", version: "1.0.0", route, model });

export async function qualifyKnowledgePromptFixtures(input: {
  executor: KnowledgeModelExecutor;
  configuration: KnowledgeModelRuntimeConfiguration;
  maximumFixtures?: number;
  now?: () => string;
}) {
  const limit = Math.max(1, Math.min(input.maximumFixtures ?? CORE_KNOWLEDGE_PROMPT_FIXTURES.length, CORE_KNOWLEDGE_PROMPT_FIXTURES.length));
  const testedAt = input.now?.() ?? new Date().toISOString();
  const results = [];
  for (const fixture of CORE_KNOWLEDGE_PROMPT_FIXTURES.slice(0, limit)) {
    const prompt = new KnowledgePromptRegistry().resolveCurrent(fixture.promptId);
    const profile = resolveKnowledgeTaskProfile(input.configuration, fixture.promptId);
    const evidenceBlocks = fixture.evidenceBlocks.map((block) => ({ ...block, contentDigest: sha256(block.content) }));
    const executed = await executeKnowledgeModel({
      executor: input.executor,
      profile,
      requiredProfile: prompt.profile,
      completedAt: testedAt,
      request: {
        task: prompt.task,
        promptId: prompt.promptId,
        promptVersion: prompt.version,
        promptContentHash: prompt.contentHash,
        inputSchemaId: prompt.inputSchemaId,
        outputSchemaId: prompt.outputSchemaId,
        systemInstruction: prompt.systemInstruction,
        taskInput: fixture.taskInput,
        evidenceBlocks,
        authorizationContextDigest: sha256({ operation: "knowledge-model-qualification", fixtureId: fixture.fixtureId }),
        dataClass: "business",
        idempotencyKey: sha256({ fixtureId: fixture.fixtureId, promptContentHash: prompt.contentHash, model: profile.model }),
      },
    });
    const signals = knowledgePromptOutputSignals(fixture.promptId, executed.output, fixture.taskInput);
    const metrics = evaluateKnowledgePromptSignals(fixture.expectedSignals, signals);
    results.push({
      fixtureId: fixture.fixtureId,
      promptId: fixture.promptId,
      route: executed.receipt.route,
      model: executed.receipt.model,
      receiptId: executed.receipt.receiptId,
      outcome: executed.receipt.outcome,
      minimumF1: fixture.minimumF1,
      expectedSignals: fixture.expectedSignals,
      actualSignals: signals,
      metrics,
      qualified: executed.receipt.outcome === "succeeded" && metrics.f1 >= fixture.minimumF1,
    });
  }
  const qualified = results.length === limit && results.every((result) => result.qualified);
  return { ok: qualified, status: qualified ? "qualified" as const : "failed" as const, testedAt, fixtureCount: results.length, results, qualificationId: sha256({ testedAt, results }) };
}

export class VercelKnowledgeModelExecutor implements KnowledgeModelExecutor {
  async execute(profile: KnowledgeModelProfileBinding, request: KnowledgeModelRequest): Promise<KnowledgeModelProviderResult> {
    const definition = new KnowledgePromptRegistry().resolveExecution(request);
    const resolved = resolveModelExecution({
      profile: profile.profile,
      task: request.promptId,
      binding: {
        route: profile.route as ModelExecutionRoute,
        model: profile.model,
        maxOutputTokens: profile.maxOutputTokens,
      },
      requiredCapability: "structured-output",
    });
    const started = Date.now();
    try {
      const result = await generateText({
        model: resolved.model,
        system: definition.systemInstruction,
        prompt: renderKnowledgePromptUserMessage(definition, request),
        output: Output.object({ schema: jsonSchema(definition.outputSchema as unknown as StaticJsonSchema) }),
        temperature: 0,
        maxOutputTokens: profile.maxOutputTokens,
        ...(resolved.selection.retries === undefined ? {} : { maxRetries: resolved.selection.retries }),
        ...(resolved.selection.timeoutMs === undefined ? {} : { abortSignal: AbortSignal.timeout(resolved.selection.timeoutMs) }),
      });
      const finishReason = result.finishReason === "stop" ? "stop" as const
        : result.finishReason === "length" ? "length" as const
          : result.finishReason === "content-filter" ? "refusal" as const : "error" as const;
      return {
        output: result.output,
        responseId: result.response.id,
        responseModel: result.response.modelId,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        costUsd: 0,
        latencyMs: Date.now() - started,
        finishReason,
      };
    } catch (error) {
      throw new Error(`Knowledge model provider call failed (${sha256(error instanceof Error ? error.message : String(error))}).`);
    }
  }

  async smokeTest(configuration = decodeKnowledgeModelRuntimeConfiguration()) {
    const distinct = [...new Map(Object.values(configuration.tasks).map((binding) => [`${binding.route}:${binding.model}`, binding])).values()];
    const models = [];
    const testedAt = new Date().toISOString();
    for (const binding of distinct) {
      const resolved = resolveModelExecution({
        profile: binding.profile,
        task: "setup.model-smoke-test",
        binding: { route: binding.route as ModelExecutionRoute, model: binding.model, maxOutputTokens: 32 },
        requiredCapability: "structured-output",
      });
      const started = Date.now();
      const result = await generateText({
        model: resolved.model,
        system: "Return only the declared smoke-test object.",
        prompt: "Return status ready.",
        output: Output.object({ schema: smokeTestSchema }),
        temperature: 0,
        maxOutputTokens: 32,
        ...(resolved.selection.retries === undefined ? {} : { maxRetries: resolved.selection.retries }),
        ...(resolved.selection.timeoutMs === undefined ? {} : { abortSignal: AbortSignal.timeout(resolved.selection.timeoutMs) }),
      });
      if ((result.output as { status?: string }).status !== "ready") throw new Error("Knowledge model smoke test returned unexpected output.");
      models.push({
        route: resolved.selection.route,
        model: resolved.selection.model,
        adapterDigest: knowledgeModelAdapterDigest(resolved.selection.route, resolved.selection.model),
        responseModel: result.response.modelId,
        latencyMs: Date.now() - started,
      });
    }
    const adapterDigest = sha256(models.map(({ route, model, adapterDigest: digest }) => ({ route, model, adapterDigest: digest })));
    const testId = sha256({ testedAt, adapterDigest, models });
    return { ok: true, testedAt, testId, adapterDigest, models };
  }

  async qualifyFixtures(input: { configuration?: KnowledgeModelRuntimeConfiguration; maximumFixtures?: number } = {}) {
    return qualifyKnowledgePromptFixtures({ executor: this, configuration: input.configuration ?? decodeKnowledgeModelRuntimeConfiguration(), ...(input.maximumFixtures === undefined ? {} : { maximumFixtures: input.maximumFixtures }) });
  }
}

export class CompanyKnowledgeCompoundingRuntime {
  readonly #configuration: KnowledgeModelRuntimeConfiguration;
  readonly #sourceStore: PostgresSourcePipelineStore;
  readonly #state: CompoundingStateStore;
  readonly #workStore: KnowledgeCompoundingWorkStore;
  readonly #executor: KnowledgeModelExecutor;
  readonly #now: () => string;

  constructor(input: {
    configuration?: KnowledgeModelRuntimeConfiguration;
    sourceStore?: PostgresSourcePipelineStore;
    state?: CompoundingStateStore;
    workStore?: KnowledgeCompoundingWorkStore;
    executor?: KnowledgeModelExecutor;
    now?: () => string;
  } = {}) {
    this.#configuration = input.configuration ?? decodeKnowledgeModelRuntimeConfiguration();
    this.#sourceStore = input.sourceStore ?? new PostgresSourcePipelineStore();
    this.#state = input.state ?? new PostgresCompoundingStateStore();
    this.#workStore = input.workStore ?? new PostgresKnowledgeCompoundingWorkStore();
    this.#executor = input.executor ?? new VercelKnowledgeModelExecutor();
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  async process(input: { cycleId?: string; phaseBudget?: number } = {}) {
    const source = decodeGranolaRuntimeConfiguration();
    if (source.binding.state !== "active") throw new Error("The configured company Knowledge source is not active for compounding.");
    const policy = await this.#sourceStore.getPolicy(source.requirement.access.rootPolicyId);
    if (!policy) throw new Error("The company Knowledge access policy is unavailable.");
    const subject = { principalId: source.requirement.dataOwner, principalType: "human" as const, status: "active" as const, groupIds: [] as string[] };
    const authorizer = new KnowledgeAuthorizer([policy], new PostgresKnowledgeAccessAuditor());
    const permit = await authorizer.authorize({
      subject,
      permission: "read",
      policyIds: [policy.policyId],
      objectType: "model-context",
      objectId: source.requirement.sourceId,
    });
    if (!permit) throw new Error("Knowledge compounding authorization was denied.");
    const now = this.#now();
    const frontierDigest = await this.#workStore.getFrontierDigest({ accessPolicyIds: [policy.policyId] });
    const cycleId = input.cycleId ?? productiveKnowledgeCompoundingCycleId(frontierDigest, this.#configuration);
    const authorizationContextDigest = sha256({ principalId: subject.principalId, policyId: policy.policyId, permission: "read", sourceId: source.requirement.sourceId });
    const phases = createProductiveKnowledgeCompoundingPhases({
      store: this.#workStore,
      executor: this.#executor,
      resolveProfile: (promptId) => resolveKnowledgeTaskProfile(this.#configuration, promptId),
      accessPolicyIds: [policy.policyId],
      authorizationContextDigest,
      dataClass: source.requirement.dataClass,
      now: this.#now,
      phaseBudget: input.phaseBudget ?? VERCEL_KNOWLEDGE_COMPOUNDING_PHASE_BUDGET,
    });
    const receipts = await runCompoundingCycle({
      cycleId,
      sourceIds: [source.requirement.sourceId],
      phases,
      state: this.#state,
      owner: `compounding:${randomUUID()}`,
      now: this.#now,
    });
    return {
      ok: true,
      cycleId,
      complete: receipts.length === phases.length && receipts.every((receipt) => receipt.complete),
      processed: receipts.reduce((sum, receipt) => sum + receipt.processed, 0),
      receipts: receipts.map((receipt) => ({ receiptId: receipt.receiptId, phase: receipt.phase, processed: receipt.processed, total: receipt.total, complete: receipt.complete, continuation: receipt.continuation })),
    };
  }
}

export class GranolaKnowledgeExtractionRuntime {
  readonly #configuration: KnowledgeModelRuntimeConfiguration;
  readonly #sourceStore = new PostgresSourcePipelineStore();
  readonly #brainStore = new PostgresBrainStore();
  readonly #runStore = new PostgresKnowledgeExtractionRunStore();
  readonly #executor: KnowledgeModelExecutor;

  constructor(input: { configuration?: KnowledgeModelRuntimeConfiguration; executor?: KnowledgeModelExecutor } = {}) {
    this.#configuration = input.configuration ?? decodeKnowledgeModelRuntimeConfiguration();
    this.#executor = input.executor ?? new VercelKnowledgeModelExecutor();
  }

  async process(input: { maxItems?: number } = {}) {
    const source = decodeGranolaRuntimeConfiguration();
    if (source.binding.state !== "active") throw new Error("Granola Source binding is not active for extraction.");
    const sourceId = source.requirement.sourceId;
    const owner = `extractor:${randomUUID()}`;
    const acquiredAt = new Date().toISOString();
    const leaseUntil = new Date(Date.parse(acquiredAt) + 6 * 60_000).toISOString();
    if (await this.#sourceStore.claimSyncLease({ sourceId, streamId: GRANOLA_EXTRACTION_STREAM, owner, acquiredAt, leaseUntil }) === "busy") return { ok: true, status: "busy" as const, sourceId };
    try {
      const policy = await this.#sourceStore.getPolicy(source.requirement.access.rootPolicyId);
      if (!policy) throw new Error("Granola extraction policy is unavailable.");
      const subject = { principalId: source.requirement.dataOwner, principalType: "human" as const, status: "active" as const, groupIds: [] as string[] };
      const authorizer = new KnowledgeAuthorizer([policy], new PostgresKnowledgeAccessAuditor());
      const objects = await this.#sourceStore.listCurrentSourceObjects(sourceId);
      const limit = Math.max(1, Math.min(input.maxItems ?? 2, 10));
      let current = 0;
      let deferred = 0;
      const extractionTasks: Array<ReturnType<typeof extractRawEvidenceToBrain>> = [];
      const profiles = {
        utility: resolveKnowledgeTaskProfile(this.#configuration, "knowledge.page-classification"),
        reasoning: resolveKnowledgeTaskProfile(this.#configuration, "knowledge.claim-extraction"),
      };
      for (const object of objects) {
        if (object.deletionState !== "present") continue;
        const evidence = await this.#sourceStore.currentRawEvidence(sourceId, object.providerObjectId);
        if (!evidence || !evidence.modelReady || evidence.payloadState !== "active") { deferred += 1; continue; }
        if (!evidence.content || !("inlineText" in evidence.content)) { deferred += 1; continue; }
        const permit = await authorizer.authorize({ subject, permission: "read", policyIds: [evidence.envelope.accessPolicyId], objectType: "model-context", objectId: `${sourceId}:${object.providerObjectId}:${object.providerVersion}` });
        if (!permit) { deferred += 1; continue; }
        const authorizationContextDigest = sha256({ principalId: subject.principalId, policyId: evidence.envelope.accessPolicyId, providerObjectId: object.providerObjectId, providerVersion: object.providerVersion });
        const identity = knowledgeExtractionRunIdentity({ evidence, reasoningProfile: profiles.reasoning, authorizationContextDigest });
        if ((await this.#runStore.getByRunKey(identity.runKey))?.status === "succeeded") { current += 1; continue; }
        if (extractionTasks.length >= limit) continue;
        extractionTasks.push(extractRawEvidenceToBrain({
          evidence,
          sourceKind: source.requirement.sourceKind,
          ownerPrincipalId: source.requirement.dataOwner,
          brainStore: this.#brainStore,
          runStore: this.#runStore,
          modelExecutor: this.#executor,
          profiles,
          authorizationContextDigest,
          dataClass: source.requirement.dataClass,
        }));
      }
      const results = await Promise.all(extractionTasks);
      const processed = results.length;
      const claims = results.reduce((sum, result) => sum + result.claims.length, 0);
      const remaining = Math.max(0, objects.filter((object) => object.deletionState === "present").length - current - processed - deferred);
      return { ok: true, status: remaining === 0 ? "complete" as const : "partial" as const, sourceId, processed, current, deferred, claims, remaining };
    } finally {
      await this.#sourceStore.releaseSyncLease({ sourceId, streamId: GRANOLA_EXTRACTION_STREAM, owner });
    }
  }
}
