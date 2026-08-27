import { sha256 } from "../runtime/canonical.ts";
import YAML from "yaml";
import type { KnowledgeBundle, KnowledgePromotionProposal, ReviewCandidate, ReviewRoute } from "./contracts.ts";
import { QUARANTINE_POLICY_ID } from "./access-control.ts";
import { scanCredentialIndicators } from "../security/credential-scanner.ts";
import type { RuntimeObservation } from "./source-contracts.ts";

export interface RuntimeObservationInput {
  subject: string;
  content: string;
  observedAt: string;
  expiresAt?: string;
  runId: string;
  agentId: string;
  evidence: Record<string, unknown>;
  supersedes?: string;
  personalData: false;
}

export function createRuntimeObservation(input: RuntimeObservationInput): RuntimeObservation {
  const subject = input.subject.trim();
  const content = input.content.trim();
  if (!subject || !content || !input.runId.trim() || !input.agentId.trim()) throw new Error("Runtime observations require subject, content, runId, and agentId.");
  if (input.personalData !== false) throw new Error("Shared Runtime Observations require personalData: false.");
  if (Number.isNaN(Date.parse(input.observedAt))) throw new Error("Runtime observation observedAt must be an ISO timestamp.");
  if (input.expiresAt && (Number.isNaN(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.parse(input.observedAt))) {
    throw new Error("Runtime observation expiresAt must be later than observedAt.");
  }
  const contentDigest = sha256(content);
  const identity = {
    subject,
    contentDigest,
    observedAt: new Date(input.observedAt).toISOString(),
    runId: input.runId.trim(),
    agentId: input.agentId.trim(),
  };
  return {
    observationId: sha256(identity),
    ...identity,
    content,
    expiresAt: input.expiresAt ? new Date(input.expiresAt).toISOString() : undefined,
    evidence: structuredClone(input.evidence),
    status: "active",
    supersedes: input.supersedes,
    personalData: false,
  };
}

const routeFor = (content: string): ReviewRoute => /\b(blocked|failure|failed|incident|lesson)\b/i.test(content) ? "learning"
  : /\b(step|steps|procedure|how to|checklist)\b/i.test(content) ? "playbook" : "okf";

const slugify = (value: string): string => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "runtime-observation";

export function runtimeObservationsToReviewCandidates(input: {
  observations: readonly RuntimeObservation[];
  activeBundle: KnowledgeBundle;
  previousCandidateIds?: readonly string[];
  limit?: number;
}): ReviewCandidate[] {
  const prior = new Set(input.previousCandidateIds ?? []);
  const candidates: ReviewCandidate[] = [];
  for (const observation of [...input.observations].sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.observationId.localeCompare(b.observationId))) {
    if (observation.status !== "active") continue;
    const candidateId = sha256({ observationId: observation.observationId, contentDigest: observation.contentDigest });
    if (prior.has(candidateId)) continue;
    const title = observation.content.match(/^#\s+(.+)$/m)?.[1]?.trim() || observation.subject;
    const duplicate = input.activeBundle.documents.find((document) => document.digest === observation.contentDigest);
    const quarantined = !observation.content.trim() || scanCredentialIndicators(observation.content).length > 0;
    candidates.push({
      candidateId,
      sourcePath: `observation:${observation.observationId}`,
      sourceDigest: observation.contentDigest,
      title,
      route: routeFor(observation.content),
      status: quarantined ? "quarantined" : "pending",
      reason: quarantined ? "Runtime Observation failed content or credential checks and remains outside active knowledge."
        : duplicate ? "Runtime Observation duplicates active knowledge and requires a supersession decision."
          : "Runtime Observation requires human review before promotion.",
      source: "runtime-observation",
      capturedAt: observation.observedAt,
      actor: observation.agentId,
      personalData: false,
      accessPolicyId: QUARANTINE_POLICY_ID,
      duplicateOf: duplicate?.path,
      runtimeObservationId: observation.observationId,
    });
  }
  return candidates.slice(0, Math.max(1, Math.min(input.limit ?? 3, 3)));
}

export function proposeRuntimeObservationPromotion(input: {
  candidate: ReviewCandidate;
  observation: RuntimeObservation;
  destinationPath?: string;
}): KnowledgePromotionProposal {
  if (input.candidate.status !== "accepted") throw new Error(`Review candidate '${input.candidate.candidateId}' must be accepted before a promotion proposal is created.`);
  if (input.candidate.runtimeObservationId !== input.observation.observationId || input.candidate.sourceDigest !== input.observation.contentDigest || input.observation.status !== "active") {
    throw new Error("Reviewed candidate does not match an active immutable Runtime Observation.");
  }
  if (input.candidate.route === "learning") throw new Error("Runtime learning candidates require an explicit archival destination and are not promoted into active OKF.");
  const slug = slugify(input.candidate.title);
  const destination = input.destinationPath ?? (input.candidate.route === "playbook" ? `handbook/playbooks/${slug}.md` : `handbook/${slug}.md`);
  if (!destination.startsWith("handbook/") || destination.includes("..") || destination.startsWith("/")) throw new Error(`Invalid Runtime Observation promotion destination '${destination}'.`);
  const content = `---\n${YAML.stringify({
    type: input.candidate.route === "playbook" ? "playbook" : "note",
    description: `Reviewed Runtime Observation from ${input.observation.agentId}.`,
    sources: [{ observation_id: input.observation.observationId, digest: input.observation.contentDigest, run_id: input.observation.runId }],
  }).trimEnd()}\n---\n${input.observation.content.trim()}\n`;
  const operations: KnowledgePromotionProposal["operations"] = [
    { operation: "create", path: destination, content },
    { operation: "append-index", path: "handbook/index.md", content: `- [${input.candidate.title.replace(/[\[\]\r\n]/g, " ").trim() || slug}](${destination.slice("handbook/".length)})` },
  ];
  const base = { candidateId: input.candidate.candidateId, sourcePath: input.candidate.sourcePath, sourceDigest: input.candidate.sourceDigest, route: input.candidate.route, operations };
  return { proposalId: sha256(base), ...base, warning: "Proposal only: apply it as a governed Workspace diff. It cannot merge, deploy, or activate itself." };
}
