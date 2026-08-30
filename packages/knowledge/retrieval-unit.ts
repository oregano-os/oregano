import { canonicalJson, sha256 } from "../runtime/canonical.ts";
import type { KnowledgeBundle, KnowledgeCitation } from "./contracts.ts";
import type { KnowledgeRetrievalRecordV2, KnowledgeResultLabel } from "./retrieval-v2.ts";

export const KNOWLEDGE_RETRIEVAL_PROJECTION_V3_CONTRACT_VERSION = "3.0.0-alpha.1" as const;

export type KnowledgeRetrievalUnitKind =
  | "handbook-fragment"
  | "page-fragment"
  | "claim"
  | "source-object"
  | "timeline-event"
  | "working-synthesis";

export type KnowledgeAuthorityLayer = "official" | "attributed" | "evidence" | "synthesized";
export type KnowledgeRetrievalUnitState = "active" | "proposed" | "contested" | "resolved" | "superseded" | "expired";

export type KnowledgeRetrievalEvidenceLocator =
  | { kind: "line"; start: number; end: number }
  | { kind: "timestamp"; startMs: number; endMs: number }
  | { kind: "provider-object"; value: string }
  | { kind: "json-pointer"; value: string };

export interface KnowledgeRetrievalSignalsV3 {
  confidence: number;
  authority: number;
  freshness: number;
  expectedValue: number;
}

export interface KnowledgeRetrievalUnitV3 {
  unitId: string;
  parentId: string;
  kind: KnowledgeRetrievalUnitKind;
  authorityLayer: KnowledgeAuthorityLayer;
  state: KnowledgeRetrievalUnitState;
  title: string;
  aliases: string[];
  text: string;
  contentDigest: string;
  accessPolicyId: string;
  sourceIds: string[];
  observedAt: string;
  validFrom?: string;
  validUntil?: string;
  evidenceLocator?: KnowledgeRetrievalEvidenceLocator;
  graphNeighbors: string[];
  signals: KnowledgeRetrievalSignalsV3;
}

export interface KnowledgeRetrievalProjectionV3 {
  contractVersion: typeof KNOWLEDGE_RETRIEVAL_PROJECTION_V3_CONTRACT_VERSION;
  projectionHash: string;
  sourceSnapshotIds: string[];
  units: KnowledgeRetrievalUnitV3[];
  createdAt: string;
}

const required = (value: string, label: string, maximum = 1_000): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  if (normalized.length > maximum || /[\0-\x08\x0b\x0c\x0e-\x1f]/.test(normalized)) throw new Error(`${label} is invalid.`);
  return normalized;
};

const iso = (value: string, label: string): string => {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(timestamp).toISOString();
};

const boundedSignal = (value: number, label: string): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${label} must be between 0 and 1.`);
  return Number(value.toFixed(6));
};

const unique = (values: readonly string[], label: string, maximum = 500): string[] => {
  if (!Array.isArray(values) || values.length > maximum) throw new Error(`${label} exceeds its bounded list size.`);
  return [...new Set(values.map((value) => required(value, label, 1_000)))].sort();
};

const compatibleAliases = (values: readonly string[]): string[] => values
  .map((value) => value.trim())
  .filter((value) => Boolean(value) && value.length <= 1_000 && !/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(value));

const evidenceLocator = (value: KnowledgeRetrievalEvidenceLocator | undefined): KnowledgeRetrievalEvidenceLocator | undefined => {
  if (!value) return undefined;
  if (value.kind === "line") {
    if (!Number.isInteger(value.start) || !Number.isInteger(value.end) || value.start < 1 || value.end < value.start) throw new Error("Retrieval line locator is invalid.");
    return { kind: "line", start: value.start, end: value.end };
  }
  if (value.kind === "timestamp") {
    if (!Number.isInteger(value.startMs) || !Number.isInteger(value.endMs) || value.startMs < 0 || value.endMs < value.startMs) throw new Error("Retrieval timestamp locator is invalid.");
    return { kind: "timestamp", startMs: value.startMs, endMs: value.endMs };
  }
  if (value.kind === "provider-object") return { kind: "provider-object", value: required(value.value, "Retrieval provider-object locator", 2_000) };
  if (value.kind === "json-pointer") {
    const pointer = required(value.value, "Retrieval JSON pointer", 2_000);
    if (!pointer.startsWith("/")) throw new Error("Retrieval JSON pointer must start with '/'.");
    return { kind: "json-pointer", value: pointer };
  }
  const exhaustive: never = value;
  throw new Error(`Unsupported Retrieval evidence locator '${String(exhaustive)}'.`);
};

const defaultAuthority = (layer: KnowledgeAuthorityLayer): number => layer === "official" ? 1 : layer === "attributed" ? 0.7 : layer === "synthesized" ? 0.45 : 0.55;

export function createKnowledgeRetrievalUnitV3(input: Omit<KnowledgeRetrievalUnitV3, "aliases" | "graphNeighbors" | "signals" | "observedAt" | "validFrom" | "validUntil" | "evidenceLocator"> & {
  aliases?: readonly string[];
  graphNeighbors?: readonly string[];
  signals?: Partial<KnowledgeRetrievalSignalsV3>;
  observedAt: string;
  validFrom?: string;
  validUntil?: string;
  evidenceLocator?: KnowledgeRetrievalEvidenceLocator;
}): KnowledgeRetrievalUnitV3 {
  const unitId = required(input.unitId, "Retrieval Unit ID");
  const parentId = required(input.parentId, "Retrieval Unit parent ID");
  const title = required(input.title, "Retrieval Unit title", 2_000);
  if (!input.text.trim()) throw new Error("Retrieval Unit text is required.");
  if (!/^[a-f0-9]{64}$/.test(input.contentDigest) || input.contentDigest !== sha256(input.text)) throw new Error("Retrieval Unit content digest does not match its exact text.");
  if (input.kind === "handbook-fragment" && input.authorityLayer !== "official") throw new Error("Handbook Retrieval Units must use the official authority layer.");
  if (input.kind !== "handbook-fragment" && input.authorityLayer === "official") throw new Error("Only Handbook Retrieval Units may use the official authority layer.");
  if (input.kind === "working-synthesis" && input.authorityLayer !== "synthesized") throw new Error("Working Synthesis Retrieval Units must remain synthesized Brain material.");
  if (input.kind === "source-object" && input.authorityLayer !== "evidence") throw new Error("Source Object Retrieval Units must remain evidence.");
  if (input.state === "proposed" && input.authorityLayer === "official") throw new Error("Proposed Retrieval Units cannot be official.");
  const observedAt = iso(input.observedAt, "Retrieval Unit observation time");
  const validFrom = input.validFrom ? iso(input.validFrom, "Retrieval Unit valid-from time") : undefined;
  const validUntil = input.validUntil ? iso(input.validUntil, "Retrieval Unit valid-until time") : undefined;
  if (validFrom && validUntil && Date.parse(validFrom) > Date.parse(validUntil)) throw new Error("Retrieval Unit validity range is invalid.");
  const graphNeighbors = unique(input.graphNeighbors ?? [], "Retrieval graph neighbor").filter((identity) => identity !== unitId);
  const sourceIds = unique(input.sourceIds, "Retrieval source ID");
  if (sourceIds.length === 0) throw new Error("Retrieval Unit requires at least one source ID.");
  const signals: KnowledgeRetrievalSignalsV3 = {
    confidence: boundedSignal(input.signals?.confidence ?? 0.7, "Retrieval confidence"),
    authority: boundedSignal(input.signals?.authority ?? defaultAuthority(input.authorityLayer), "Retrieval authority"),
    freshness: boundedSignal(input.signals?.freshness ?? 1, "Retrieval freshness"),
    expectedValue: boundedSignal(input.signals?.expectedValue ?? 0.6, "Retrieval expected value"),
  };
  return {
    unitId,
    parentId,
    kind: input.kind,
    authorityLayer: input.authorityLayer,
    state: input.state,
    title,
    aliases: unique(input.aliases ?? [], "Retrieval alias"),
    text: input.text,
    contentDigest: input.contentDigest,
    accessPolicyId: required(input.accessPolicyId, "Retrieval access policy ID"),
    sourceIds,
    observedAt,
    ...(validFrom ? { validFrom } : {}),
    ...(validUntil ? { validUntil } : {}),
    ...(input.evidenceLocator ? { evidenceLocator: evidenceLocator(input.evidenceLocator) } : {}),
    graphNeighbors,
    signals,
  };
}

export function createKnowledgeRetrievalProjectionV3(input: {
  units: readonly KnowledgeRetrievalUnitV3[];
  sourceSnapshotIds: readonly string[];
  createdAt: string;
}): KnowledgeRetrievalProjectionV3 {
  const byIdentity = new Map<string, KnowledgeRetrievalUnitV3>();
  for (const value of input.units) {
    const unit = createKnowledgeRetrievalUnitV3(value);
    const existing = byIdentity.get(unit.unitId);
    if (existing && canonicalJson(existing) !== canonicalJson(unit)) throw new Error(`Retrieval Unit identity '${unit.unitId}' was reused with different content or policy.`);
    if (!existing) byIdentity.set(unit.unitId, unit);
  }
  const sourceSnapshotIds = unique(input.sourceSnapshotIds, "Retrieval source snapshot ID");
  if (sourceSnapshotIds.length === 0) throw new Error("Retrieval projection requires at least one source snapshot ID.");
  const units = [...byIdentity.values()].sort((left, right) => left.unitId.localeCompare(right.unitId));
  const projectionBase = { contractVersion: KNOWLEDGE_RETRIEVAL_PROJECTION_V3_CONTRACT_VERSION, sourceSnapshotIds, units };
  return {
    ...projectionBase,
    projectionHash: sha256(projectionBase),
    createdAt: iso(input.createdAt, "Retrieval projection creation time"),
  };
}

const resultLabel = (unit: KnowledgeRetrievalUnitV3): KnowledgeResultLabel => {
  if (["contested", "superseded", "expired"].includes(unit.state)) return unit.state as "contested" | "superseded" | "expired";
  if (unit.authorityLayer === "official") return "official";
  if (unit.authorityLayer === "attributed") return "attributed";
  if (unit.authorityLayer === "synthesized") return "synthesized";
  return "evidence";
};

const recordKind = (kind: KnowledgeRetrievalUnitKind): KnowledgeRetrievalRecordV2["kind"] => {
  if (kind === "handbook-fragment") return "handbook";
  if (kind === "page-fragment") return "page";
  if (kind === "source-object") return "source-object";
  if (kind === "timeline-event") return "timeline-event";
  if (kind === "working-synthesis") return "synthesis";
  return "claim";
};

export function retrievalUnitV3ToRecordV2(unit: KnowledgeRetrievalUnitV3): KnowledgeRetrievalRecordV2 {
  const value = createKnowledgeRetrievalUnitV3(unit);
  return {
    identity: value.unitId,
    kind: recordKind(value.kind),
    pageId: value.parentId,
    title: value.title,
    aliases: [...value.aliases],
    text: value.text,
    contentDigest: value.contentDigest,
    accessPolicyId: value.accessPolicyId,
    label: resultLabel(value),
    observedAt: value.observedAt,
    sourceIds: [...value.sourceIds],
    confidence: value.signals.confidence,
    authority: value.signals.authority,
    freshness: value.signals.freshness,
    expectedValue: value.signals.expectedValue,
    graphNeighbors: [...value.graphNeighbors],
  };
}

const authorityFromLabel = (label: KnowledgeResultLabel): KnowledgeAuthorityLayer => {
  if (label === "official") return "official";
  if (label === "attributed") return "attributed";
  if (label === "synthesized") return "synthesized";
  return "evidence";
};

const stateFromLabel = (label: KnowledgeResultLabel): KnowledgeRetrievalUnitState => {
  if (label === "contested") return "contested";
  if (label === "superseded") return "superseded";
  if (label === "expired") return "expired";
  return "active";
};

const kindFromRecord = (record: KnowledgeRetrievalRecordV2): KnowledgeRetrievalUnitKind => {
  if (record.kind === "handbook") return "handbook-fragment";
  if (record.kind === "page") return "page-fragment";
  if (record.kind === "source-object") return "source-object";
  if (record.kind === "timeline-event") return "timeline-event";
  if (record.kind === "synthesis") return "working-synthesis";
  return "claim";
};

export function retrievalRecordV2ToUnitV3(record: KnowledgeRetrievalRecordV2, citation?: Omit<KnowledgeCitation, "snapshotHash">): KnowledgeRetrievalUnitV3 {
  const kind = kindFromRecord(record);
  const authorityLayer = authorityFromLabel(record.label);
  const sourceIds = record.sourceIds.map((value) => value.trim()).filter(Boolean);
  if (authorityLayer === "official" && kind !== "handbook-fragment") throw new Error("Retrieval V2 projected non-Handbook material as official authority.");
  return createKnowledgeRetrievalUnitV3({
    unitId: record.identity,
    parentId: record.pageId ?? record.identity,
    kind,
    authorityLayer,
    state: stateFromLabel(record.label),
    title: record.title,
    aliases: compatibleAliases(record.aliases),
    text: record.text,
    contentDigest: sha256(record.text),
    accessPolicyId: record.accessPolicyId,
    sourceIds: sourceIds.length > 0 ? sourceIds : [`brain:${kind}`],
    observedAt: record.observedAt,
    ...(citation ? { evidenceLocator: { kind: "line" as const, start: citation.startLine, end: citation.endLine } } : {}),
    graphNeighbors: record.graphNeighbors,
    signals: { confidence: record.confidence, authority: record.authority, freshness: record.freshness, expectedValue: record.expectedValue },
  });
}

export function handbookBundleToRetrievalUnitsV3(bundle: KnowledgeBundle, observedAt: string): KnowledgeRetrievalUnitV3[] {
  const firstFragment = new Map(bundle.documents.filter((document) => document.fragments.length > 0).map((document) => [document.path, `handbook:${document.path}#${document.fragments[0]!.fragmentId}`]));
  return bundle.documents.flatMap((document) => document.fragments.map((fragment) => createKnowledgeRetrievalUnitV3({
    unitId: `handbook:${document.path}#${fragment.fragmentId}`,
    parentId: `handbook:${document.path}`,
    kind: "handbook-fragment",
    authorityLayer: "official",
    state: document.status === "contested" ? "contested" : document.status === "stale" ? "expired" : "active",
    title: `${document.title} · ${fragment.heading}`,
    aliases: compatibleAliases([document.path, document.title, fragment.heading]),
    text: fragment.body,
    contentDigest: sha256(fragment.body),
    accessPolicyId: fragment.accessPolicyId,
    sourceIds: [`handbook:${bundle.workspaceCommit}`],
    observedAt,
    ...(document.validUntil ? { validUntil: document.validUntil } : {}),
    evidenceLocator: { kind: "line", start: fragment.startLine, end: fragment.endLine },
    graphNeighbors: document.links.map((path) => firstFragment.get(path)).filter((identity): identity is string => Boolean(identity)),
    signals: { confidence: 1, authority: 1, freshness: document.status === "current" ? 1 : 0.4, expectedValue: 0.8 },
  })));
}

export function buildKnowledgeRetrievalProjectionV3(input: {
  handbook?: KnowledgeBundle;
  brainProjectionHash?: string;
  brainRecords?: readonly KnowledgeRetrievalRecordV2[];
  brainCitations?: Record<string, Omit<KnowledgeCitation, "snapshotHash">>;
  createdAt: string;
}): KnowledgeRetrievalProjectionV3 {
  const handbookUnits = input.handbook ? handbookBundleToRetrievalUnitsV3(input.handbook, input.createdAt) : [];
  const brainUnits = (input.brainRecords ?? []).map((record) => retrievalRecordV2ToUnitV3(record, input.brainCitations?.[record.identity]));
  const sourceSnapshotIds = [
    ...(input.handbook ? [`handbook:${input.handbook.bundleHash}`] : []),
    ...(input.brainProjectionHash ? [`brain:${input.brainProjectionHash}`] : []),
  ];
  if (sourceSnapshotIds.length === 0) throw new Error("Retrieval V3 build requires a Handbook or Brain source snapshot.");
  return createKnowledgeRetrievalProjectionV3({ units: [...handbookUnits, ...brainUnits], sourceSnapshotIds, createdAt: input.createdAt });
}
