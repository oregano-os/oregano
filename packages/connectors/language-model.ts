import type { CapabilityCallContext, Connector } from "../capabilities/contracts.ts";
import type { CompanyOSArtifact } from "../companyos-builder/types.ts";
import type { LanguageGenerator } from "../language/contracts.ts";
import { LANGUAGE_GENERATE_INPUT, LANGUAGE_GENERATE_OUTPUT } from "../language/contracts.ts";
import { validateJsonSchemaValue } from "../capabilities/validation.ts";
import { sha256 } from "../runtime/canonical.ts";

export interface LanguagePromptBinding { agent_id: string; path: string }

/** Frozen, explicitly bound Skill instructions plus evidence-only input data. */
export class LanguageModelConnector implements Connector {
  readonly id = "oregano/language-model";
  readonly version = "1.0.0";
  readonly capabilities = ["language.generate"];
  readonly #artifact: CompanyOSArtifact;
  readonly #prompts = new Map<string, { instructions: string; modelTask: string }>();
  readonly #generate: LanguageGenerator;

  constructor(args: { artifact: CompanyOSArtifact; prompts: LanguagePromptBinding[]; generate: LanguageGenerator }) {
    this.#artifact = structuredClone(args.artifact);
    this.#generate = args.generate;
    if (!Array.isArray(args.prompts) || args.prompts.length < 1 || args.prompts.length > 100) throw new Error("Declare bounded generation prompt bindings");
    for (const binding of args.prompts) {
      if (!binding || typeof binding.agent_id !== "string" || typeof binding.path !== "string"
        || Object.keys(binding).sort().join(",") !== "agent_id,path"
        || binding.path.split("/").some(part => !part || part === "." || part === "..")
        || !/(?:^|\/)skills\/.+\.md$/.test(binding.path)) throw new Error("Generation prompt must be a scoped Skill Markdown path");
      const agent = this.#artifact.agents.find(agent => agent.id === binding.agent_id);
      const instructions = agent?.materials[binding.path];
      if (!agent || typeof instructions !== "string" || !instructions.trim() || instructions.length > 16_000) throw new Error("Generation prompt is missing from the owning Agent's scoped Artifact materials");
      if (!agent.modelTask) throw new Error("Generation requires an explicit owning Agent model task");
      const key = JSON.stringify([agent.id, binding.path]);
      if (this.#prompts.has(key)) throw new Error("Duplicate generation prompt binding");
      this.#prompts.set(key, { instructions, modelTask: agent.modelTask });
    }
  }

  async invoke(capability: string, raw: unknown, context: CapabilityCallContext) {
    if (capability !== "language.generate" || context.instanceId !== this.#artifact.instance.id
      || context.subject?.status !== "active") throw new Error("Generation requires an active subject in the bound Instance");
    if (validateJsonSchemaValue(LANGUAGE_GENERATE_INPUT, raw).length) throw new Error("Invalid bounded language generation input");
    const input = raw as { prompt_path: string; data: Record<string, unknown> };
    const prompt = this.#prompts.get(JSON.stringify([context.agentId, input.prompt_path]));
    if (!prompt) throw new Error("Generation prompt is not bound for this Agent");
    const data = JSON.stringify(input.data);
    if (data.length > 150_000) throw new Error("Generation evidence exceeds its bound; narrow the reviewed data selection");
    const result = await this.#generate({ instructions: prompt.instructions, data, agentId: context.agentId, modelTask: prompt.modelTask });
    const output = { text: result.text };
    if (validateJsonSchemaValue(LANGUAGE_GENERATE_OUTPUT, output).length || !result.text.trim()) throw new Error("Generation returned no bounded text");
    return { output, evidence: { ...result.evidence, prompt_path: input.prompt_path, prompt_digest: sha256(prompt.instructions),
      context_digest: sha256(input.data), output_digest: sha256(output), agent_id: context.agentId,
      artifact_hash: this.#artifact.artifactHash, workspace_commit: this.#artifact.provenance.workspaceCommit } };
  }
}
