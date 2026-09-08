import type { JsonSchema } from "../capabilities/contracts.ts";

export const LANGUAGE_GENERATE_INPUT: JsonSchema = {
  type: "object", additionalProperties: false, required: ["prompt_path", "data"],
  properties: {
    prompt_path: { type: "string", minLength: 1, maxLength: 500 },
    data: { type: "object" },
  },
};
export const LANGUAGE_GENERATE_OUTPUT: JsonSchema = {
  type: "object", additionalProperties: false, required: ["text"],
  properties: { text: { type: "string", minLength: 1, maxLength: 20_000 } },
};

/** Provider execution stays in the host; no Company Tool receives a client. */
export interface LanguageGenerationRequest {
  instructions: string;
  data: string;
  agentId: string;
  modelTask: string;
}
export interface LanguageGenerationResult {
  text: string;
  evidence: Record<string, unknown>;
}
export type LanguageGenerator = (request: LanguageGenerationRequest) => Promise<LanguageGenerationResult>;
export const LANGUAGE_TOOL_TIMEOUT_MS = 65_000;
