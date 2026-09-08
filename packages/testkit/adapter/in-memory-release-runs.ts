import { randomUUID } from "node:crypto";
import { releaseIsTerminal, type ReleaseLease, type ReleaseRun, type ReleaseRunStore } from "../../state-store/release-runs.ts";

export class InMemoryReleaseRunStore implements ReleaseRunStore {
  readonly runs = new Map<string, ReleaseRun>();
  readonly history: ReleaseRun[] = [];
  readonly locks = new Map<string, { token: string; expiresAt: string }>();
  async create(run: ReleaseRun): Promise<ReleaseRun> {
    const existing = this.runs.get(run.id);
    if (existing && existing.candidateDigest !== run.candidateDigest) throw new Error("Release identity was reused with different content.");
    if (!existing) { this.runs.set(run.id, structuredClone(run)); this.history.push(structuredClone(run)); }
    return structuredClone(existing ?? run);
  }
  async get(id: string) { const run = this.runs.get(id); return run ? structuredClone(run) : undefined; }
  async claim(instanceId: string, workerId: string, now: string, leaseMs: number): Promise<ReleaseLease | undefined> {
    if (!workerId || !Number.isSafeInteger(leaseMs) || leaseMs < 1000) throw new Error("Invalid release lease.");
    const current = this.locks.get(instanceId);
    if (current && current.expiresAt > now) return undefined;
    const run = [...this.runs.values()]
      .sort((a, b) => Number(releaseIsTerminal(a)) - Number(releaseIsTerminal(b)))
      .find((entry) => entry.candidate.instanceId === instanceId && (!releaseIsTerminal(entry) || !entry.notificationDelivered));
    if (!run) return undefined;
    const lock = { token: randomUUID(), expiresAt: new Date(Date.parse(now) + leaseMs).toISOString() };
    this.locks.set(instanceId, lock);
    return { run: structuredClone(run), ...lock };
  }
  async save(lease: ReleaseLease, run: ReleaseRun, now: string): Promise<ReleaseLease> {
    const lock = this.locks.get(run.candidate.instanceId);
    const current = this.runs.get(run.id);
    if (!lock || lock.token !== lease.token || lock.expiresAt <= now || !current
      || current.revision !== lease.run.revision || run.revision !== current.revision + 1
      || run.candidateDigest !== current.candidateDigest) throw new Error("Release lease or revision is stale.");
    this.runs.set(run.id, structuredClone(run)); this.history.push(structuredClone(run));
    return { ...lease, run: structuredClone(run) };
  }
  async release(lease: ReleaseLease): Promise<void> {
    if (this.locks.get(lease.run.candidate.instanceId)?.token === lease.token) this.locks.delete(lease.run.candidate.instanceId);
  }
  async requestRollback(id: string, actor: string, expectedRevision: number, now: string): Promise<ReleaseRun> {
    const run = this.runs.get(id);
    if (!run || run.revision !== expectedRevision || !["live", "failed"].includes(run.stage)
      || (this.locks.get(run.candidate.instanceId)?.expiresAt ?? "") > now) throw new Error("Release changed or is busy.");
    const next: ReleaseRun = { ...run, stage: "rolling-back", rollbackBy: actor, notificationDelivered: false, revision: run.revision + 1, updatedAt: now };
    this.runs.set(id, next); this.history.push(structuredClone(next));
    return structuredClone(next);
  }
}
