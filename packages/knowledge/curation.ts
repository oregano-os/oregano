import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { sha256 } from "../runtime/canonical.ts";
import { scanCredentialIndicators } from "../security/credential-scanner.ts";
import YAML from "yaml";
import type { KnowledgeBundle, KnowledgePromotionProposal, ReviewCandidate, ReviewDecision, ReviewRoute } from "./contracts.ts";
import { QUARANTINE_POLICY_ID } from "./access-control.ts";
import { normalizeSearchText } from "./search.ts";

const walk = (root: string): string[] => {
  if (!existsSync(root)) return [];
  const output: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name !== ".gitkeep") output.push(path);
    }
  };
  visit(root);
  return output;
};

const routeFor = (content: string): ReviewRoute => {
  if (/\b(blocked|failure|failed|incident|lesson)\b/i.test(content)) return "learning";
  if (/\b(step|steps|procedure|how to|checklist)\b/i.test(content)) return "playbook";
  return "okf";
};

const parseRaw = (content: string): { data?: Record<string, unknown>; body: string; error?: string } => {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { body: content, error: "Raw knowledge requires YAML frontmatter with source, captured_at, actor, and personal_data." };
  let data: unknown;
  try { data = YAML.parse(match[1]); }
  catch { return { body: content.slice(match[0].length), error: "Raw knowledge frontmatter is invalid YAML." }; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { body: content.slice(match[0].length), error: "Raw knowledge frontmatter must be an object." };
  const record = data as Record<string, unknown>;
  if (typeof record.source !== "string" || !record.source.trim() || typeof record.actor !== "string" || !record.actor.trim() ||
    typeof record.captured_at !== "string" || Number.isNaN(Date.parse(record.captured_at)) || typeof record.personal_data !== "boolean") {
    return { data: record, body: content.slice(match[0].length), error: "Raw knowledge requires non-empty source and actor, an ISO captured_at value, and boolean personal_data." };
  }
  if (record.personal_data) return { data: record, body: content.slice(match[0].length), error: "Personal raw knowledge remains quarantined until a restrictive access policy and human review are recorded." };
  return { data: record, body: content.slice(match[0].length) };
};

const slugify = (value: string): string => value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "knowledge-candidate";

const similarity = (a: string, b: string): number => {
  const left = new Set(normalizeSearchText(a));
  const right = new Set(normalizeSearchText(b));
  if (left.size === 0 || right.size === 0) return 0;
  let common = 0;
  for (const token of left) if (right.has(token)) common += 1;
  return common / Math.max(left.size, right.size);
};

export function inspectCurationInbox(args: {
  workspaceRoot: string;
  activeBundle: KnowledgeBundle;
  previousDecisions?: ReviewDecision[];
  previousCandidateIds?: string[];
  limit?: number;
}): ReviewCandidate[] {
  const inbox = join(args.workspaceRoot, "brain", "inbox");
  const prior = new Set([
    ...(args.previousDecisions ?? []).map((entry) => entry.candidateId),
    ...(args.previousCandidateIds ?? []),
  ]);
  const candidates: ReviewCandidate[] = [];
  for (const path of walk(inbox)) {
    const sourcePath = relative(args.workspaceRoot, path).replaceAll("\\", "/");
    const content = readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
    const raw = parseRaw(content);
    const body = raw.body;
    const sourceDigest = sha256(content);
    const candidateId = sha256({ sourcePath, sourceDigest });
    if (prior.has(candidateId)) continue;
    const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() || sourcePath.split("/").at(-1)!;
    const tokens = normalizeSearchText(body);
    const sanityFailure = raw.error || !body.trim() || body.includes("\uFFFD") || Buffer.byteLength(content) > 256 * 1024 ||
      scanCredentialIndicators(content).length > 0 || (tokens.length >= 20 && new Set(tokens).size / tokens.length < 0.1);
    const base = {
      candidateId, sourcePath, sourceDigest, title,
      route: routeFor(body),
      source: typeof raw.data?.source === "string" ? raw.data.source : "unknown",
      capturedAt: typeof raw.data?.captured_at === "string" ? raw.data.captured_at : "unknown",
      actor: typeof raw.data?.actor === "string" ? raw.data.actor : "unknown",
      personalData: typeof raw.data?.personal_data === "boolean" ? raw.data.personal_data : false,
      accessPolicyId: QUARANTINE_POLICY_ID,
    };
    if (sanityFailure) {
      candidates.push({ ...base, status: "quarantined", reason: raw.error ?? "Content sanity check failed; inspect manually and keep it out of active knowledge." });
      continue;
    }
    const duplicate = args.activeBundle.documents
      .map((document) => ({ path: document.path, score: similarity(body, `${document.title}\n${document.description}\n${document.body}`) }))
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))[0];
    candidates.push({
      ...base,
      status: "pending",
      reason: duplicate && duplicate.score >= 0.75 ? "Possible duplicate of active knowledge; review as an update, rejection, or supersession." : "Passed content sanity checks and requires human review before promotion.",
      duplicateOf: duplicate && duplicate.score >= 0.75 ? duplicate.path : undefined,
    });
  }
  return candidates.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath)).slice(0, Math.max(1, Math.min(args.limit ?? 3, 3)));
}

export function proposeKnowledgePromotion(args: {
  workspaceRoot: string;
  candidate: ReviewCandidate;
  destinationPath?: string;
}): KnowledgePromotionProposal {
  if (args.candidate.status !== "accepted") throw new Error(`Review candidate '${args.candidate.candidateId}' must be accepted before a promotion proposal is created.`);
  if (!args.candidate.sourcePath.startsWith("brain/inbox/") || args.candidate.sourcePath.includes("..") || args.candidate.sourcePath.startsWith("/")) {
    throw new Error(`Invalid raw knowledge source path '${args.candidate.sourcePath}'.`);
  }
  const source = join(args.workspaceRoot, args.candidate.sourcePath);
  const content = readFileSync(source, "utf8").replace(/\r\n?/g, "\n");
  if (sha256(content) !== args.candidate.sourceDigest) throw new Error("Raw knowledge changed after review; create and review a new candidate.");
  const raw = parseRaw(content);
  if (raw.error) throw new Error(raw.error);
  const slug = slugify(args.candidate.title);
  const suggested = args.candidate.route === "playbook" ? `handbook/playbooks/${slug}.md`
    : args.candidate.route === "learning" ? `brain/archive/${slug}-learning.md`
      : `handbook/${slug}.md`;
  const destination = args.destinationPath ?? suggested;
  if (destination.startsWith("/") || destination.includes("..") ||
    (args.candidate.route === "learning" ? !destination.startsWith("brain/archive/") : !destination.startsWith("handbook/"))) {
    throw new Error(`Invalid promotion destination '${destination}' for route '${args.candidate.route}'.`);
  }
  const description = `Reviewed from ${args.candidate.sourcePath}.`;
  const indexLabel = args.candidate.title.replace(/[\[\]\r\n]/g, " ").trim() || slug;
  const operations: KnowledgePromotionProposal["operations"] = [];
  if (args.candidate.route === "learning") {
    operations.push({ operation: "archive", from: args.candidate.sourcePath, to: destination, content });
  } else {
    operations.push({
      operation: "create",
      path: destination,
      content: `---\n${YAML.stringify({
        type: args.candidate.route === "playbook" ? "playbook" : "note",
        description,
        sources: [{ path: args.candidate.sourcePath, digest: args.candidate.sourceDigest }],
      }).trimEnd()}\n---\n${raw.body.trim()}\n`,
    });
    operations.push({ operation: "append-index", path: "handbook/index.md", content: `- [${indexLabel}](${destination.slice("handbook/".length)})` });
    operations.push({
      operation: "archive",
      from: args.candidate.sourcePath,
      to: `brain/archive/${slug}.md`,
      content: `---\n${YAML.stringify({
        status: "accepted",
        candidate_id: args.candidate.candidateId,
        source_digest: args.candidate.sourceDigest,
        destination,
      }).trimEnd()}\n---\n${content.trim()}\n`,
    });
  }
  const withoutId = { candidateId: args.candidate.candidateId, sourcePath: args.candidate.sourcePath, sourceDigest: args.candidate.sourceDigest, route: args.candidate.route, operations };
  return {
    proposalId: sha256(withoutId),
    ...withoutId,
    warning: "Proposal only: apply it as a governed Workspace diff. It cannot merge, deploy, or activate itself.",
  };
}

export function decideReviewCandidate(candidate: ReviewCandidate, input: Omit<ReviewDecision, "candidateId">): { candidate: ReviewCandidate; decision: ReviewDecision } {
  if (candidate.status !== "pending") throw new Error(`Review candidate '${candidate.candidateId}' is not pending.`);
  return {
    candidate: { ...candidate, status: input.decision },
    decision: { candidateId: candidate.candidateId, ...input },
  };
}
