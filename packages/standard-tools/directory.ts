import { sha256 } from "../runtime/canonical.ts";
import type { CompiledCompanyTool } from "../companyos-builder/types.ts";
import { DIRECTORY_QUERY_INPUT_SCHEMA, DIRECTORY_QUERY_OUTPUT_SCHEMA } from "../directory/contracts.ts";

const source = `import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({
  async execute(input, context) {
    return await context.capabilities.call("directory.members.query", input);
  }
});`;

export const STANDARD_DIRECTORY_TOOLS: readonly CompiledCompanyTool[] = [{
  contract: {
    grantId: "oregano:directory/members", runtimeId: "oregano:directory/members", agentId: "*", toolId: "directory-members",
    version: "1.0.0", description: "Read bounded directory facts from the reviewed starting Artifact.",
    risk: "R0", dataClass: "personal", idempotency: "input-hash", capabilities: ["directory.members.query"],
    inputSchema: DIRECTORY_QUERY_INPUT_SCHEMA, outputSchema: DIRECTORY_QUERY_OUTPUT_SCHEMA,
    evidence: ["directory_digest", "member_count", "access_decision"],
    failure: "Deny missing, inactive or out-of-scope subjects; directory data never grants authority.",
  },
  compiledSource: source, sourceDigest: sha256(source),
}];
