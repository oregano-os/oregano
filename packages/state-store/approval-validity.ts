import type { ApprovalRequestRow } from "./interface.ts";

/** Core safety default for callers without a workflow deadline. Workflows supply their exact deadline. */
export const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export function approvalExpiry(expiresAt?: Date, now = new Date()): Date {
  const timestamp = expiresAt === undefined ? now.getTime() + DEFAULT_APPROVAL_TTL_MS : expiresAt.getTime();
  if (!Number.isFinite(timestamp)) throw new Error("Approval expiry must be a valid finite instant.");
  return new Date(timestamp);
}

export function approvalIsUnexpired(request: Pick<ApprovalRequestRow, "expiresAt">, now = new Date()): boolean {
  return request.expiresAt instanceof Date && Number.isFinite(request.expiresAt.getTime()) && request.expiresAt.getTime() > now.getTime();
}
