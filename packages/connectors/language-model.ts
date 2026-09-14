import type { StateStore } from "../state-store/interface.ts";
import { LanguageAttempt, languageFailureDigest } from "../language/attempts.ts";
import { LanguageGenerationError } from "../language/contracts.ts";
import type { PreparedAttachment } from "../runtime/attachments.ts";
import type { CapabilityCallContext, Connector } from "../capabilities/contracts.ts";
import type { CompanyOSArtifact } from "../companyos-builder/types.ts";
import type { LanguageGenerator } from "../language/contracts.ts";
import { LANGUAGE_GENERATE_INPUT, LANGUAGE_GENERATE_OUTPUT } from "../language/contracts.ts";
import { validateJsonSchemaValue } from "../capabilities/validation.ts";
import { sha256 } from "../runtime/canonical.ts";
import { bindLanguagePrompts, type LanguagePromptBinding } from "../language/prompt-binding.ts";

export type { LanguagePromptBinding } from "../language/prompt-binding.ts";

/** Frozen, explicitly bound Skill instructions plus evidence-only input data. */
export class LanguageModelConnector implements Connector {
  readonly id = "oregano/language-model";
  readonly version = "1.0.0";
  readonly capabilities = ["language.generate"];
  readonly #artifact: CompanyOSArtifact;
  readonly #prompts: ReturnType<typeof bindLanguagePrompts>;
  readonly #generate: LanguageGenerator;
  readonly #state?: StateStore;

  constructor(args: { artifact: CompanyOSArtifact; prompts: LanguagePromptBinding[]; generate: LanguageGenerator; state?: StateStore }) {
    this.#artifact = structuredClone(args.artifact);
    this.#generate = args.generate;
    this.#state = args.state;
    this.#prompts = bindLanguagePrompts(this.#artifact, args.prompts);
  }

  async invoke(capability: string, raw: unknown, context: CapabilityCallContext) {
    if (capability !== "language.generate" || context.instanceId !== this.#artifact.instance.id
      || context.subject?.status !== "active") throw new Error("Generation requires an active subject in the bound Instance");
    if (validateJsonSchemaValue(LANGUAGE_GENERATE_INPUT, raw).length) throw new Error("Invalid bounded language generation input");
    const input = raw as { prompt_path: string; data: Record<string, unknown>; attachments?: PreparedAttachment[] };
    const prompt = this.#prompts.get(JSON.stringify([context.agentId, input.prompt_path]));
    if (!prompt) throw new Error("Generation prompt is not bound for this Agent");
    const data = JSON.stringify(input.data);
    if (data.length > 150_000) throw new Error("Generation evidence exceeds its bound; narrow the reviewed data selection");
    const identity = { prompt_path: input.prompt_path, prompt_digest: sha256(prompt.instructions),
      binding_digest: prompt.bindingDigest, model_task: prompt.modelTask, model_profile: prompt.modelProfile,
      context_digest: sha256(input.data), ...(input.attachments?.length ? { attachment_digests: input.attachments.map(file => file.digest) } : {}), agent_id: context.agentId,
      instance_id: context.instanceId, tool_id: context.toolId, artifact_hash: this.#artifact.artifactHash, core_commit: this.#artifact.provenance.coreCommit, workspace_commit: this.#artifact.provenance.workspaceCommit };
    const attempt = this.#state ? new LanguageAttempt(this.#state, { runId: context.runId, stepId: context.stepId,
      inputHash: sha256(identity), evidence: identity, fence: context.dispatchFence }) : undefined;
    await attempt?.prepare();
    let result;
    try {
      result = await this.#generate({ instructions: prompt.instructions, data, agentId: context.agentId, modelTask: prompt.modelTask,
        modelProfile: prompt.modelProfile, ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(attempt ? { beforeDispatch: selection => attempt.dispatch(selection) } : {}) });
    } catch (error) {
      await attempt?.finish(attempt?.dispatched && !(error instanceof LanguageGenerationError && error.kind === "incomplete") ? "unknown" : "failed", {
        ...(error instanceof LanguageGenerationError ? error.evidence : {}), error_digest: languageFailureDigest(error) });
      throw error;
    }
    if (attempt && !attempt.dispatched) {
      await attempt.finish("unknown", { failure_kind: "missing-dispatch-evidence" });
      throw new Error("Language host returned without dispatch evidence");
    }
    const output = { text: result.text };
    if (validateJsonSchemaValue(LANGUAGE_GENERATE_OUTPUT, output).length || !result.text.trim()) {
      await attempt?.finish("failed", { ...result.evidence, failure_kind: "invalid-output" });
      throw new Error("Generation returned no bounded text");
    }
    const evidence = { ...result.evidence, ...identity, output_digest: sha256(output), ...(attempt ? { attempt_id: attempt.id } : {}) };
    await attempt?.finish("succeeded", evidence);
    return { output, evidence };
  }
}
