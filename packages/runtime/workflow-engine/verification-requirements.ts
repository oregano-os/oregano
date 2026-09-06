/** Acceptance requirements never disable verification of an executed step. */
export const WORKFLOW_VERIFICATION_REQUIREMENTS = ["wait", "human-decision", "record-source", "approved-batch"] as const;
export type WorkflowVerificationRequirement = typeof WORKFLOW_VERIFICATION_REQUIREMENTS[number];

export function parseWorkflowVerificationRequirements(value?: unknown): WorkflowVerificationRequirement[] {
  if (value === undefined) return [...WORKFLOW_VERIFICATION_REQUIREMENTS];
  if (!Array.isArray(value) || !value.length || value.length > WORKFLOW_VERIFICATION_REQUIREMENTS.length
    || new Set(value).size !== value.length || value.some((entry) => !WORKFLOW_VERIFICATION_REQUIREMENTS.includes(entry))) {
    throw new Error("Workflow verification requires a nonempty unique set of supported evidence requirements.");
  }
  return WORKFLOW_VERIFICATION_REQUIREMENTS.filter((entry) => value.includes(entry));
}
