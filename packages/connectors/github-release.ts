import { sha256 } from "../runtime/canonical.ts";
import type { MergeReceipt, ReleaseCandidate, RepositoryCandidateInspection } from "../runtime/release/contracts.ts";

/** Repository-scoped trusted client. No installation credential crosses this port. */
export interface GitHubReleaseClient {
  request<T>(method: "GET" | "PUT" | "PATCH", path: string, body?: unknown): Promise<T>;
  readyForReview(nodeId: string): Promise<void>;
}

interface PullRequest {
  number: number; node_id: string; state: string; draft: boolean; merged: boolean;
  merge_commit_sha: string | null;
  base: { ref: string; sha: string; repo: { full_name: string } };
  head: { sha: string; repo: { full_name: string } | null };
}
interface Commit { sha: string; commit: { tree: { sha: string } }; parents: Array<{ sha: string }>; }
interface Branch { commit: { sha: string }; protected: boolean; }
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
  const [pull, branch, commit, comparison, checkRuns] = await Promise.all([
    client.request<PullRequest>("GET", `/pulls/${input.pullRequestNumber}`),
    client.request<Branch>("GET", `/branches/${encodeURIComponent(input.targetBranch)}`),
    client.request<Commit>("GET", `/commits/${input.candidateCommit}`),
    client.request<{ status: string; total_commits: number; files: Array<{ filename: string; previous_filename?: string; sha: string; status: string }> }>("GET", `/compare/${input.baseCommit}...${input.candidateCommit}`),
    client.request<{ total_count: number; check_runs: Array<{ id: number; name: string; head_sha: string; status: string; conclusion: string | null; app: { id: number } }> }>("GET", `/commits/${input.candidateCommit}/check-runs?per_page=100&filter=latest`),
  ]);
  if (typeof branch.protected !== "boolean") throw new Error("GitHub did not identify the target's protection state.");
  // Missing paid protection is not an error. Existing hosted rules must still
  // be read successfully; an authorization failure is never a fallback signal.
  const protection = branch.protected
    ? await client.request<Protection>("GET", `/branches/${encodeURIComponent(input.targetBranch)}/protection`)
    : undefined;
  const mergeStrategy = branch.protected ? "protected-merge" : "exact-fast-forward";
  assertPull(pull, input);
  if (pull.merged || pull.state !== "open" || pull.base.sha !== input.baseCommit
    || commit.sha !== input.candidateCommit || commit.parents.length !== 1 || commit.parents[0]?.sha !== input.baseCommit
    || comparison.status !== "ahead" || comparison.total_commits !== 1 || !comparison.files.length || comparison.files.length >= 300
    || checkRuns.total_count > 100) throw new Error("Candidate is not a bounded single-parent change on the exact base.");
  const paths = [...new Set(comparison.files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]))].sort();
  if (JSON.stringify(paths) !== JSON.stringify([...input.changedPaths].sort())) throw new Error("Hosted candidate paths differ from independent Workbench validation.");
  const required = [...(protection ? protection.required_status_checks?.checks ?? []
    : new Map(checkRuns.check_runs.map((run) =>
      [`${run.app.id}:${run.name}`, { context: run.name, app_id: run.app.id }])).values())]
    .sort((a, b) => (a.app_id ?? 0) - (b.app_id ?? 0) || a.context.localeCompare(b.context));
  const bypass = protection?.required_pull_request_reviews?.bypass_pull_request_allowances;
  const protectedBranch = protection?.required_status_checks?.strict === true && required.length > 0
    && required.every((check) => check.app_id !== null && check.app_id > 0)
    && protection.enforce_admins?.enabled === true && !protection.allow_force_pushes?.enabled && !protection.allow_deletions?.enabled
    && !bypass?.apps?.length && !bypass?.teams?.length && !bypass?.users?.length;
  const checks: Array<{ id: string; status: "passed" | "pending" | "failed" }> = input.workbenchChecks.map(({ id, status }) => ({ id, status }));
  const evidence: unknown[] = [{ mergeStrategy }, ...input.workbenchChecks];
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
    checks, checksDigest: sha256(evidence), protectionEnforced: protectedBranch, mergeStrategy,
  };
}

/** Human-confirmed merge; exact fast-forward or existing hosted enforcement. */
export async function mergeGitHubCandidate(client: GitHubReleaseClient, input: GitHubCandidateInput, accepted: ReleaseCandidate): Promise<MergeReceipt | undefined> {
  if (input.repositoryId !== accepted.repositoryId || input.targetBranch !== accepted.targetBranch
    || input.baseCommit !== accepted.baseCommit || input.candidateCommit !== accepted.candidateCommit
    || input.changeClass !== accepted.changeClass) throw new Error("Merge input differs from the accepted candidate.");
  let pull = await client.request<PullRequest>("GET", `/pulls/${input.pullRequestNumber}`);
  assertPull(pull, input);
  // GitHub may update PR metadata after the ref write. Recover from immutable
  // branch/commit facts, including when the successful response was lost.
  const branchBefore = await client.request<Branch>("GET", `/branches/${encodeURIComponent(input.targetBranch)}`);
  if (branchBefore.commit.sha === accepted.candidateCommit) return await verifyFastForward(client, input, accepted);
  if (!pull.merged) {
    const current = await inspectGitHubCandidate(client, input);
    if ((!current.protectionEnforced && current.mergeStrategy !== "exact-fast-forward") || current.currentBase !== accepted.baseCommit
      || current.candidateTree !== accepted.candidateTree || current.diffDigest !== accepted.diffDigest
      || current.checksDigest !== accepted.checksDigest || current.checks.some((check) => check.status !== "passed")) throw new Error("Confirmed merge prerequisites changed.");
    if (pull.draft) await client.readyForReview(pull.node_id);
    if (current.mergeStrategy === "exact-fast-forward") {
      // A single-parent candidate is already the complete reviewed result.
      // force:false rejects a concurrent divergent main; it never synthesizes
      // a merge containing work the human did not see.
      try {
        await client.request("PATCH", `/git/refs/heads/${encodeURIComponent(input.targetBranch)}`, { sha: accepted.candidateCommit, force: false });
      } catch {
        // Reconcile an uncertain response before retrying the same exact ref.
      }
      const branchAfter = await client.request<Branch>("GET", `/branches/${encodeURIComponent(input.targetBranch)}`);
      if (branchAfter.commit.sha === accepted.baseCommit) return undefined;
      if (branchAfter.commit.sha !== accepted.candidateCommit) throw new Error("Target advanced outside the confirmed fast-forward; refresh and review the result.");
      return await verifyFastForward(client, input, accepted);
    }
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

async function verifyFastForward(client: GitHubReleaseClient, input: GitHubCandidateInput, accepted: ReleaseCandidate): Promise<MergeReceipt> {
  const commit = await client.request<Commit>("GET", `/commits/${accepted.candidateCommit}`);
  const branch = await client.request<Branch>("GET", `/branches/${encodeURIComponent(input.targetBranch)}`);
  if (commit.sha !== accepted.candidateCommit || commit.commit.tree.sha !== accepted.candidateTree
    || commit.parents.length !== 1 || commit.parents[0]?.sha !== accepted.baseCommit
    || branch.commit.sha !== commit.sha) throw new Error("Fast-forward content or current target differs from the accepted candidate.");
  return { repositoryId: input.repositoryId, targetBranch: input.targetBranch, baseCommit: accepted.baseCommit,
    candidateCommit: accepted.candidateCommit, mergedCommit: commit.sha, mergedTree: commit.commit.tree.sha };
}

/** Close only this unmerged, unchanged proposal. Never delete its branch or history. */
export async function discardGitHubProposal(client: GitHubReleaseClient, input: {
  repositoryId: string; number: number; candidateCommit: string; baseCommit: string;
}) {
  if (!Number.isSafeInteger(input.number) || input.number <= 0) throw new Error("Invalid proposal number.");
  const path = `/pulls/${input.number}`;
  const validate = (pull: PullRequest) => {
    if (pull.merged || pull.head.sha !== input.candidateCommit || pull.head.repo?.full_name !== input.repositoryId
      || pull.base.repo.full_name !== input.repositoryId) throw new Error("Proposal changed or was already merged.");
  };
  const previous = await client.request<PullRequest>("GET", path); validate(previous);
  if (previous.state !== "closed") await client.request("PATCH", path, { state: "closed" });
  const closed = await client.request<PullRequest>("GET", path); validate(closed);
  if (closed.state !== "closed") throw new Error("Proposal closure is unconfirmed.");
  return { repositoryId: input.repositoryId, number: input.number, candidateCommit: input.candidateCommit, state: "closed", merged: false };
}
