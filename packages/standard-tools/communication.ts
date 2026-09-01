import { sha256 } from "../runtime/canonical.ts";
import type { CompiledCompanyTool } from "../companyos-builder/types.ts";
import type { CompanyToolContract } from "../tool-sdk/contracts.ts";

const source = `import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({
  async execute(input, context) {
    return await context.capabilities.call("communication.message.publish", input);
  }
});`;

const contract: CompanyToolContract = {
  grantId: "oregano:communications/publish",
  runtimeId: "oregano:communications/publish",
  agentId: "*",
  toolId: "communication-message-publish",
  version: "1.0.0",
  description: "Publish one bounded internal message through an exact Instance destination binding.",
  risk: "R2",
  dataClass: "business",
  idempotency: "input-hash",
  capabilities: ["communication.message.publish"],
  inputSchema: {
    type: "object",
    required: ["destination_binding", "content"],
    additionalProperties: false,
    properties: {
      destination_binding: { type: "string", minLength: 1, maxLength: 63 },
      content: { type: "string", minLength: 1, maxLength: 20_000 },
      thread_reference: { type: "string", minLength: 1, maxLength: 1_000 },
      format: { type: "string", enum: ["plain-text", "provider-markdown"] },
    },
  },
  outputSchema: { type: "object" },
  evidence: ["destination_binding", "message_id", "thread_reference", "published_at", "connector"],
  failure: "Fail closed for unbound destinations, ambiguous provider receipts, or missing idempotency claims; never broaden the configured audience.",
};

export const STANDARD_COMMUNICATION_TOOLS: readonly CompiledCompanyTool[] = [{
  contract,
  compiledSource: source,
  sourceDigest: sha256(source),
}];
