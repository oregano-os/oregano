import { sha256 } from "../runtime/canonical.ts";
import { KnowledgeAuthorizer } from "./access-control.ts";
import type { KnowledgeAccessAuditor, KnowledgeAccessPolicy, KnowledgeAccessSubject } from "./contracts.ts";
import type { CurrentBriefView } from "./current-brief.ts";
import type { KnowledgeAuthorityLayer } from "./retrieval-unit.ts";
import type { KnowledgeRetrievalHitV3 } from "./retrieval-v3.ts";

export const KNOWLEDGE_EXPERIENCE_CONTRACT_VERSION = "1.0.0" as const;

export interface OpenLoopCandidate {
  claimId: string;
  loopKind: "commitment" | "question" | "decision-needed" | "follow-up";
  text: string;
  state: "open" | "blocked" | "resolved" | "cancelled";
  ownerPrincipalId?: string;
  dueAt?: string;
  observedAt: string;
  authorityLayer: Exclude<KnowledgeAuthorityLayer, "official">;
  evidence: Array<{ unitId: string; contentDigest: string }>;
  accessPolicyId: string;
}

export interface OpenLoopItem {
  loopId: string;
  claimId: string;
  loopKind: OpenLoopCandidate["loopKind"];
  text: string;
  state: "open" | "blocked";
  ownerPrincipalId?: string;
  dueAt?: string;
  observedAt: string;
  urgency: "overdue" | "due-soon" | "unscheduled" | "scheduled";
  authorityLayer: Exclude<KnowledgeAuthorityLayer, "official">;
  citations: Array<{ unitId: string; contentDigest: string }>;
  accessPolicyId: string;
}

export interface OpenLoopsView {
  contractVersion: typeof KNOWLEDGE_EXPERIENCE_CONTRACT_VERSION;
  viewId: string;
  authorityLayer: "synthesized";
  generatedAt: string;
  items: OpenLoopItem[];
  counts: { open: number; blocked: number; overdue: number; dueSoon: number };
  gaps: string[];
}

export interface OpenLoopStore {
  policies(): Promise<KnowledgeAccessPolicy[]>;
  loadOpenLoops(input: { authorizedPolicyIds: string[]; limit: number }): Promise<OpenLoopCandidate[]>;
}

const required = (value: string, label: string, maximum = 4_000): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\0-\x08\x0b\x0c\x0e-\x1f]/.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
};

const timestamp = (value: string, label: string): string => {
  if (Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(value).toISOString();
};

const citations = (values: Array<{ unitId: string; contentDigest: string }>, label: string): Array<{ unitId: string; contentDigest: string }> => {
  if (values.length === 0 || values.length > 100) throw new Error(`${label} requires a bounded evidence set.`);
  const normalized = values.map((value) => ({ unitId: required(value.unitId, `${label} unit ID`, 1_000), contentDigest: value.contentDigest }));
  if (normalized.some((value) => !/^[a-f0-9]{64}$/.test(value.contentDigest))) throw new Error(`${label} contains an invalid content digest.`);
  if (new Set(normalized.map((value) => value.unitId)).size !== normalized.length) throw new Error(`${label} contains duplicate unit identities.`);
  return normalized.sort((left, right) => left.unitId.localeCompare(right.unitId));
};

export function createOpenLoopsView(input: { candidates: readonly OpenLoopCandidate[]; generatedAt: string; dueSoonMs?: number }): OpenLoopsView {
  const generatedAt = timestamp(input.generatedAt, "Open Loops generation time");
  const dueSoonMs = input.dueSoonMs ?? 7 * 86_400_000;
  if (!Number.isFinite(dueSoonMs) || dueSoonMs <= 0) throw new Error("Open Loops due-soon window must be positive.");
  const now = Date.parse(generatedAt);
  const items = input.candidates.filter((candidate) => ["open", "blocked"].includes(candidate.state)).map((candidate): OpenLoopItem => {
    const dueAt = candidate.dueAt ? timestamp(candidate.dueAt, "Open Loop due time") : undefined;
    const urgency: OpenLoopItem["urgency"] = !dueAt ? "unscheduled" : Date.parse(dueAt) < now ? "overdue" : Date.parse(dueAt) - now <= dueSoonMs ? "due-soon" : "scheduled";
    const base = {
      claimId: required(candidate.claimId, "Open Loop Claim ID", 1_000),
      loopKind: candidate.loopKind,
      text: required(candidate.text, "Open Loop text"),
      state: candidate.state as "open" | "blocked",
      ...(candidate.ownerPrincipalId ? { ownerPrincipalId: required(candidate.ownerPrincipalId, "Open Loop owner", 1_000) } : {}),
      ...(dueAt ? { dueAt } : {}),
      observedAt: timestamp(candidate.observedAt, "Open Loop observation time"),
      urgency,
      authorityLayer: candidate.authorityLayer,
      citations: citations(candidate.evidence, "Open Loop evidence"),
      accessPolicyId: required(candidate.accessPolicyId, "Open Loop access policy", 1_000),
    };
    return { loopId: sha256(base), ...base };
  }).sort((left, right) => {
    const urgency = { overdue: 0, "due-soon": 1, blocked: 2, scheduled: 3, unscheduled: 4 };
    const leftRank = left.state === "blocked" && left.urgency !== "overdue" && left.urgency !== "due-soon" ? urgency.blocked : urgency[left.urgency];
    const rightRank = right.state === "blocked" && right.urgency !== "overdue" && right.urgency !== "due-soon" ? urgency.blocked : urgency[right.urgency];
    return leftRank - rightRank || (left.dueAt ?? "9999").localeCompare(right.dueAt ?? "9999") || left.loopId.localeCompare(right.loopId);
  });
  const counts = { open: items.filter((item) => item.state === "open").length, blocked: items.filter((item) => item.state === "blocked").length, overdue: items.filter((item) => item.urgency === "overdue").length, dueSoon: items.filter((item) => item.urgency === "due-soon").length };
  const gaps = [...(items.some((item) => !item.ownerPrincipalId) ? ["open-loops-without-owner"] : []), ...(items.some((item) => !item.dueAt) ? ["open-loops-without-due-date"] : [])];
  const base = { contractVersion: KNOWLEDGE_EXPERIENCE_CONTRACT_VERSION, authorityLayer: "synthesized" as const, generatedAt, items, counts, gaps };
  return { viewId: sha256(base), ...base };
}

export class OpenLoopsService {
  readonly #store: OpenLoopStore;
  readonly #auditor?: KnowledgeAccessAuditor;
  readonly #resolveSubject?: (subject?: KnowledgeAccessSubject) => Promise<KnowledgeAccessSubject | undefined>;

  constructor(input: { store: OpenLoopStore; auditor?: KnowledgeAccessAuditor; resolveSubject?: (subject?: KnowledgeAccessSubject) => Promise<KnowledgeAccessSubject | undefined> }) {
    this.#store = input.store;
    this.#auditor = input.auditor;
    this.#resolveSubject = input.resolveSubject;
  }

  async get(input: { subject?: KnowledgeAccessSubject; generatedAt?: string; limit?: number; dueSoonMs?: number }): Promise<OpenLoopsView> {
    const subject = this.#resolveSubject ? await this.#resolveSubject(input.subject) : input.subject;
    const policies = await this.#store.policies();
    const authorizer = new KnowledgeAuthorizer(policies, this.#auditor);
    const authorizedPolicyIds: string[] = [];
    for (const policy of [...policies].sort((left, right) => left.policyId.localeCompare(right.policyId))) {
      if (await authorizer.authorize({ subject, permission: "read", policyIds: [policy.policyId], objectType: "policy", objectId: policy.policyId })) authorizedPolicyIds.push(policy.policyId);
    }
    const candidates = authorizedPolicyIds.length === 0 ? [] : await this.#store.loadOpenLoops({ authorizedPolicyIds, limit: Math.max(1, Math.min(input.limit ?? 100, 500)) });
    return createOpenLoopsView({ candidates, generatedAt: input.generatedAt ?? new Date().toISOString(), dueSoonMs: input.dueSoonMs });
  }
}

export interface MeetingPrepView {
  contractVersion: typeof KNOWLEDGE_EXPERIENCE_CONTRACT_VERSION;
  prepId: string;
  authorityLayer: "synthesized";
  meeting: { identity: string; title: string; startsAt: string; attendeeIdentities: string[] };
  currentBriefs: Array<{ identity: string; title: string; freshnessStatus: CurrentBriefView["freshnessStatus"]; content: string; citation: { unitId: string; contentDigest: string }; gaps: string[] }>;
  openLoops: OpenLoopItem[];
  recentEvidence: Array<{ unitId: string; title: string; excerpt: string; authorityLayer: KnowledgeAuthorityLayer; state: string; contentDigest: string }>;
  conflicts: string[];
  headsUp: string[];
  generatedAt: string;
}

export function createMeetingPrepView(input: {
  meeting: { identity: string; title: string; startsAt: string; attendeeIdentities: string[] };
  currentBriefs: readonly CurrentBriefView[];
  openLoops: OpenLoopsView;
  recentEvidence: readonly KnowledgeRetrievalHitV3[];
  generatedAt: string;
  maximumItems?: number;
}): MeetingPrepView {
  const maximumItems = Math.max(1, Math.min(input.maximumItems ?? 12, 50));
  const meeting = {
    identity: required(input.meeting.identity, "Meeting identity", 1_000),
    title: required(input.meeting.title, "Meeting title"),
    startsAt: timestamp(input.meeting.startsAt, "Meeting start time"),
    attendeeIdentities: [...new Set(input.meeting.attendeeIdentities.map((value) => required(value, "Meeting attendee", 1_000)))].sort(),
  };
  const generatedAt = timestamp(input.generatedAt, "Meeting Prep generation time");
  const currentBriefs = [...input.currentBriefs].sort((left, right) => left.identity.localeCompare(right.identity)).slice(0, maximumItems).map((brief) => ({
    identity: brief.identity,
    title: brief.title,
    freshnessStatus: brief.freshnessStatus,
    content: brief.content,
    citation: { unitId: `synthesis:${brief.synthesisId}`, contentDigest: brief.contentDigest },
    gaps: [...brief.gaps],
  }));
  const openLoops = input.openLoops.items.slice(0, maximumItems).map((item) => structuredClone(item));
  const recentEvidence = [...input.recentEvidence].sort((left, right) => right.score - left.score || left.unitId.localeCompare(right.unitId)).slice(0, maximumItems).map((hit) => ({ unitId: hit.unitId, title: hit.title, excerpt: hit.excerpt, authorityLayer: hit.authorityLayer, state: hit.state, contentDigest: hit.contentDigest }));
  const conflicts = [...new Set([
    ...currentBriefs.filter((brief) => brief.freshnessStatus === "potentially-stale").map((brief) => `stale-brief:${brief.identity}`),
    ...recentEvidence.filter((hit) => hit.state === "contested").map((hit) => `contested:${hit.unitId}`),
  ])].sort();
  const headsUp = [...new Set([
    ...currentBriefs.flatMap((brief) => brief.gaps),
    ...input.openLoops.gaps,
    ...(openLoops.some((loop) => loop.urgency === "overdue") ? ["overdue-open-loops"] : []),
    ...(currentBriefs.length === 0 ? ["no-current-brief"] : []),
    ...(recentEvidence.length === 0 ? ["no-recent-evidence"] : []),
  ])].sort();
  const base = { contractVersion: KNOWLEDGE_EXPERIENCE_CONTRACT_VERSION, authorityLayer: "synthesized" as const, meeting, currentBriefs, openLoops, recentEvidence, conflicts, headsUp, generatedAt };
  return { prepId: sha256(base), ...base };
}
