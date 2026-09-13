import { AttachmentInputError } from "../runtime/attachments.ts";
import policyData from "./attachment-policies.json" with { type: "json" };

export interface AttachmentPolicy {
  readonly modelPatterns: readonly string[];
  readonly maxAttachments: number;
  readonly maxTotalBytes: number;
  readonly maxRequestBytes: number;
  readonly maxTextBytes: number;
  readonly formats: Readonly<Record<string, { readonly representation: "text" | "image" | "file"; readonly maxBytes: number }>>;
  readonly sources: readonly string[];
}
export interface AttachmentPolicyConfiguration {
  readonly version: 1;
  readonly reviewedAt: string;
  readonly providers: Readonly<Record<string, AttachmentPolicy>>;
}

/** Policy is reviewed Core data, not Workspace instructions or model output. */
export function validateAttachmentPolicies(value: unknown): AttachmentPolicyConfiguration {
  const config = value as AttachmentPolicyConfiguration;
  if (!config || config.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(config.reviewedAt)
    || !config.providers || Array.isArray(config.providers)) throw new Error("Invalid Core attachment policy configuration.");
  for (const policy of Object.values(config.providers)) {
    if (!policy || !Array.isArray(policy.modelPatterns) || !policy.modelPatterns.length
      || policy.modelPatterns.some(pattern => typeof pattern !== "string" || !/^[a-zA-Z0-9/._-]+\*?$/.test(pattern))) throw new Error("Invalid attachment model patterns.");
    for (const key of ["maxAttachments", "maxTotalBytes", "maxRequestBytes", "maxTextBytes"] as const) {
      if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0) throw new Error(`Invalid attachment policy ${key}.`);
    }
    if (!policy.formats || !Object.keys(policy.formats).length || !Array.isArray(policy.sources)) throw new Error("Attachment policy requires formats and sources.");
    for (const [mime, format] of Object.entries(policy.formats)) {
      if (!/^[a-z]+\/[a-z0-9.+-]+$/.test(mime) || !["text", "image", "file"].includes(format.representation)
        || !Number.isSafeInteger(format.maxBytes) || format.maxBytes <= 0 || format.maxBytes > policy.maxTotalBytes) throw new Error("Invalid attachment format policy.");
      Object.freeze(format);
    }
    Object.freeze(policy.formats); Object.freeze(policy.modelPatterns); Object.freeze(policy.sources); Object.freeze(policy);
  }
  Object.freeze(config.providers);
  return Object.freeze(config);
}
export const CORE_ATTACHMENT_POLICIES = validateAttachmentPolicies(policyData);

export function attachmentPolicy(selection: { route: string; model: string }, configuration = CORE_ATTACHMENT_POLICIES): AttachmentPolicy {
  const policy = Object.hasOwn(configuration.providers, selection.route) ? configuration.providers[selection.route] : undefined;
  if (!policy || !policy.modelPatterns.some(pattern => pattern.endsWith("*")
    ? selection.model.startsWith(pattern.slice(0, -1)) : selection.model === pattern)) {
    throw new AttachmentInputError("Attachments are unavailable for the selected provider/model. Select a model qualified in the Core attachment policy.");
  }
  return policy;
}
