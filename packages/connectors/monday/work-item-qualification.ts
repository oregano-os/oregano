import { MondayClient } from "./client.ts";
import type { MondayResourceBinding } from "./contracts.ts";
import { MONDAY_EXTERNAL_AGENT_KINDS, normalizeMondayEffectiveAccess } from "./external-agent-qualification.ts";

export interface MondayCredentialIdentity {
  account_id: string;
  member_id: string;
  kind: string;
  external_agent_id: string;
}

/** Non-secret reviewed Instance expectations, never learned from the current token. */
export function mondayCredentialIdentity(value: unknown, actorId: string): MondayCredentialIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Monday credential_identity must pin the reviewed provider identity");
  const record = value as Record<string, unknown>, keys = ["account_id", "member_id", "kind", "external_agent_id"];
  if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key))) throw new Error("Monday credential_identity contains missing or unsupported fields");
  for (const key of ["account_id", "member_id", "external_agent_id"]) if (typeof record[key] !== "string" || !/^\d{1,20}$/.test(record[key])) throw new Error(`Monday credential_identity.${key} must be an exact provider ID`);
  if (typeof record.kind !== "string" || !MONDAY_EXTERNAL_AGENT_KINDS.includes(record.kind)) throw new Error("Monday credential_identity must identify a qualified external Agent");
  if (actorId !== record.member_id) throw new Error("Monday actor_id must match the reviewed authenticated member ID");
  return structuredClone(record) as unknown as MondayCredentialIdentity;
}

/** Read metadata with the very same client that will perform the operation. */
export async function qualifyMondayWorkItemCredential(args: {
  client: MondayClient; expected: MondayCredentialIdentity; binding: MondayResourceBinding; now?: () => Date;
}): Promise<Record<string, unknown>> {
  const { client, binding } = args;
  const expected = mondayCredentialIdentity(args.expected, args.expected.member_id);
  if (new Set(Object.values(binding.fields)).size !== Object.keys(binding.fields).length) throw new Error("Monday field bindings cannot alias one provider column");
  const result = await client.discoverAgentResources({ agentId: expected.external_agent_id, boardIds: [binding.boardId] });
  const identity = result.data.identity;
  if (result.data.account.id !== expected.account_id || identity.memberId !== expected.member_id || identity.kind !== expected.kind
    || identity.externalAgentId !== expected.external_agent_id) throw new Error("Monday credential differs from its reviewed account and external-Agent identity");
  if (result.apiVersion && result.apiVersion !== client.apiVersion) throw new Error("Monday credential qualification returned another API version");
  const board = result.data.boards[0];
  if (!board || result.data.boards.length !== 1 || board.id !== binding.boardId || board.state !== "active") throw new Error("Monday resource is not the exact active qualified board");
  const access = normalizeMondayEffectiveAccess(board.accessLevel);
  if (binding.permission === "read-write" ? access !== "read-write" : !["read", "read-write"].includes(access)) throw new Error("Monday resource no longer has the reviewed minimum access");
  for (const columnId of Object.values(binding.fields)) {
    const columns = board.columns.filter((column) => column.id === columnId && !column.archived);
    if (columns.length !== 1) throw new Error("Monday resource no longer has one exact active mapped column");
  }
  return { ...expected, resource_binding: binding.id, board_id: binding.boardId, permission: binding.permission,
    effective_access: access, observed_at: (args.now?.() ?? new Date()).toISOString(), api_version_requested: client.apiVersion,
    api_version_reported: result.apiVersion, request_id: result.requestId, provider_write_effect_verified: false };
}
