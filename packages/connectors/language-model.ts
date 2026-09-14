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

  constructor(args: { artifact: CompanyOSArtifact; prompts: LanguagePromptBinding[]; generate: LanguageGenerator }) {
    this.#artifact = structuredClone(args.artifact);
    this.#generate = args.generate;
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
    const result = await this.#generate({ instructions: prompt.instructions, data, agentId: context.agentId, modelTask: prompt.modelTask, modelProfile: prompt.modelProfile, ...(input.attachments?.length ? { attachments: input.attachments } : {}) });
    const output = { text: result.text };
    if (validateJsonSchemaValue(LANGUAGE_GENERATE_OUTPUT, output).length || !result.text.trim()) throw new Error("Generation returned no bounded text");
    return { output, evidence: { ...result.evidence, prompt_path: input.prompt_path, prompt_digest: sha256(prompt.instructions),
      binding_digest: prompt.bindingDigest, model_task: prompt.modelTask, model_profile: prompt.modelProfile,
      context_digest: sha256(input.data), ...(input.attachments?.length ? { attachment_digests: input.attachments.map(file => file.digest) } : {}), output_digest: sha256(output), agent_id: context.agentId,
      artifact_hash: this.#artifact.artifactHash, workspace_commit: this.#artifact.provenance.workspaceCommit } };
  }
}
