import { randomUUID } from "node:crypto";
import { Output, generateText, jsonSchema } from "ai";
import { KnowledgeAuthorizer } from "../../../knowledge/access-control.ts";
import { extractRawEvidenceToBrain } from "../../../knowledge/extraction-pipeline.ts";
import {
  validateKnowledgeModelProfile,
  type KnowledgeModelExecutor,
  type KnowledgeModelProfileBinding,
  type KnowledgeModelProviderResult,
  type KnowledgeModelRequest,
  type KnowledgeModelTaskProfile,
} from "../../../knowledge/knowledge-model-execution.ts";
import { KnowledgePromptRegistry } from "../../../knowledge/prompt-registry.ts";
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
import { PostgresSourcePipelineStore } from "../../../state-postgres/source-pipeline-store.ts";
import { resolveModelExecution } from "./model-execution.ts";
import { decodeGranolaRuntimeConfiguration, GRANOLA_RECONCILIATION_STREAM } from "./knowledge-source-runtime.ts";

type StaticJsonSchema = Exclude<Parameters<typeof jsonSchema>[0], PromiseLike<unknown> | (() => unknown)>;

export const KNOWLEDGE_MODEL_CONFIG_ENV = "COMPANYOS_KNOWLEDGE_MODEL_CONFIG_BASE64";
export const GRANOLA_EXTRACTION_STREAM = `${GRANOLA_RECONCILIATION_STREAM}:extraction`;

export interface KnowledgeModelRuntimeConfiguration {
  version: 1;
  tasks: Readonly<Record<string, KnowledgeModelProfileBinding>>;
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
  const definition = new KnowledgePromptRegistry().resolve(promptId, "1");
  const binding = configuration.tasks[promptId];
  if (!binding) throw new Error(`Knowledge model task '${promptId}' is not configured.`);
  return validateKnowledgeModelProfile(binding, definition.profile);
}

export const KNOWLEDGE_EXTRACTION_JSON_SCHEMA: StaticJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["page", "claims", "timeline"],
  properties: {
    page: {
      type: "object", additionalProperties: false, required: ["title", "summary"],
      properties: { title: { type: "string", minLength: 1, maxLength: 500 }, summary: { type: "string", maxLength: 4000 } },
    },
    claims: {
      type: "array", maxItems: 200,
      items: {
        anyOf: [
          {
            type: "object", additionalProperties: false,
            required: ["memoryClass", "claimKind", "claimText", "ownerPrincipalId", "evidenceId", "locator", "extractionConfidence", "epistemicWeight", "participantRelations"],
            properties: {
              memoryClass: { type: "string", const: "fact" }, claimKind: { type: "string", enum: ["event", "preference", "commitment", "belief", "fact"] },
              claimText: { type: "string", minLength: 1, maxLength: 10000 }, ownerPrincipalId: { type: "string", minLength: 1, maxLength: 256 },
              evidenceId: { type: "string", const: "evidence:source" }, locator: { $ref: "#/$defs/locator" },
              extractionConfidence: { type: "number", minimum: 0, maximum: 1 }, epistemicWeight: { type: "number", minimum: 0, maximum: 1 },
              participantRelations: { $ref: "#/$defs/participantRelations" },
            },
          },
          {
            type: "object", additionalProperties: false,
            required: ["memoryClass", "claimKind", "claimText", "holder", "derivation", "evidenceId", "locator", "extractionConfidence", "epistemicWeight", "participantRelations"],
            properties: {
              memoryClass: { type: "string", const: "take" }, claimKind: { type: "string", enum: ["fact", "take", "bet", "hunch"] },
              claimText: { type: "string", minLength: 1, maxLength: 10000 },
              holder: { type: "object", additionalProperties: false, required: ["holderId", "holderType", "displayName"], properties: {
                holderId: { type: "string", minLength: 1, maxLength: 256 }, holderType: { type: "string", enum: ["person", "team", "company", "world", "system", "unresolved"] }, displayName: { type: "string", minLength: 1, maxLength: 500 },
              } },
              derivation: { type: "string", enum: ["source-literal", "model-derived"] }, evidenceId: { type: "string", const: "evidence:source" }, locator: { $ref: "#/$defs/locator" },
              extractionConfidence: { type: "number", minimum: 0, maximum: 1 }, epistemicWeight: { type: "number", minimum: 0, maximum: 1 },
              participantRelations: { $ref: "#/$defs/participantRelations" },
            },
          },
        ],
      },
    },
    timeline: { type: "array", maxItems: 200, items: { type: "object", additionalProperties: false, required: ["eventType", "description", "observedAt", "locator"], properties: {
      eventType: { type: "string", minLength: 1, maxLength: 200 }, description: { type: "string", minLength: 1, maxLength: 2000 }, observedAt: { type: "string", format: "date-time" }, locator: { $ref: "#/$defs/locator" },
    } } },
  },
  $defs: {
    locator: { anyOf: [
      { type: "object", additionalProperties: false, required: ["kind", "start", "end"], properties: { kind: { type: "string", const: "line" }, start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 } } },
      { type: "object", additionalProperties: false, required: ["kind", "startMs", "endMs"], properties: { kind: { type: "string", const: "timestamp" }, startMs: { type: "number", minimum: 0 }, endMs: { type: "number", minimum: 0 } } },
    ] },
    participantRelations: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false, required: ["relation", "principalId"], properties: {
      relation: { type: "string", enum: ["speaker", "author", "subject", "approver", "owner", "beneficiary", "affected-party"] }, principalId: { type: "string", minLength: 1, maxLength: 256 },
    } } },
  },
};
const extractionSchema = jsonSchema(KNOWLEDGE_EXTRACTION_JSON_SCHEMA);

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

export class VercelKnowledgeModelExecutor implements KnowledgeModelExecutor {
  async execute(profile: KnowledgeModelProfileBinding, request: KnowledgeModelRequest): Promise<KnowledgeModelProviderResult> {
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
    const numberedEvidence = request.evidenceBlocks.map((block) => ({
      evidenceId: block.evidenceId,
      content: block.content.split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n"),
    }));
    const started = Date.now();
    try {
      const result = await generateText({
        model: resolved.model,
        system: request.systemInstruction,
        prompt: `Return the declared extraction object. Use one-based original line numbers for every line locator. Facts require the accountable principal in ownerPrincipalId. Takes require exactly one attributable holder. Use participantRelations only when the evidence explicitly identifies them.\n\n${numberedEvidence.map((block) => `<evidence id="${block.evidenceId}">\n${block.content}\n</evidence>`).join("\n\n")}`,
        output: Output.object({ schema: extractionSchema }),
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
    const leaseUntil = new Date(Date.parse(acquiredAt) + 15 * 60_000).toISOString();
    if (await this.#sourceStore.claimSyncLease({ sourceId, streamId: GRANOLA_EXTRACTION_STREAM, owner, acquiredAt, leaseUntil }) === "busy") return { ok: true, status: "busy" as const, sourceId };
    try {
      const policy = await this.#sourceStore.getPolicy(source.requirement.access.rootPolicyId);
      if (!policy) throw new Error("Granola extraction policy is unavailable.");
      const subject = { principalId: source.requirement.dataOwner, principalType: "human" as const, status: "active" as const, groupIds: [] as string[] };
      const authorizer = new KnowledgeAuthorizer([policy], new PostgresKnowledgeAccessAuditor());
      const objects = await this.#sourceStore.listCurrentSourceObjects(sourceId);
      const limit = Math.max(1, Math.min(input.maxItems ?? 2, 10));
      let processed = 0;
      let current = 0;
      let deferred = 0;
      let claims = 0;
      for (const object of objects) {
        if (object.deletionState !== "present") continue;
        const evidence = await this.#sourceStore.currentRawEvidence(sourceId, object.providerObjectId);
        if (!evidence || !evidence.modelReady || evidence.payloadState !== "active") { deferred += 1; continue; }
        const pageId = sha256({ sourceId, sourcePageKey: object.providerObjectId });
        const page = await this.#brainStore.getPage(pageId);
        if (page?.version.sourceObjectVersion === object.providerVersion) { current += 1; continue; }
        if (!evidence.content || !("inlineText" in evidence.content)) { deferred += 1; continue; }
        if (processed >= limit) continue;
        const permit = await authorizer.authorize({ subject, permission: "read", policyIds: [evidence.envelope.accessPolicyId], objectType: "model-context", objectId: `${sourceId}:${object.providerObjectId}:${object.providerVersion}` });
        if (!permit) { deferred += 1; continue; }
        const result = await extractRawEvidenceToBrain({
          evidence,
          sourceKind: source.requirement.sourceKind,
          ownerPrincipalId: source.requirement.dataOwner,
          brainStore: this.#brainStore,
          runStore: this.#runStore,
          modelExecutor: this.#executor,
          profiles: {
            utility: resolveKnowledgeTaskProfile(this.#configuration, "knowledge.page-classification"),
            reasoning: resolveKnowledgeTaskProfile(this.#configuration, "knowledge.claim-extraction"),
          },
          authorizationContextDigest: sha256({ principalId: subject.principalId, policyId: evidence.envelope.accessPolicyId, providerObjectId: object.providerObjectId, providerVersion: object.providerVersion }),
          dataClass: source.requirement.dataClass,
        });
        processed += 1;
        claims += result.claims.length;
      }
      const remaining = Math.max(0, objects.filter((object) => object.deletionState === "present").length - current - processed - deferred);
      return { ok: true, status: remaining === 0 ? "complete" as const : "partial" as const, sourceId, processed, current, deferred, claims, remaining };
    } finally {
      await this.#sourceStore.releaseSyncLease({ sourceId, streamId: GRANOLA_EXTRACTION_STREAM, owner });
    }
  }
}
