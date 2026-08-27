import YAML from "yaml";
import { sha256 } from "../runtime/canonical.ts";
import { scanCredentialIndicators } from "../security/credential-scanner.ts";
import type { KnowledgeBundle, KnowledgePromotionProposal, ReviewCandidate, ReviewRoute } from "./contracts.ts";
import { QUARANTINE_POLICY_ID } from "./access-control.ts";
import { normalizeSearchText } from "./search.ts";
import type {
  KnowledgeSourceBinding,
  KnowledgeSourceConnector,
  KnowledgeSourceRequirement,
  KnowledgeSourceStore,
  SourceEnvelope,
  SourceReceipt,
} from "./source-contracts.ts";

const routeFor = (content: string): ReviewRoute => {
  if (/\b(blocked|failure|failed|incident|lesson)\b/i.test(content)) return "learning";
  if (/\b(step|steps|procedure|how to|checklist)\b/i.test(content)) return "playbook";
  return "okf";
};

const similarity = (leftText: string, rightText: string): number => {
  const left = new Set(normalizeSearchText(leftText));
  const right = new Set(normalizeSearchText(rightText));
  if (!left.size || !right.size) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return common / Math.max(left.size, right.size);
};

const slugify = (value: string): string => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "knowledge-candidate";

export function sourceEnvelopesToReviewCandidates(input: {
  envelopes: readonly SourceEnvelope[];
  activeBundle: KnowledgeBundle;
  previousCandidateIds?: readonly string[];
  limit?: number;
}): ReviewCandidate[] {
  const prior = new Set(input.previousCandidateIds ?? []);
  const candidates: ReviewCandidate[] = [];
  const ordered = [...input.envelopes]
    .filter((entry) => entry.deletionState === "present")
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.providerObjectId.localeCompare(b.providerObjectId));
  for (const envelope of ordered) {
    const body = envelope.boundedText ?? "";
    const candidateId = sha256({ sourceId: envelope.sourceId, providerObjectId: envelope.providerObjectId, providerVersion: envelope.providerVersion, contentDigest: envelope.contentDigest });
    if (prior.has(candidateId)) continue;
    const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() || envelope.providerObjectId.split("/").at(-1)!.replace(/\.md$/i, "");
    const tokens = normalizeSearchText(body);
    const sanityFailure = !body.trim() || body.includes("\uFFFD") || scanCredentialIndicators(body).length > 0 ||
      (tokens.length >= 20 && new Set(tokens).size / tokens.length < 0.1);
    const duplicate = input.activeBundle.documents
      .map((document) => ({ path: document.path, score: similarity(body, `${document.title}\n${document.description}\n${document.body}`) }))
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))[0];
    candidates.push({
      candidateId,
      sourcePath: `source:${envelope.sourceId}/${envelope.providerObjectId}`,
      sourceDigest: envelope.contentDigest,
      title,
      route: routeFor(body),
      status: sanityFailure ? "quarantined" : "pending",
      reason: sanityFailure
        ? "Source content failed sanity or credential checks and remains outside active knowledge."
        : duplicate && duplicate.score >= 0.75
          ? "Possible duplicate of active knowledge; review as an update, rejection, or supersession."
          : "Source content passed bounded checks and requires human review before promotion.",
      source: envelope.sourceId,
      capturedAt: envelope.observedAt,
      actor: envelope.ownerOrAccount,
      personalData: false,
      accessPolicyId: QUARANTINE_POLICY_ID,
      duplicateOf: duplicate && duplicate.score >= 0.75 ? duplicate.path : undefined,
      sourceObject: { sourceId: envelope.sourceId, providerObjectId: envelope.providerObjectId, providerVersion: envelope.providerVersion },
    });
  }
  return candidates.slice(0, Math.max(1, Math.min(input.limit ?? 3, 3)));
}

export interface KnowledgeSourceSyncResult {
  sourceId: string;
  pages: number;
  objects: number;
  inserted: number;
  updated: number;
  unchanged: number;
  reconciledDeleted: number;
  complete: boolean;
  reconciliationDeferred: boolean;
  nextCursor?: string;
  candidates: ReviewCandidate[];
}

export async function syncKnowledgeSource(input: {
  connector: KnowledgeSourceConnector;
  store: KnowledgeSourceStore;
  requirement: KnowledgeSourceRequirement;
  binding: KnowledgeSourceBinding;
  activeBundle: KnowledgeBundle;
  previousCandidateIds?: readonly string[];
  pageSize?: number;
  maxPages?: number;
  maxObjects?: number;
  now?: () => string;
}): Promise<KnowledgeSourceSyncResult> {
  if (input.connector.sourceId !== input.requirement.sourceId || input.binding.sourceId !== input.requirement.sourceId) throw new Error("Knowledge source sync identities do not match.");
  await input.store.registerSource(input.requirement, input.binding);
  const startedCursor = await input.store.getCursor(input.requirement.sourceId);
  let cursor = startedCursor;
  let pages = 0;
  let objects = 0;
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  const envelopes: SourceEnvelope[] = [];
  const presentObjectIds: string[] = [];
  const maxPages = Math.max(1, Math.min(input.maxPages ?? 100, 1_000));
  const maxObjects = Math.max(1, Math.min(input.maxObjects ?? 10_000, 100_000));
  const now = input.now ?? (() => new Date().toISOString());
  try {
    const verification = await input.connector.verify();
    await input.store.recordReceipt(verification.receipt);
    let complete = false;
    while (!complete && pages < maxPages && objects < maxObjects) {
      const page = await input.connector.enumerate({ cursor, pageSize: Math.min(input.pageSize ?? 100, maxObjects - objects) });
      await input.store.recordReceipt(page.receipt);
      pages += 1;
      for (const descriptor of page.objects) {
        if (objects >= maxObjects) break;
        const fetched = await input.connector.fetch(descriptor, cursor ?? `tree-root:${input.requirement.sourceId}`);
        await input.store.recordReceipt(fetched.receipt);
        const outcome = await input.store.upsertEnvelope(fetched.envelope, input.requirement.retention);
        if (outcome === "inserted") inserted += 1;
        else if (outcome === "updated") updated += 1;
        else unchanged += 1;
        envelopes.push(fetched.envelope);
        presentObjectIds.push(fetched.envelope.providerObjectId);
        objects += 1;
      }
      cursor = page.nextCursor;
      complete = page.complete;
      await input.store.updateCursor(input.requirement.sourceId, cursor, complete);
      if (!complete && !cursor) throw new Error("Incomplete source enumeration did not return a resumable cursor.");
    }
    const reconciliationDeferred = startedCursor !== undefined || !complete;
    const reconciledDeleted = reconciliationDeferred ? 0 : await input.store.reconcileEnvelopes(input.requirement.sourceId, presentObjectIds, now(), input.requirement.retention);
    if (!reconciliationDeferred) {
      const reconciliationReceipt: SourceReceipt = {
        receiptId: sha256({ sourceId: input.requirement.sourceId, operation: "reconcile", presentObjectIds: [...presentObjectIds].sort(), reconciledDeleted }),
        sourceId: input.requirement.sourceId,
        operation: "reconcile",
        observedAt: now(),
        evidence: { present_objects: presentObjectIds.length, deleted_objects: reconciledDeleted, complete_inventory: true },
      };
      await input.store.recordReceipt(reconciliationReceipt);
    }
    const health = { ok: true, sourceId: input.requirement.sourceId, status: "healthy" as const, checkedAt: now(), lastSuccessfulSync: now() };
    await input.store.recordSourceHealth(health);
    return {
      sourceId: input.requirement.sourceId,
      pages,
      objects,
      inserted,
      updated,
      unchanged,
      reconciledDeleted,
      complete,
      reconciliationDeferred,
      nextCursor: cursor,
      candidates: sourceEnvelopesToReviewCandidates({ envelopes, activeBundle: input.activeBundle, previousCandidateIds: input.previousCandidateIds }),
    };
  } catch (error) {
    await input.store.recordSourceHealth({ ok: false, sourceId: input.requirement.sourceId, status: "error", checkedAt: now(), reason: error instanceof Error ? error.message : "Unknown source synchronization error." });
    throw error;
  }
}

export function proposeSourcedKnowledgePromotion(input: {
  candidate: ReviewCandidate;
  envelope: SourceEnvelope;
  destinationPath?: string;
}): KnowledgePromotionProposal {
  if (input.candidate.status !== "accepted") throw new Error(`Review candidate '${input.candidate.candidateId}' must be accepted before a promotion proposal is created.`);
  const reference = input.candidate.sourceObject;
  if (!reference || reference.sourceId !== input.envelope.sourceId || reference.providerObjectId !== input.envelope.providerObjectId || reference.providerVersion !== input.envelope.providerVersion) {
    throw new Error("Reviewed source candidate does not match the immutable source envelope.");
  }
  if (input.envelope.deletionState !== "present" || !input.envelope.boundedText || input.envelope.contentDigest !== input.candidate.sourceDigest || sha256(input.envelope.boundedText) !== input.candidate.sourceDigest) {
    throw new Error("Source knowledge changed or was deleted after review; create and review a new candidate.");
  }
  if (input.candidate.route === "learning") throw new Error("Source learning candidates require an explicit archival destination and are not promoted into active OKF.");
  const slug = slugify(input.candidate.title);
  const destination = input.destinationPath ?? (input.candidate.route === "playbook" ? `handbook/playbooks/${slug}.md` : `handbook/${slug}.md`);
  if (!destination.startsWith("handbook/") || destination.includes("..") || destination.startsWith("/")) throw new Error(`Invalid sourced promotion destination '${destination}'.`);
  const content = `---\n${YAML.stringify({
    type: input.candidate.route === "playbook" ? "playbook" : "note",
    description: `Reviewed from source ${input.envelope.sourceId}.`,
    sources: [{ source_id: input.envelope.sourceId, object_id: input.envelope.providerObjectId, object_version: input.envelope.providerVersion, digest: input.envelope.contentDigest }],
  }).trimEnd()}\n---\n${input.envelope.boundedText.trim()}\n`;
  const operations: KnowledgePromotionProposal["operations"] = [
    { operation: "create", path: destination, content },
    { operation: "append-index", path: "handbook/index.md", content: `- [${input.candidate.title.replace(/[\[\]\r\n]/g, " ").trim() || slug}](${destination.slice("handbook/".length)})` },
  ];
  const base = { candidateId: input.candidate.candidateId, sourcePath: input.candidate.sourcePath, sourceDigest: input.candidate.sourceDigest, route: input.candidate.route, operations };
  return { proposalId: sha256(base), ...base, warning: "Proposal only: apply it as a governed Workspace diff. It cannot merge, deploy, or activate itself." };
}
