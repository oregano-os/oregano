import { sha256 } from "../runtime/canonical.ts";

export type CompoundingScope = "source" | "mixed" | "global";
export type CompoundingPhaseName = "triage" | "consolidate" | "salience" | "exact-links" | "conflicts" | "syntheses" | "grading" | "merge-proposals" | "temporary-cleanup";

export interface CompoundingPhase {
  name: CompoundingPhaseName;
  scope: CompoundingScope;
  budget: number;
  execute(input: { sourceId?: string; continuation?: string; budget: number }): Promise<{ processed: number; total: number; complete: boolean; continuation?: string; evidenceDigest: string }>;
}

export interface CompoundingReceipt {
  receiptId: string;
  cycleId: string;
  phase: CompoundingPhaseName;
  scope: CompoundingScope;
  scopeId: string;
  processed: number;
  total?: number;
  complete: boolean;
  continuation?: string;
  evidenceDigest: string;
  startedAt: string;
  completedAt: string;
}

export interface CompoundingStateStore {
  acquire(lockKey: string, owner: string, until: string): Promise<boolean>;
  release(lockKey: string, owner: string): Promise<void>;
  getReceipt(idempotencyKey: string): Promise<CompoundingReceipt | undefined>;
  putReceipt(idempotencyKey: string, receipt: CompoundingReceipt): Promise<void>;
}

export class InMemoryCompoundingStateStore implements CompoundingStateStore {
  readonly locks = new Map<string, { owner: string; until: string }>();
  readonly receipts = new Map<string, CompoundingReceipt>();
  async acquire(key: string, owner: string, until: string): Promise<boolean> { const current = this.locks.get(key); if (current && Date.parse(current.until) > Date.now() && current.owner !== owner) return false; this.locks.set(key, { owner, until }); return true; }
  async release(key: string, owner: string): Promise<void> { if (this.locks.get(key)?.owner === owner) this.locks.delete(key); }
  async getReceipt(key: string): Promise<CompoundingReceipt | undefined> { const value = this.receipts.get(key); return value ? structuredClone(value) : undefined; }
  async putReceipt(key: string, receipt: CompoundingReceipt): Promise<void> {
    const existing = this.receipts.get(key);
    if (existing && existing.receiptId !== receipt.receiptId) {
      const sameIdentity = existing.cycleId === receipt.cycleId && existing.phase === receipt.phase
        && existing.scope === receipt.scope && existing.scopeId === receipt.scopeId;
      if (existing.complete || !sameIdentity) throw new Error(`Compounding idempotency key '${key}' was reused.`);
    }
    this.receipts.set(key, structuredClone(receipt));
  }
}

export async function runCompoundingCycle(input: { cycleId: string; sourceIds: string[]; phases: readonly CompoundingPhase[]; state: CompoundingStateStore; owner: string; now?: () => string }): Promise<CompoundingReceipt[]> {
  const receipts: CompoundingReceipt[] = [];
  for (const phase of input.phases) {
    const scopes = phase.scope === "source" ? [...new Set(input.sourceIds)].sort() : [phase.scope === "mixed" ? "brain:mixed" : "brain:global"];
    for (const scopeId of scopes) {
      const idempotencyKey = sha256({ cycleId: input.cycleId, phase: phase.name, scope: phase.scope, scopeId });
      const existing = await input.state.getReceipt(idempotencyKey); if (existing?.complete) { receipts.push(existing); continue; }
      const lockKey = `compounding:${phase.scope}:${phase.scope === "source" ? scopeId : phase.name}`;
      const startedAt = input.now?.() ?? new Date().toISOString();
      if (!await input.state.acquire(lockKey, input.owner, new Date(Date.parse(startedAt) + 300_000).toISOString())) continue;
      try {
        const result = await phase.execute({ ...(phase.scope === "source" ? { sourceId: scopeId } : {}), continuation: existing?.continuation, budget: phase.budget });
        if (result.processed < 0 || result.processed > phase.budget || !Number.isInteger(result.total) || result.total < result.processed || !/^[a-f0-9]{64}$/.test(result.evidenceDigest)) throw new Error(`Compounding phase '${phase.name}' returned invalid bounded evidence.`);
        const completedAt = input.now?.() ?? new Date().toISOString();
        const value = { cycleId: input.cycleId, phase: phase.name, scope: phase.scope, scopeId, processed: result.processed, total: result.total, complete: result.complete, ...(result.continuation ? { continuation: result.continuation } : {}), evidenceDigest: result.evidenceDigest, startedAt, completedAt };
        const receipt = { receiptId: sha256(value), ...value };
        await input.state.putReceipt(idempotencyKey, receipt); receipts.push(receipt);
      } finally { await input.state.release(lockKey, input.owner); }
    }
  }
  return receipts;
}
