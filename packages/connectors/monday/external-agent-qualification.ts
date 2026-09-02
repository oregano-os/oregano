import { createHash } from "node:crypto";
import type {
  MondayAgentResourceDiscovery,
  MondayGraphqlResponse,
} from "./contracts.ts";

export const MONDAY_EXTERNAL_AGENT_API_VERSION = "dev";
export const MONDAY_EXTERNAL_AGENT_KINDS = Object.freeze([
  "external_agent_detached_member",
  "external_agent_member",
]);

export interface MondayAgentBoardAccessExpectation {
  readonly id: string;
  readonly permission: "read" | "read-write";
}

const sha256 = (value: unknown): string => createHash("sha256")
  .update(typeof value === "string" ? value : JSON.stringify(value))
  .digest("hex");

const normalizeEffectiveAccess = (value: string): string => value === "view"
  ? "read"
  : value === "edit"
    ? "read-write"
    : String(value ?? "").normalize("NFC").trim().toLowerCase();

export function createMondayExternalAgentQualificationEvidence(args: {
  readonly agentId: string;
  readonly apiVersion: string;
  readonly boards: readonly MondayAgentBoardAccessExpectation[];
  readonly planHash: string;
  readonly result: MondayGraphqlResponse<MondayAgentResourceDiscovery>;
  readonly observedAt: string;
}) {
  const { agentId, apiVersion, boards, planHash, result, observedAt } = args;
  const identity = result.data.identity;
  if (!MONDAY_EXTERNAL_AGENT_KINDS.includes(identity.kind)) {
    throw new Error(`Monday token identifies '${identity.kind || "unknown"}' instead of an external Agent.`);
  }
  if (!/^\d{1,20}$/.test(identity.externalAgentId ?? "")) {
    throw new Error("Monday token does not expose a valid external Agent subject ID.");
  }
  const returnedBoards = result.data.boards.map((board) => String(board.id)).sort();
  const expectedBoards = boards.map((board) => board.id).sort();
  if (JSON.stringify(returnedBoards) !== JSON.stringify(expectedBoards)) {
    throw new Error("Monday did not return exactly the confirmed boards for the external Agent.");
  }
  const accessByBoard = new Map(result.data.boards.map((board) => [String(board.id), normalizeEffectiveAccess(board.accessLevel)]));
  const effectiveAccess = boards.map((board) => ({
    id: board.id,
    scope: "board",
    verified_minimum: board.permission === "read-write" ? "read-write-metadata" : "read",
    administrator_attested_permission: board.permission,
    access_level: result.data.boards.find((candidate) => String(candidate.id) === board.id)?.accessLevel ?? null,
    provider_write_effect_verified: false,
  }));
  for (const board of boards) {
    const access = accessByBoard.get(board.id);
    const valid = board.permission === "read" ? ["read", "read-write"].includes(access ?? "") : access === "read-write";
    if (!valid) {
      throw new Error(`Monday board '${board.id}' does not expose the minimum effective access required by the administrator-attested '${board.permission}' permission.`);
    }
  }
  if (result.apiVersion && result.apiVersion !== apiVersion) {
    throw new Error(`Monday reported API version '${result.apiVersion}' instead of '${apiVersion}'.`);
  }

  const resources = boards.map((board) => ({
    id: board.id,
    scope: "board",
    permission: board.permission,
    evidence: "administrator-attestation-and-effective-access",
  }));
  const discoveryWithoutHash = {
    schema_version: 1,
    kind: "monday-external-agent-discovery-receipt",
    observed_at: observedAt,
    authentication_mode: "external-agent",
    configured_agent_id: agentId,
    identity_mapping_status: "administrator-review-required",
    api_version_requested: apiVersion,
    api_version_reported: result.apiVersion,
    request_id: result.requestId,
    identity: result.data.identity,
    account: result.data.account,
    resources,
    grant_inventory: {
      complete_set_source: "administrator-attestation",
      attestation_plan_hash: planHash,
      machine_listed_by_authenticated_agent: false,
    },
    effective_access: effectiveAccess,
    boards: result.data.boards,
    external_effects: [],
    credentials_retained: false,
  };
  const discovery = { ...discoveryWithoutHash, discovery_hash: sha256(discoveryWithoutHash) };
  const identityReviewBody = {
    schema_version: 1,
    kind: "monday-agent-identity-mapping-review",
    plan_hash: planHash,
    configured_agent_id: agentId,
    authenticated_identity: {
      member_id: discovery.identity.memberId,
      external_agent_subject_id: discovery.identity.externalAgentId,
      name: discovery.identity.name,
      kind: discovery.identity.kind,
      account_id: discovery.account.id,
    },
    discovery_hash: discovery.discovery_hash,
  };
  const identityReview = {
    ...identityReviewBody,
    confirmation_hash: sha256(identityReviewBody),
    summary: identityReviewBody,
  };
  return { discovery, identity_review: identityReview };
}

export function assertMondayExternalAgentQualificationEvidence(args: {
  readonly agentId: string;
  readonly apiVersion: string;
  readonly boards: readonly MondayAgentBoardAccessExpectation[];
  readonly planHash: string;
  readonly evidence: ReturnType<typeof createMondayExternalAgentQualificationEvidence>;
}): void {
  const { agentId, apiVersion, boards, planHash, evidence } = args;
  const discovery = evidence?.discovery;
  const review = evidence?.identity_review;
  if (!discovery || !review || discovery.kind !== "monday-external-agent-discovery-receipt") {
    throw new Error("Monday qualification evidence is incomplete.");
  }
  if (discovery.authentication_mode !== "external-agent" || discovery.credentials_retained !== false) {
    throw new Error("Monday qualification evidence does not preserve external-Agent credential isolation.");
  }
  if (discovery.configured_agent_id !== agentId || discovery.api_version_requested !== apiVersion) {
    throw new Error("Monday qualification evidence identifies another Agent or API version.");
  }
  const expectedResources = boards.map((board) => ({ id: board.id, permission: board.permission }));
  const actualResources = discovery.resources.map((resource) => ({ id: resource.id, permission: resource.permission }));
  if (JSON.stringify(actualResources) !== JSON.stringify(expectedResources)) {
    throw new Error("Monday qualification evidence identifies another board-access set.");
  }
  const { discovery_hash: discoveryHash, ...discoveryBody } = discovery;
  if (discoveryHash !== sha256(discoveryBody)) throw new Error("Monday qualification discovery digest is invalid.");
  const { confirmation_hash: confirmationHash, summary, ...reviewBody } = review;
  if (review.plan_hash !== planHash || review.configured_agent_id !== agentId || review.discovery_hash !== discoveryHash || confirmationHash !== sha256(reviewBody)) {
    throw new Error("Monday qualification identity-review digest is invalid.");
  }
  if (JSON.stringify(summary) !== JSON.stringify(reviewBody)) throw new Error("Monday qualification identity-review summary is invalid.");
}
