import { sha256 } from "../runtime/canonical.ts";
import type { MergeReceipt, ReleaseCandidate, RepositoryCandidateInspection } from "../runtime/release/contracts.ts";

/** Repository-scoped trusted client. No installation credential crosses this port. */
export interface GitHubReleaseClient {
  request<T>(method: "GET" | "PUT", path: string, body?: unknown): Promise<T>;
  readyForReview(nodeId: string): Promise<void>;
}

interface PullRequest {
  number: number; node_id: string; state: string; draft: boolean; merged: boolean;
  merge_commit_sha: string | null;
  base: { ref: string; sha: string; repo: { full_name: string } };
  head: { sha: string; repo: { full_name: string } | null };
}
interface Commit { sha: string; commit: { tree: { sha: string } }; parents: Array<{ sha: string }>; }
interface Protection {
  required_status_checks?: { strict: boolean; checks?: Array<{ context: string; app_id: number | null }> };
  enforce_admins?: { enabled: boolean };
  allow_force_pushes?: { enabled: boolean };
  allow_deletions?: { enabled: boolean };
  required_pull_request_reviews?: { bypass_pull_request_allowances?: { apps?: unknown[]; users?: unknown[]; teams?: unknown[] } };
}
export interface GitHubCandidateInput {
  repositoryId: string; targetBranch: string; baseCommit: string; candidateCommit: string;
  pullRequestNumber: number;
  /** Classification and full path inventory from the trusted Workbench receipt. */
  changeClass: ReleaseCandidate["changeClass"];
  changedPaths: readonly string[];
  workbenchChecks: readonly { id: string; evidenceDigest: string; status: "passed" }[];
}

function assertPull(pull: PullRequest, input: GitHubCandidateInput): void {
  if (!Number.isSafeInteger(input.pullRequestNumber) || input.pullRequestNumber < 1
    || pull.number !== input.pullRequestNumber || pull.base.ref !== input.targetBranch
    || pull.base.repo.full_name !== input.repositoryId || pull.head.repo?.full_name !== input.repositoryId
    || pull.head.sha !== input.candidateCommit) throw new Error("GitHub pull request differs from the trusted Builder result.");
}

export async function inspectGitHubCandidate(client: GitHubReleaseClient, input: GitHubCandidateInput): Promise<RepositoryCandidateInspection> {
  const [pull, branch, commit, protection, comparison, checkRuns] = await Promise.all([
    client.request<PullRequest>("GET", `/pulls/${input.pullRequestNumber}`),
    client.request<{ commit: { sha: string } }>("GET", `/branches/${encodeURIComponent(input.targetBranch)}`),
    client.request<Commit>("GET", `/commits/${input.candidateCommit}`),
    client.request<Protection>("GET", `/branches/${encodeURIComponent(input.targetBranch)}/protection`),
    client.request<{ status: string; total_commits: number; files: Array<{ filename: string; previous_filename?: string; sha: string; status: string }> }>("GET", `/compare/${input.baseCommit}...${input.candidateCommit}`),
    client.request<{ total_count: number; check_runs: Array<{ id: number; name: string; head_sha: string; status: string; conclusion: string | null; app: { id: number } }> }>("GET", `/commits/${input.candidateCommit}/check-runs?per_page=100&filter=latest`),
  ]);
  assertPull(pull, input);
  if (pull.merged || pull.state !== "open" || pull.base.sha !== input.baseCommit
    || commit.sha !== input.candidateCommit || commit.parents.length !== 1 || commit.parents[0]?.sha !== input.baseCommit
    || comparison.status !== "ahead" || comparison.total_commits !== 1 || !comparison.files.length || comparison.files.length >= 300
    || checkRuns.total_count > 100) throw new Error("Candidate is not a bounded single-parent change on the exact base.");
  const paths = [...new Set(comparison.files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]))].sort();
  if (JSON.stringify(paths) !== JSON.stringify([...input.changedPaths].sort())) throw new Error("Hosted candidate paths differ from independent Workbench validation.");
  const required = protection.required_status_checks?.checks ?? [];
  const bypass = protection.required_pull_request_reviews?.bypass_pull_request_allowances;
  const protectedBranch = protection.required_status_checks?.strict === true && required.length > 0
    && required.every((check) => check.app_id !== null && check.app_id > 0)
    && protection.enforce_admins?.enabled === true && !protection.allow_force_pushes?.enabled && !protection.allow_deletions?.enabled
    && !bypass?.apps?.length && !bypass?.teams?.length && !bypass?.users?.length;
  const checks: Array<{ id: string; status: "passed" | "pending" | "failed" }> = input.workbenchChecks.map(({ id, status }) => ({ id, status }));
  const evidence: unknown[] = [...input.workbenchChecks];
  for (const rule of required) {
    const matches = checkRuns.check_runs.filter((run) => run.name === rule.context && run.app.id === rule.app_id && run.head_sha === input.candidateCommit);
    const run = matches.length === 1 ? matches[0] : undefined;
    const status = !run || run.status !== "completed" ? "pending" : run.conclusion === "success" ? "passed" : "failed";
    checks.push({ id: `github:${rule.app_id}:${rule.context}`, status });
    evidence.push({ app: rule.app_id, name: rule.context, id: run?.id ?? null, status, head: run?.head_sha ?? null });
  }
  if (!checks.length || !input.workbenchChecks.some((check) => check.id === "workbench.inspect")
    || !input.workbenchChecks.some((check) => check.id === "workbench.validate")
    || !input.workbenchChecks.some((check) => check.id === "workbench.security")) throw new Error("Independent Workbench evidence is incomplete.");
  return {
    repositoryId: input.repositoryId, targetBranch: input.targetBranch, currentBase: branch.commit.sha,
    candidateCommit: commit.sha, candidateTree: commit.commit.tree.sha, changeClass: input.changeClass,
    diffDigest: sha256({ base: input.baseCommit, candidate: input.candidateCommit, files: comparison.files.map(({ filename, previous_filename, sha, status }) => ({ filename, previous_filename, sha, status })) }),
    checks, checksDigest: sha256(evidence), protectionEnforced: protectedBranch,
  };
}

/** Protected merge reconciles the existing PR first; no force push or admin bypass. */
export async function mergeGitHubCandidate(client: GitHubReleaseClient, input: GitHubCandidateInput, accepted: ReleaseCandidate): Promise<MergeReceipt | undefined> {
  let pull = await client.request<PullRequest>("GET", `/pulls/${input.pullRequestNumber}`);
  assertPull(pull, input);
  if (!pull.merged) {
    const current = await inspectGitHubCandidate(client, input);
    if (!current.protectionEnforced || current.currentBase !== accepted.baseCommit
      || current.candidateTree !== accepted.candidateTree || current.diffDigest !== accepted.diffDigest
      || current.checksDigest !== accepted.checksDigest || current.checks.some((check) => check.status !== "passed")) throw new Error("Protected merge prerequisites changed.");
    if (pull.draft) await client.readyForReview(pull.node_id);
    // Strict up-to-date required checks and the expected head enforce the base
    // at GitHub's merge boundary. We never request an administrative override.
    try {
      await client.request("PUT", `/pulls/${input.pullRequestNumber}/merge`, { sha: accepted.candidateCommit, merge_method: "merge" });
    } catch {
      // A failed response may follow a successful merge. Reconcile before any retry.
    }
    pull = await client.request<PullRequest>("GET", `/pulls/${input.pullRequestNumber}`);
    assertPull(pull, input);
    if (!pull.merged) return undefined;
  }
  if (!pull.merge_commit_sha) throw new Error("Merged pull request has no immutable commit receipt.");
  const merged = await client.request<Commit>("GET", `/commits/${pull.merge_commit_sha}`);
  const branch = await client.request<{ commit: { sha: string } }>("GET", `/branches/${encodeURIComponent(input.targetBranch)}`);
  if (merged.sha !== pull.merge_commit_sha || merged.commit.tree.sha !== accepted.candidateTree
    || merged.parents.length !== 2 || merged.parents[0]?.sha !== accepted.baseCommit || merged.parents[1]?.sha !== accepted.candidateCommit
    || branch.commit.sha !== merged.sha) throw new Error("Merged tree, parents or current target differ from the accepted candidate.");
  return { repositoryId: input.repositoryId, targetBranch: input.targetBranch, baseCommit: input.baseCommit,
    candidateCommit: input.candidateCommit, mergedCommit: merged.sha, mergedTree: merged.commit.tree.sha };
}
