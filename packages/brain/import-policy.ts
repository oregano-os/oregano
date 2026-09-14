import type { StateStore } from "../state-store/interface.ts";
import { sha256 } from "../runtime/canonical.ts";

export interface TranscriptSelectionPolicy {
  max_transcripts: number;
  meeting_date: { start_at: string | null; end_at: string | null };
  mode: "bounded";
}
export interface TranscriptCandidate {
  identity: string;
  source_version: string;
  meeting_start_at: string | null;
  origin: "local" | "provider";
  finished: boolean;
}
export interface TranscriptCohort {
  version: 1;
  id: string;
  policy_digest: string;
  run_id: string;
  frozen_at: string;
  policy: TranscriptSelectionPolicy;
  effective_dates: { start_at: string | null; end_at: string };
  admitted: TranscriptCandidate[];
  cumulative_count: number;
  already_admitted_outside_range: string[];
  excluded_unknown_date: string[];
  available_from_at: string | null;
}
interface Registry { version: 1; cohorts: TranscriptCohort[]; admitted: TranscriptCandidate[] }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(key => keys.includes(key));
const date = (v: unknown): v is string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) || !Number.isFinite(Date.parse(v))) return false;
  const [year, month, day] = v.slice(0, 10).split("-").map(Number);
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate() && Number(v.slice(11, 13)) < 24;
};
const identity = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 2048 && !/[\x00-\x1f]/.test(v);

/** Workspace values have no company-specific default; instants always include their offset. */
export function validateTranscriptSelectionPolicy(raw: unknown): TranscriptSelectionPolicy {
  if (!object(raw) || !exact(raw, ["max_transcripts", "meeting_date", "mode"]) || raw.mode !== "bounded"
    || !Number.isSafeInteger(raw.max_transcripts) || Number(raw.max_transcripts) < 1 || Number(raw.max_transcripts) > 10000
    || !object(raw.meeting_date) || !exact(raw.meeting_date, ["start_at", "end_at"])) throw new Error("Invalid bounded transcript selection policy");
  const { start_at: start, end_at: end } = raw.meeting_date;
  if (!(start === null || date(start)) || !(end === null || date(end)) || (start !== null && end !== null && Date.parse(start) >= Date.parse(end))) throw new Error("Transcript date bounds require ordered RFC3339 instants with explicit offsets");
  return { max_transcripts: Number(raw.max_transcripts), meeting_date: { start_at: start === null ? null : new Date(start).toISOString(), end_at: end === null ? null : new Date(end).toISOString() }, mode: "bounded" };
}
function validateCandidate(item: TranscriptCandidate) {
  if (!object(item) || !exact(item, ["identity", "source_version", "meeting_start_at", "origin", "finished"])
    || !identity(item.identity) || !identity(item.source_version) || !["local", "provider"].includes(item.origin)
    || typeof item.finished !== "boolean" || !(item.meeting_start_at === null || date(item.meeting_start_at))) throw new Error("Invalid transcript candidate identity, version or date");
}

/** Internal trusted setup boundary; callers must supply qualified inventory and reviewed Workspace policy. */
export async function freezeTranscriptCohort(args: {
  store: StateStore; instanceId: string; importId: string; runId: string;
  policy: TranscriptSelectionPolicy; now: string; candidates: readonly TranscriptCandidate[];
  reserved: readonly TranscriptCandidate[];
  inventoryComplete: boolean;
  availableFrom: string | null;
}): Promise<TranscriptCohort> {
  const policy = validateTranscriptSelectionPolicy(args.policy), policyDigest = sha256(policy);
  if (![args.instanceId, args.importId, args.runId].every(identity) || !date(args.now) || !(args.availableFrom === null || date(args.availableFrom))) throw new Error("Invalid transcript import identity or coverage");
  if (args.candidates.length > 20000 || args.reserved.length > 10000) throw new Error("Transcript discovery exceeds its bounded inventory");
  for (const item of [...args.candidates, ...args.reserved]) validateCandidate(item);
  const inputHash = sha256({ instance_id: args.instanceId, import_id: args.importId });
  const key = `brain-import-cohorts:${inputHash}`;
  await args.store.claimEffect({ idempotencyKey: key, runId: args.runId, stepId: "brain-import-cohorts", inputHash });
  for (let attempt = 0; attempt < 16; attempt++) {
    const effect = await args.store.getEffect(key);
    if (!effect || effect.status !== "claimed" || (effect.inputHash ?? effect.input_hash) !== inputHash) throw new Error("Transcript cohort registry is unavailable or has conflicting ownership");
    const previous = effect.evidence ?? null;
    const registry = (previous === null ? { version: 1, cohorts: [], admitted: [] } : structuredClone(previous)) as Registry;
    if (registry.version !== 1 || !Array.isArray(registry.cohorts) || !Array.isArray(registry.admitted)) throw new Error("Invalid retained transcript cohort state");
    const frozen = registry.cohorts.find(cohort => cohort.policy_digest === policyDigest);
    // A restart, timer, another subject or deployment cannot refill this configuration.
    if (frozen) {
      if (args.reserved.some(item => !registry.admitted.some(admitted => admitted.identity === item.identity))) throw new Error("New local evidence cannot be added to an already frozen transcript cohort");
      if (args.runId !== frozen.run_id && policy.max_transcripts < registry.admitted.length) throw new Error("Transcript ceiling is lower than the already admitted cumulative count");
      return structuredClone(frozen);
    }
    if (registry.cohorts.some(cohort => cohort.run_id === args.runId)) throw new Error("A running transcript cohort cannot change its frozen configuration");
    if (policy.max_transcripts < registry.admitted.length) throw new Error("Transcript ceiling is lower than the already admitted cumulative count");
    if (!args.inventoryComplete) throw new Error("Transcript discovery is incomplete; a cohort cannot be frozen yet");
    const start = policy.meeting_date.start_at, end = policy.meeting_date.end_at ?? new Date(args.now).toISOString();
    if ((start !== null && Date.parse(start) >= Date.parse(end)) || Date.parse(end) > Date.parse(args.now)) throw new Error("Transcript end must be after start and no later than the frozen setup time");
    if (start !== null && args.availableFrom !== null && Date.parse(start) < Date.parse(args.availableFrom)) throw new Error("Requested transcript start precedes available provider history; historical coverage is incomplete");
    const within = (item: TranscriptCandidate) => item.meeting_start_at !== null && (start === null || Date.parse(item.meeting_start_at) >= Date.parse(start)) && Date.parse(item.meeting_start_at) < Date.parse(end);
    const admitted = new Map(registry.admitted.map(item => [item.identity, item]));
    const additions: TranscriptCandidate[] = [];
    for (const item of args.reserved) {
      if (admitted.has(item.identity)) continue;
      if (admitted.size >= policy.max_transcripts) throw new Error("Previously used transcript samples exceed the cumulative ceiling");
      if (item.origin !== "local") throw new Error("Only previously used local source evidence may reserve a transcript slot");
      admitted.set(item.identity, structuredClone(item)); additions.push(structuredClone(item));
    }
    const candidates = new Map<string, TranscriptCandidate>();
    for (const item of args.candidates) {
      const duplicate = candidates.get(item.identity);
      if (duplicate && sha256(duplicate) !== sha256(item)) throw new Error("One discovered transcript has conflicting versions or provenance");
      candidates.set(item.identity, item);
    }
    const eligible = [...candidates.values()].filter(item => item.finished && within(item) && !admitted.has(item.identity))
      .sort((a, b) => Date.parse(b.meeting_start_at!) - Date.parse(a.meeting_start_at!) || (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
    for (const item of eligible) {
      if (admitted.size >= policy.max_transcripts) break;
      admitted.set(item.identity, structuredClone(item)); additions.push(structuredClone(item));
    }
    const cohort: TranscriptCohort = { version: 1, id: sha256({ inputHash, policyDigest }), policy_digest: policyDigest, run_id: args.runId,
      frozen_at: new Date(args.now).toISOString(), policy, effective_dates: { start_at: start, end_at: end }, admitted: additions,
      cumulative_count: admitted.size, already_admitted_outside_range: [...admitted.values()].filter(item => !within(item)).map(item => item.identity).sort(),
      excluded_unknown_date: [...candidates.values()].filter(item => item.meeting_start_at === null && !admitted.has(item.identity)).map(item => item.identity).sort(),
      available_from_at: args.availableFrom };
    const next: Registry = { version: 1, cohorts: [...registry.cohorts, cohort], admitted: [...admitted.values()] };
    if (next.cohorts.length > 1000) throw new Error("Transcript import exceeds its cohort history bound");
    if (await args.store.compareAndSetEffect({ idempotencyKey: key, inputHash, expectedStatus: "claimed", expectedEvidence: previous, status: "claimed", evidence: next })) return structuredClone(cohort);
  }
  throw new Error("Transcript cohort changed concurrently; retry the same activation without resetting state");
}
