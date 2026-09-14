import { randomUUID } from "node:crypto";
import type { StateStore, WorkflowDispatchFence } from "../state-store/interface.ts";
import type { ModelExecutionSelection } from "../runner/model-execution.ts";
import { sha256 } from "../runtime/canonical.ts";

interface AttemptContext {
  runId: string; stepId: string; inputHash: string; evidence: Record<string, unknown>; fence?: WorkflowDispatchFence;
}

/** Existing control events/effects retain payload-free evidence for every paid attempt. */
export class LanguageAttempt {
  readonly id = `language-attempt:${randomUUID()}`;
  #dispatched = false;
  readonly store: StateStore;
  readonly context: AttemptContext;
  constructor(store: StateStore, context: AttemptContext) { this.store = store; this.context = context; }
  get dispatched() { return this.#dispatched; }
  async prepare() {
    if (!await this.store.claimEffect({ idempotencyKey: this.id, runId: this.context.runId, stepId: this.context.stepId, inputHash: this.context.inputHash })) throw new Error("Language attempt identity already exists");
    await this.#event("prepared", { outcome: "prepared" });
  }
  async dispatch(selection: ModelExecutionSelection) {
    if (this.#dispatched) throw new Error("Language attempt cannot dispatch twice");
    if (!await this.store.markEffectDispatched(this.id, this.context.fence)) throw new Error("Language attempt dispatch fence is no longer valid");
    this.#dispatched = true;
    await this.#event("dispatched", { outcome: "dispatched", model_execution: selection });
  }
  async finish(outcome: "succeeded" | "failed" | "unknown", evidence: Record<string, unknown>) {
    const receipt = { ...this.context.evidence, ...evidence, attempt_id: this.id, outcome, dispatched: this.#dispatched };
    if (outcome === "succeeded") await this.store.completeEffect(this.id, receipt);
    else if (outcome === "unknown") await this.store.markEffectUnknown(this.id, receipt);
    else await this.store.markEffectFailed(this.id, receipt);
    await this.#event("finished", receipt, outcome === "unknown" ? "effect-unknown" : outcome);
  }
  async #event(phase: string, evidence: Record<string, unknown>, status?: "succeeded" | "failed" | "effect-unknown") {
    await this.store.appendEvent({ runId: this.context.runId, stepId: this.context.stepId, actor: "agent", event: `language.attempt-${phase}`,
      idempotencyKey: this.id, ...(status ? { status } : {}), evidence: { ...this.context.evidence, ...evidence, attempt_id: this.id, recorded_at: new Date().toISOString() } });
  }
}

/** Never log provider bodies, partial text, reasoning, prompts or raw error messages. */
export function languageFailureDigest(error: unknown): string { return sha256(error instanceof Error ? `${error.name}:${error.message}` : "Unknown failure"); }


export interface LanguageAttemptReceipt {
  attempt_id: string;
  run_id: string;
  step_id: string;
  status: "prepared" | "succeeded" | "failed" | "unknown";
  dispatched_at: string | null;
  evidence: Record<string, unknown>;
}

/** A lost completion event is reconciled from its existing effect receipt. No model is called. */
export async function readLanguageAttempts(store: StateStore, runIds: readonly string[]): Promise<LanguageAttemptReceipt[]> {
  const receipts: LanguageAttemptReceipt[] = [];
  for (const runId of new Set(runIds)) {
    const events = await store.listEvents(runId, 10001);
    if (events.length >= 10001) throw new Error("Language attempt report exceeds the event read bound; split its workflow scope");
    const attempts = new Map<string, LanguageAttemptReceipt>();
    for (const event of events) {
      if (!String(event.event).startsWith("language.attempt-")) continue;
      const evidence = event.evidence as Record<string, unknown> | undefined;
      if (!evidence || typeof evidence.attempt_id !== "string") throw new Error("Language attempt event is missing its identity");
      const id = evidence.attempt_id, stepId = String(event.stepId ?? event.step_id);
      const receipt = attempts.get(id) ?? { attempt_id: id, run_id: runId, step_id: stepId, status: "prepared" as const, dispatched_at: null, evidence: {} };
      if (receipt.step_id !== stepId) throw new Error("Language attempt is attributed to conflicting steps");
      receipt.evidence = structuredClone({ ...receipt.evidence, ...evidence });
      if (event.event === "language.attempt-dispatched") {
        receipt.status = "unknown";
        receipt.dispatched_at = String(evidence.recorded_at);
      }
      attempts.set(id, receipt);
    }
    for (const receipt of attempts.values()) {
      const effect = await store.getEffect(receipt.attempt_id);
      if (!effect) throw new Error("Language attempt effect receipt is unavailable");
      if (effect.evidence && typeof effect.evidence === "object") receipt.evidence = structuredClone({ ...receipt.evidence, ...effect.evidence as Record<string, unknown> });
      receipt.status = effect.status === "claimed" ? "prepared" : effect.status === "succeeded" ? "succeeded" : effect.status === "failed" ? "failed" : "unknown";
      receipts.push(receipt);
    }
  }
  return receipts.sort((a, b) => a.attempt_id.localeCompare(b.attempt_id));
}
