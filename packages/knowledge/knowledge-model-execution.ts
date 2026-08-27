import { canonicalJson, sha256 } from "../runtime/canonical.ts";
import { KnowledgePromptRegistry } from "./prompt-registry.ts";

export const KNOWLEDGE_MODEL_EXECUTION_CONTRACT_VERSION = "1.0.0" as const;
export const KNOWLEDGE_MODEL_TASK_PROFILES = ["utility", "reasoning", "deep", "embedding", "reranker"] as const;
export type KnowledgeModelTaskProfile = typeof KNOWLEDGE_MODEL_TASK_PROFILES[number];

export interface KnowledgeModelProfileBinding {
  contractVersion: typeof KNOWLEDGE_MODEL_EXECUTION_CONTRACT_VERSION;
  profile: KnowledgeModelTaskProfile;
  profileVersion: string;
  route: string;
  model: string;
  maxInputTokens?: number;
  maxOutputTokens: number;
  /** @deprecated Credentials are owned by the provider recipe, not task bindings. */
  secretRefs?: string[];
  /** @deprecated Knowledge authorization runs before invocation; recipes do not implement a data-class policy engine. */
  allowedDataClasses?: Array<"business" | "confidential" | "restricted" | "personal">;
  /** @deprecated Cost is observed in receipts but is not a hard execution gate. */
  maxCostUsd?: number;
  /** @deprecated Active qualification is replaced by recipe resolution plus an explicit smoke test. */
  state?: "bound" | "qualified" | "active" | "revoked";
  /** @deprecated Retained only so existing Instance configuration remains readable. */
  qualification?: { qualifiedAt: string; receiptId: string; adapterDigest: string };
}

export interface KnowledgeModelRequest {
  task: string;
  promptId: string;
  promptVersion: string;
  promptContentHash: string;
  inputSchemaId: string;
  outputSchemaId: string;
  systemInstruction: string;
  taskInput: Readonly<Record<string, unknown>>;
  evidenceBlocks: Array<{ evidenceId: string; content: string; contentDigest: string }>;
  authorizationContextDigest: string;
  dataClass: "business" | "confidential" | "restricted" | "personal";
  idempotencyKey: string;
}

export interface KnowledgeModelProviderResult {
  output: unknown;
  responseId: string;
  responseModel: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  finishReason: "stop" | "length" | "refusal" | "tool" | "error";
}

export interface KnowledgeModelExecutionReceipt {
  receiptId: string;
  contractVersion: typeof KNOWLEDGE_MODEL_EXECUTION_CONTRACT_VERSION;
  task: string;
  profile: KnowledgeModelTaskProfile;
  profileVersion: string;
  route: string;
  model: string;
  promptId: string;
  promptVersion: string;
  promptContentHash: string;
  inputSchemaId: string;
  outputSchemaId: string;
  inputDigest: string;
  authorizationContextDigest: string;
  responseId: string;
  responseModel: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  outcome: "succeeded" | "refused" | "truncated" | "failed";
  completedAt: string;
}

export interface KnowledgeModelExecutor {
  execute(profile: KnowledgeModelProfileBinding, request: KnowledgeModelRequest): Promise<KnowledgeModelProviderResult>;
}

const digestPattern = /^[a-f0-9]{64}$/;
const boundedInteger = (value: number, minimum: number, maximum: number, label: string): void => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is outside its bounded range.`);
};

export function validateKnowledgeModelProfile(value: KnowledgeModelProfileBinding, taskProfile?: KnowledgeModelTaskProfile): KnowledgeModelProfileBinding {
  if (value.contractVersion !== KNOWLEDGE_MODEL_EXECUTION_CONTRACT_VERSION || !KNOWLEDGE_MODEL_TASK_PROFILES.includes(value.profile)) throw new Error("Unsupported Knowledge model profile contract.");
  if (taskProfile && value.profile !== taskProfile) throw new Error(`Knowledge model task requires '${taskProfile}', not '${value.profile}'.`);
  for (const [label, field] of [["profile version", value.profileVersion], ["route", value.route], ["model", value.model]] as const) if (!field.trim() || field.length > 256) throw new Error(`Knowledge model ${label} is invalid.`);
  if (value.secretRefs?.some((ref) => !/^(?:env|secret):[A-Z][A-Z0-9_]{0,127}$/.test(ref))) throw new Error("Legacy Knowledge model credentials must be SecretRefs.");
  if (value.secretRefs && new Set(value.secretRefs).size !== value.secretRefs.length) throw new Error("Knowledge model profile has duplicate legacy SecretRefs.");
  if (value.allowedDataClasses && (value.allowedDataClasses.length === 0 || new Set(value.allowedDataClasses).size !== value.allowedDataClasses.length)) throw new Error("Knowledge model profile has invalid legacy data classes.");
  if (value.maxInputTokens !== undefined) boundedInteger(value.maxInputTokens, 1, 2_000_000, "Knowledge model input token limit");
  boundedInteger(value.maxOutputTokens, 1, 200_000, "Knowledge model output token limit");
  if (value.maxCostUsd !== undefined && (!Number.isFinite(value.maxCostUsd) || value.maxCostUsd < 0 || value.maxCostUsd > 1_000)) throw new Error("Knowledge model legacy cost metadata is invalid.");
  if (value.qualification) {
    if (Number.isNaN(Date.parse(value.qualification.qualifiedAt)) || !value.qualification.receiptId.trim() || !digestPattern.test(value.qualification.adapterDigest)) throw new Error("Knowledge model qualification evidence is invalid.");
  }
  return structuredClone(value);
}

export async function executeKnowledgeModel(input: {
  executor: KnowledgeModelExecutor;
  profile: KnowledgeModelProfileBinding;
  requiredProfile: KnowledgeModelTaskProfile;
  request: KnowledgeModelRequest;
  completedAt?: string;
}): Promise<{ output: unknown; receipt: KnowledgeModelExecutionReceipt }> {
  const profile = validateKnowledgeModelProfile(input.profile, input.requiredProfile);
  if (profile.state === "revoked") throw new Error(`Knowledge model profile '${profile.profile}' is revoked.`);
  if (!digestPattern.test(input.request.promptContentHash) || !digestPattern.test(input.request.authorizationContextDigest)) throw new Error("Knowledge model request contains an invalid prompt or authorization digest.");
  new KnowledgePromptRegistry().resolveExecution(input.request);
  if (canonicalJson(input.request.taskInput).length > 65_536) throw new Error("Knowledge model task input exceeds its bounded size.");
  const evidenceIds = new Set<string>();
  for (const block of input.request.evidenceBlocks) {
    if (!block.evidenceId.trim() || evidenceIds.has(block.evidenceId) || sha256(block.content) !== block.contentDigest) throw new Error("Knowledge model evidence blocks failed identity or digest validation.");
    evidenceIds.add(block.evidenceId);
  }
  const inputDigest = sha256({
    task: input.request.task,
    promptId: input.request.promptId,
    promptVersion: input.request.promptVersion,
    promptContentHash: input.request.promptContentHash,
    inputSchemaId: input.request.inputSchemaId,
    outputSchemaId: input.request.outputSchemaId,
    taskInput: input.request.taskInput,
    evidence: input.request.evidenceBlocks.map(({ evidenceId, contentDigest }) => ({ evidenceId, contentDigest })),
    authorizationContextDigest: input.request.authorizationContextDigest,
    dataClass: input.request.dataClass,
    idempotencyKey: input.request.idempotencyKey,
  });
  const result = await input.executor.execute(profile, structuredClone(input.request));
  boundedInteger(result.inputTokens, 0, profile.maxInputTokens ?? 2_000_000, "Knowledge model actual input tokens");
  boundedInteger(result.outputTokens, 0, profile.maxOutputTokens, "Knowledge model actual output tokens");
  if (!Number.isFinite(result.costUsd) || result.costUsd < 0) throw new Error("Knowledge model execution returned invalid cost metadata.");
  if (!Number.isFinite(result.latencyMs) || result.latencyMs < 0) throw new Error("Knowledge model execution latency is invalid.");
  const outcome = result.finishReason === "refusal" ? "refused" : result.finishReason === "length" ? "truncated" : result.finishReason === "stop" ? "succeeded" : "failed";
  const completedAt = new Date(input.completedAt ?? new Date().toISOString()).toISOString();
  const withoutId = {
    contractVersion: KNOWLEDGE_MODEL_EXECUTION_CONTRACT_VERSION,
    task: input.request.task,
    profile: profile.profile,
    profileVersion: profile.profileVersion,
    route: profile.route,
    model: profile.model,
    promptId: input.request.promptId,
    promptVersion: input.request.promptVersion,
    promptContentHash: input.request.promptContentHash,
    inputSchemaId: input.request.inputSchemaId,
    outputSchemaId: input.request.outputSchemaId,
    inputDigest,
    authorizationContextDigest: input.request.authorizationContextDigest,
    responseId: result.responseId,
    responseModel: result.responseModel,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    latencyMs: result.latencyMs,
    outcome,
    completedAt,
  } as const;
  const receipt = { ...withoutId, receiptId: sha256(withoutId) };
  if (profile.secretRefs && canonicalJson(receipt).includes(canonicalJson(profile.secretRefs))) throw new Error("Knowledge model receipt must not contain legacy SecretRefs.");
  return { output: result.output, receipt };
}
