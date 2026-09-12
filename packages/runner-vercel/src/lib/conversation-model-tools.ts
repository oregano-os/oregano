import { tool, jsonSchema, type ToolSet } from "ai";
import { CONVERSATION_CONTROL_TOOL, ConversationParticipation, type Participation } from "../../../runtime/conversation-participation.ts";

/** Extend the existing Agent Tool loop; never invoke another Agent or model. */
export function withConversationParticipation(tools: ToolSet, turn: ConversationParticipation): ToolSet {
  if (!turn.ambient) return tools;
  const guarded = Object.fromEntries(Object.entries(tools).map(([name, definition]) => [name, {
    ...definition,
    ...(definition.execute ? { execute: (...args: Parameters<NonNullable<typeof definition.execute>>) => {
      turn.assertResponding();
      return definition.execute!(...args);
    } } : {}),
  }])) as ToolSet;
  guarded[CONVERSATION_CONTROL_TOOL] = tool({
    description: "Choose whether YOU are addressed in this shared conversation. Context-only retains the message with no visible output or work. Respond permits your normal existing Tools; it grants no business authority. Optionally include the complete answer when no Tools are needed.",
    inputSchema: jsonSchema<{ participation: Participation; text?: string }>({ type: "object", additionalProperties: false,
      required: ["participation"], properties: { participation: { type: "string", enum: ["respond", "context-only"] }, text: { type: "string", minLength: 1, maxLength: 16000 } } }),
    execute: async input => { turn.choose(input.participation, input.text); return { participation: turn.choice, responseRecorded: input.text !== undefined }; },
  });
  return guarded;
}

export function participationStep(turn: ConversationParticipation): { activeTools: string[]; toolChoice: "required" } | undefined {
  if (!turn.ambient || turn.choice) return undefined;
  return { activeTools: [CONVERSATION_CONTROL_TOOL], toolChoice: "required" };
}
