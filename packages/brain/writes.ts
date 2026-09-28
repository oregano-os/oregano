import { randomUUID } from "node:crypto";
import { CapabilityEffectOutcomeUnknownError, type CapabilityCallContext } from "../capabilities/contracts.ts";
import type { StateStore, WorkflowDispatchFence } from "../state-store/interface.ts";
import type { BrainStore } from "../state-store/brain.ts";
import type { CompanyRecordsStore } from "../state-store/records.ts";
import type { BrainRepositoryBinding, BrainRepositoryCommitReceipt, BrainRepositoryCommitRequest, BrainRepositoryMutationSource } from "../runtime/repository/contracts.ts";
import { sha256 } from "../runtime/canonical.ts";
import { BrainError, type BrainConfiguration, type BrainRevision, type BrainScope } from "./contracts.ts";
import { assertBrainWriteIdentity, prepareBrainForget, prepareBrainRemember, type BrainForgetInput, type BrainRememberInput } from "./mutations.ts";
import { syncBrain } from "./sync.ts";
import { parseBrainPage } from "./documents.ts";

type Kind = "remember" | "forget";
type Input = BrainRememberInput | BrainForgetInput;
type State = "claimed" | "dispatched" | "unknown" | "succeeded";
export interface BrainWriteResult {
  status: "dry_run" | "unchanged" | "saved";
  operation_id: string;
  base_commit: string;
  saved_commit: string | null;
  changed_paths: string[];
  /** Saved content digests, including unchanged remember targets; absent on legacy receipts. */
  page_results?: Array<{ path: string; content_hash: string | null }>;
  sync_status: "not_requested" | "pending" | "indexed" | "current_head_indexed";
  indexed_revision: BrainRevision | null;
  sync_error?: string;
}
/** Host-owned pending effect; Company Tool text cannot request automatic reconciliation. */
export class BrainRecoveryPendingError extends CapabilityEffectOutcomeUnknownError {
  constructor(evidence: unknown) {
    super("Brain write receipt or synchronization is pending; only read-only reconciliation may resume this effect.", evidence);
    this.name = "BrainRecoveryPendingError";
  }
}
interface Checkpoint {
  version: 1; kind: Kind; operation_id: string; input_digest: string; base_commit: string;
  actor: string; agent: string; phase: "prepared" | "saved";
  changes: Array<{ path: string; before: string | null; after: string | null }>;
  page_results?: BrainWriteResult["page_results"];
  receipt?: BrainRepositoryCommitReceipt;
  result?: BrainWriteResult;
}

/** Uses the existing effects and repository leases. Markdown is never an effect payload. */
export class BrainWrites {
  readonly options: { scope: BrainScope; binding: BrainRepositoryBinding; configuration: BrainConfiguration;
    store: BrainStore; effects: StateStore; leases: Pick<CompanyRecordsStore, "claimSyncLease" | "releaseSyncLease">;
    repository: BrainRepositoryMutationSource; now?: () => Date };
  constructor(options: BrainWrites["options"]) {
    this.options = options;
    if (options.scope.instance_id !== options.binding.instanceId || options.scope.repository_id !== options.binding.repositoryId) {
      throw new BrainError("binding_mismatch", "Brain writes must use the bound Instance and repository.");
    }
  }

  #retirement(path: string) {
    const digest = sha256({ scope: this.options.scope, branch: this.options.binding.branch, path });
    return { key: `brain-take-retirement:${digest}`, digest };
  }
  async #retiredThrough(path: string): Promise<number> {
    const { key, digest } = this.#retirement(path), row = await this.options.effects.getEffect(key);
    if (!row) return 0;
    const high = (row.evidence as { retired_through?: number } | undefined)?.retired_through;
    if ((row.input_hash ?? row.inputHash) !== digest || !Number.isSafeInteger(high) || high! < 0) throw new BrainError("recovery_required", "Retained Take identity metadata is unavailable.");
    return high!;
  }
  async #retire(path: string, high: number, context: CapabilityCallContext): Promise<void> {
    if (!high) return;
    const { effects } = this.options, { key, digest } = this.#retirement(path);
    let row = await effects.getEffect(key);
    if (!row) {
      if (!await effects.claimEffect({ idempotencyKey: key, inputHash: digest, runId: context.runId, stepId: context.stepId })) throw new BrainError("recovery_conflict", "Take identity retirement was claimed concurrently.");
      row = (await effects.getEffect(key))!;
    }
    const previous = row.evidence as { retired_through?: number } | undefined;
    if ((row.input_hash ?? row.inputHash) !== digest || !["claimed", "succeeded"].includes(String(row.status))
      || (previous && (!Number.isSafeInteger(previous.retired_through) || previous.retired_through! < 0))) throw new BrainError("recovery_required", "Retained Take identity metadata is invalid.");
    if ((previous?.retired_through ?? 0) >= high) return;
    if (!await effects.compareAndSetEffect({ idempotencyKey: key, inputHash: digest, expectedStatus: row.status as "claimed" | "succeeded",
      expectedEvidence: previous ?? null, status: row.status as "claimed" | "succeeded", evidence: { retired_through: high } })) throw new BrainError("recovery_conflict", "Take identity retirement changed concurrently.");
    if (row.status === "claimed") await effects.completeEffect(key, { retired_through: high });
  }

  async execute(kind: Kind, input: Input, context: CapabilityCallContext, recovery?: { only: boolean; fence?: WorkflowDispatchFence }): Promise<BrainWriteResult> {
    const { scope, binding, configuration, effects, leases, repository } = this.options;
    if (context.instanceId !== scope.instance_id || !context.idempotencyKey || context.subject?.status !== "active"
      || !context.subject.groupIds.includes("company:active")) throw new BrainError("access_denied", "A write requires an authenticated active company subject and effect context.");
    const expected = kind === "remember" ? (input as BrainRememberInput).changes?.expected_revision : (input as BrainForgetInput).target?.expected_revision;
    assertBrainWriteIdentity(expected, input.operation_key);
    const pageResults = (files: Record<string, string>, changedPaths: string[]) =>
      [...new Set(kind === "remember" ? (input as BrainRememberInput).changes.pages.map(page => page.path) : changedPaths)]
        .sort().map(path => ({ path, content_hash: Object.hasOwn(files, path) ? sha256(files[path]) : null }));
    const operation = sha256({ scope, branch: binding.branch, operation_key: input.operation_key });
    const key = `brain-operation:${operation}`, digest = sha256({ kind, input: { ...input, dry_run: false }, configuration: sha256(configuration) });
    const now = this.options.now ?? (() => new Date()), sourceId = `brain-write:${sha256({ scope, branch: binding.branch })}`, token = randomUUID();
    const expiresAt = new Date(now().getTime() + 300_000).toISOString();
    if (!await leases.claimSyncLease({ instanceId: scope.instance_id, sourceId, owner: "brain-write", token, now: now().toISOString(), expiresAt })) {
      throw new BrainError("write_busy", "Another write owns the repository lease; retry the same operation key.");
    }
    try {
      if (input.dry_run) {
        const base = await repository.brainRevision(binding), files = await repository.brainFiles(binding, base);
        const prepared = kind === "remember" ? prepareBrainRemember(files, configuration, input as BrainRememberInput) : prepareBrainForget(files, configuration, input as BrainForgetInput);
        await this.#checkRetiredRows(files, prepared.changes);
        return { status: "dry_run", operation_id: operation, base_commit: base, saved_commit: null,
          changed_paths: prepared.changes.map(change => change.path), page_results: pageResults(prepared.files, prepared.changes.map(change => change.path)),
          sync_status: "not_requested", indexed_revision: await this.options.store.revision(scope) ?? null };
      }
      let row = await effects.getEffect(key);
      let checkpoint = row?.evidence as Checkpoint | undefined;
      let state = row?.status as State | undefined;
      let retainedClaim = false;
      if (row) {
        if ((row.input_hash ?? row.inputHash) !== digest) throw new BrainError("operation_conflict", "The operation key is already bound to different input.");
        if (row.status === "failed") throw new BrainError("operation_failed", "This operation failed before a confirmed commit; resolve its conflict and use a new operation key.");
        if (!checkpoint && row.status === "claimed" && !recovery?.only) {
          if (recovery?.fence && (row.run_id ?? row.runId) !== context.runId) throw new BrainError("dispatch_refused", "A different Workflow cannot dispatch this retained claim.");
          retainedClaim = true; row = undefined;
        } else if (!checkpoint || checkpoint.version !== 1 || checkpoint.operation_id !== operation || checkpoint.input_digest !== digest) {
          throw new BrainError("recovery_required", "The durable operation has no complete preparation proof; no write was retried.");
        }
      } else if (recovery?.only) throw new BrainError("recovery_required", "There is no durable operation to reconcile; no write was attempted.");

      const advance = async (next: Checkpoint, status: State = state!) => {
        if (status === "unknown" || !await effects.compareAndSetEffect({ idempotencyKey: key, inputHash: digest,
          expectedStatus: state!, expectedEvidence: checkpoint ?? null, status, evidence: next })) {
          throw new BrainError("recovery_conflict", "The retained operation changed; reload its existing receipt before continuing.");
        }
        checkpoint = next; state = status;
      };
      let request: BrainRepositoryCommitRequest | undefined;
      if (!row || checkpoint!.phase === "prepared") {
        // On replay, reconstruct only the exact retained preparation. It cannot authorize a resend.
        const base = checkpoint?.base_commit ?? await repository.brainRevision(binding);
        const files = await repository.brainFiles(binding, base);
        const prepared = kind === "remember" ? prepareBrainRemember(files, configuration, input as BrainRememberInput)
          : prepareBrainForget(files, configuration, input as BrainForgetInput);
        await this.#checkRetiredRows(files, prepared.changes);
        const changes = prepared.changes.map(change => ({ path: change.path, before: Object.hasOwn(files, change.path) ? sha256(files[change.path]) : null,
          after: change.markdown === null ? null : sha256(change.markdown) }));
        if (checkpoint && sha256(checkpoint.changes) !== sha256(changes)) throw new BrainError("recovery_conflict", "The reconstructed preparation does not match its durable proof.");
        const proposed: Checkpoint = checkpoint ?? { version: 1, kind, operation_id: operation, input_digest: digest, base_commit: base,
          actor: context.subject.principalId, agent: context.agentId, phase: "prepared", changes, page_results: pageResults(prepared.files, changes.map(change => change.path)) };
        request = { binding, baseCommit: base, operationId: operation, inputDigest: digest,
          changes: prepared.changes.map(change => ({ ...change, expectedContentHash: Object.hasOwn(files, change.path) ? sha256(files[change.path]) : null })) };
        if (!row || state === "claimed" && !recovery?.only) {
          if (!row && !retainedClaim && !await effects.claimEffect({ idempotencyKey: key, runId: context.runId, stepId: context.stepId, inputHash: digest })) {
            throw new BrainError("write_busy", "This operation was claimed concurrently; retry the same key.");
          }
          state = "claimed";
          await advance(proposed);
          for (const change of prepared.changes.filter(change => change.markdown === null)) {
            const takes = parseBrainPage(change.path, files[change.path], configuration).page!.takes;
            await this.#retire(change.path, Math.max(0, ...takes.map(take => take.row_num)), context);
          }
          if (now().toISOString() >= expiresAt || !await effects.markEffectDispatched(key, recovery?.fence)) {
            throw new BrainError("dispatch_refused", "The write lease or Workflow dispatch authority is no longer current.");
          }
          state = "dispatched";
          if (changes.length) {
            try {
              const receipt = await repository.brainCommit(request);
              await advance({ ...checkpoint!, phase: "saved", receipt });
            } catch (error) {
              if (error instanceof BrainError && ["write_conflict", "repository_review_required", "invalid_path", "invalid_batch"].includes(error.code)) {
                await effects.markEffectFailed(key, { ...checkpoint, failure_code: error.code });
                throw error;
              }
              // This includes a lost database response after Git succeeded. Retain the preparation; never resend.
              throw new CapabilityEffectOutcomeUnknownError("The Git outcome requires read-only receipt reconciliation; retry the same operation key.", { operation_id: operation, input_digest: digest });
            }
          } else await advance({ ...checkpoint!, phase: "saved" });
        } else if (checkpoint!.changes.length) {
          const receipt = await repository.brainFindCommit(request);
          if (!receipt) throw new CapabilityEffectOutcomeUnknownError("No exact Git receipt was found in the bounded history; no write was retried.", { operation_id: operation, input_digest: digest });
          await advance({ ...checkpoint!, phase: "saved", receipt });
        } else await advance({ ...checkpoint!, phase: "saved" });
      }

      const saved = checkpoint!;
      let indexed: BrainRevision | null = null, syncStatus: BrainWriteResult["sync_status"] = "pending", syncError: string | undefined;
      try {
        const synced = await syncBrain({ scope, configuration, store: this.options.store, leases, now,
          repository: { revision: () => repository.brainRevision(binding), read: revision => repository.brainFiles(binding, revision) } });
        indexed = synced.indexed_revision;
        if (synced.status === "invalid") syncError = "invalid_corpus";
        else syncStatus = indexed?.git_commit === (saved.receipt?.commit ?? saved.base_commit) ? "indexed" : "current_head_indexed";
      } catch (error) { syncError = error instanceof BrainError ? error.code : "index_unavailable"; }
      const result: BrainWriteResult = { status: saved.changes.length ? "saved" : "unchanged", operation_id: operation, base_commit: saved.base_commit,
        saved_commit: saved.receipt?.commit ?? null, changed_paths: saved.changes.map(change => change.path), sync_status: syncStatus,
        ...(saved.page_results ? { page_results: saved.page_results } : {}),
        indexed_revision: indexed, ...(syncError ? { sync_error: syncError } : {}) };
      await advance({ ...saved, result }, "succeeded");
      return result;
    } finally { await leases.releaseSyncLease({ instanceId: scope.instance_id, sourceId, token }); }
  }

  async #checkRetiredRows(files: Record<string, string>, changes: Array<{ path: string; markdown: string | null }>) {
    for (const change of changes) {
      if (change.markdown === null) continue;
      const next = parseBrainPage(change.path, change.markdown, this.options.configuration).page!;
      if (!next.takes.length) continue;
      const previous = files[change.path] === undefined ? [] : parseBrainPage(change.path, files[change.path], this.options.configuration).page!.takes;
      const high = await this.#retiredThrough(change.path);
      if (next.takes.some(take => !previous.some(old => old.row_num === take.row_num) && take.row_num <= high)) {
        throw new BrainError("take_identity_conflict", "New Take rows must exceed the retired page's retained high watermark, even after deletion or projection rebuild.");
      }
    }
  }
}
