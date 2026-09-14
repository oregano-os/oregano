import type { CompanyOSArtifact } from "../companyos-builder/types.ts";
import { sha256 } from "../runtime/canonical.ts";

export const DEFAULT_INSTRUCTION_CHARACTERS = 16_000;
/** Explicit per-binding ceiling; evidence, output and deadlines are independent. */
export const MAX_INSTRUCTION_CHARACTERS = 30_000;
export const LANGUAGE_MODEL_PROFILES = ["agent", "utility", "reasoning", "deep"] as const;
export type LanguageModelProfile = typeof LANGUAGE_MODEL_PROFILES[number];
export interface LanguagePromptBinding {
  agent_id: string;
  path: string;
  model_task?: string;
  model_profile?: LanguageModelProfile;
  max_instruction_characters?: number;
}

export function bindLanguagePrompts(artifact: CompanyOSArtifact, bindings: LanguagePromptBinding[]) {
  if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 100) throw new Error("Declare bounded generation prompt bindings");
  const prompts = new Map<string, ReturnType<typeof bindLanguagePrompt>>();
  for (const binding of bindings) {
    const prompt = bindLanguagePrompt(artifact, binding);
    const key = JSON.stringify([binding.agent_id, binding.path]);
    if (prompts.has(key)) throw new Error("Duplicate generation prompt binding");
    prompts.set(key, prompt);
  }
  return prompts;
}

/** Only trusted Instance configuration reaches this validator, never evidence. */
export function bindLanguagePrompt(artifact: CompanyOSArtifact, raw: LanguagePromptBinding) {
  const allowed = new Set(["agent_id", "path", "model_task", "model_profile", "max_instruction_characters"]);
  if (!raw || Array.isArray(raw) || Object.keys(raw).some(key => !allowed.has(key))
    || typeof raw.agent_id !== "string" || typeof raw.path !== "string"
    || raw.path.includes("\\") || raw.path.includes("\0")
    || raw.path.split("/").some(part => !part || part === "." || part === "..")
    || !/(?:^|\/)skills\/.+\.md$/.test(raw.path)) throw new Error("Generation prompt must be a scoped Skill Markdown path");
  const hasTask = Object.hasOwn(raw, "model_task"), hasProfile = Object.hasOwn(raw, "model_profile");
  if (hasTask !== hasProfile || (hasTask && (typeof raw.model_task !== "string"
    || !/^[a-z][a-z0-9._-]{0,255}$/.test(raw.model_task)
    || !LANGUAGE_MODEL_PROFILES.includes(raw.model_profile!)))) throw new Error("Generation task and language profile must be explicitly bound together");
  const limit = Object.hasOwn(raw, "max_instruction_characters") ? raw.max_instruction_characters : DEFAULT_INSTRUCTION_CHARACTERS;
  if (!Number.isInteger(limit) || limit! < 1 || limit! > MAX_INSTRUCTION_CHARACTERS) throw new Error("Invalid bounded generation instruction capacity");
  if (limit! > DEFAULT_INSTRUCTION_CHARACTERS && !hasTask) throw new Error("Extended instruction capacity requires an explicit phase task and profile binding");
  const agent = artifact.agents.find(candidate => candidate.id === raw.agent_id);
  const instructions = agent?.materials[raw.path];
  if (!agent || typeof instructions !== "string" || !instructions.trim() || instructions.length > limit!) throw new Error("Generation prompt is missing or exceeds its bound in the owning Agent's scoped Artifact materials");
  const modelTask = hasTask ? raw.model_task! : agent.modelTask;
  if (!modelTask) throw new Error("Generation requires an explicit owning Agent model task or phase binding");
  const binding = { agent_id: agent.id, path: raw.path, model_task: modelTask,
    model_profile: raw.model_profile ?? "agent", max_instruction_characters: limit! };
  return { instructions, modelTask, modelProfile: binding.model_profile, bindingDigest: sha256(binding) };
}
