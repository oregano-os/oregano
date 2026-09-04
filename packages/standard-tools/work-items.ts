import { sha256 } from "../runtime/canonical.ts";
import type { CompiledCompanyTool } from "../companyos-builder/types.ts";
import type { CompanyToolContract } from "../tool-sdk/contracts.ts";

const create = (contract: CompanyToolContract, source: string): CompiledCompanyTool => ({ contract, compiledSource: source, sourceDigest: sha256(source) });
const call = (capability: string): string => `import { defineCompanyTool } from "@companyos/tool-sdk";
export default defineCompanyTool({
  async execute(input, context) {
    return await context.capabilities.call("${capability}", input);
  }
});`;

export const STANDARD_WORK_ITEM_TOOLS: readonly CompiledCompanyTool[] = [
  create({
    grantId: "oregano:work-items/read", runtimeId: "oregano:work-items/read", agentId: "*", toolId: "work-item-read", version: "1.0.0",
    description: "Read one bounded work item through an exact Instance resource binding.", risk: "R0", dataClass: "business", idempotency: "input-hash",
    capabilities: ["work-item.read"],
    inputSchema: { type: "object", required: ["resource_binding", "work_item_id"], additionalProperties: false, properties: { resource_binding: { type: "string", minLength: 1, maxLength: 63 }, work_item_id: { type: "string", minLength: 1, maxLength: 255 }, fields: { type: "array", maxItems: 100, items: { type: "string", minLength: 1, maxLength: 127 } } } },
    outputSchema: { type: "object" }, evidence: ["resource_binding", "work_item_id", "provider_version", "observed_at"],
    failure: "Fail closed when the item is outside the bound resource or a requested field is not exposed.",
  }, call("work-item.read")),
  create({
    grantId: "oregano:work-items/update", runtimeId: "oregano:work-items/update", agentId: "*", toolId: "work-item-update", version: "1.0.0",
    description: "Update allowlisted fields on one work item after normal approval and effect claiming.", risk: "R2", dataClass: "business", idempotency: "input-hash",
    capabilities: ["work-item.update"],
    inputSchema: { type: "object", required: ["resource_binding", "work_item_id", "changes", "expected_version"], additionalProperties: false, properties: { resource_binding: { type: "string", minLength: 1, maxLength: 63 }, work_item_id: { type: "string", minLength: 1, maxLength: 255 }, changes: { type: "object" }, expected_version: { type: "string", minLength: 1, maxLength: 255 } } },
    outputSchema: { type: "object" }, evidence: ["resource_binding", "work_item_id", "previous_version", "provider_version", "changed_fields"],
    failure: "Refuse stale versions, unallowlisted fields, read-only resources, missing idempotency claims, or unknown effects.",
  }, call("work-item.update")),
  create({
    grantId: "oregano:work-items/confirmed-update", runtimeId: "oregano:work-items/confirmed-update", agentId: "*", toolId: "work-item-confirmed-update", version: "1.0.0",
    description: "Prepare one reversible version-bound work-item update and execute it only after the active human subject confirms it.", risk: "R2", dataClass: "business", idempotency: "input-hash",
    capabilities: ["work-item.update"], confirmation: "subject",
    inputSchema: { type: "object", required: ["resource_binding", "work_item_id", "changes", "expected_version"], additionalProperties: false, properties: { resource_binding: { type: "string", minLength: 1, maxLength: 63 }, work_item_id: { type: "string", minLength: 1, maxLength: 255 }, changes: { type: "object" }, expected_version: { type: "string", minLength: 1, maxLength: 255 } } },
    outputSchema: { type: "object" }, evidence: ["resource_binding", "work_item_id", "previous_version", "provider_version", "changed_fields", "subject_confirmation"],
    failure: "Refuse an absent, expired, inactive, mismatched, or replayed subject confirmation and preserve the normal version and read-after-write controls.",
  }, call("work-item.update")),
  create({
    grantId: "oregano:work-items/comment", runtimeId: "oregano:work-items/comment", agentId: "*", toolId: "work-item-comment", version: "1.0.0",
    description: "Append one bounded attributed work-item comment after normal effect control.", risk: "R2", dataClass: "business", idempotency: "input-hash",
    capabilities: ["work-item.comment"],
    inputSchema: { type: "object", required: ["resource_binding", "work_item_id", "body"], additionalProperties: false, properties: { resource_binding: { type: "string", minLength: 1, maxLength: 63 }, work_item_id: { type: "string", minLength: 1, maxLength: 255 }, body: { type: "string", minLength: 1, maxLength: 10_000 } } },
    outputSchema: { type: "object" }, evidence: ["resource_binding", "work_item_id", "comment_id", "provider_version", "created_at"],
    failure: "Refuse unbound or read-only resources and never retry without the same claimed idempotency key.",
  }, call("work-item.comment")),
  create({
    grantId: "oregano:work-items/batch-update", runtimeId: "oregano:work-items/batch-update", agentId: "*", toolId: "work-item-batch-update", version: "1.0.0",
    description: "Apply one frozen homogeneous work-item update set only after an R3 human approval.", risk: "R3", dataClass: "business", idempotency: "input-hash",
    capabilities: ["work-item.batch-update"],
    inputSchema: { type: "object", required: ["resource_binding", "updates"], additionalProperties: false, properties: { resource_binding: { type: "string", minLength: 1, maxLength: 63 }, updates: { type: "array", minItems: 1, maxItems: 1_000, items: { type: "object", required: ["work_item_id", "changes", "expected_version"], additionalProperties: false, properties: { work_item_id: { type: "string", minLength: 1, maxLength: 255 }, changes: { type: "object" }, expected_version: { type: "string", minLength: 1, maxLength: 255 } } } } } },
    outputSchema: { type: "object" }, evidence: ["resource_binding", "work_item_ids", "previous_versions", "provider_versions", "changed_fields"],
    failure: "Fail before the first write on any stale item; after dispatch, retain explicit unknown partial evidence and never retry as though no effect occurred.",
  }, call("work-item.batch-update")),
] as const;
