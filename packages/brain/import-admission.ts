import type { WorkflowSourceAdmission } from "../state-store/workflow-engine.ts";
import type { StateStore } from "../state-store/interface.ts";
import type { CompanyOSArtifact } from "../companyos-builder/types.ts";
import type { CompiledWorkflow } from "../companyos-builder/workflow-types.ts";
import { sha256 } from "../runtime/canonical.ts";
import { validateTranscriptSelectionPolicy, type TranscriptCohort } from "./import-policy.ts";

/** Reviewed Instance binding. It grants neither a Workflow nor a provider read. */
export interface TranscriptImportBinding {
  workflowId: string;
  importId: string;
  cohortId: string;
  policyField: string;
  /** Optional exact processing subset in current Workspace configuration; never allocates new slots. */
  processingField?: string;
  sourceIdentityField: string;
  sourceVersionField: string;
  /** Exact reviewed non-meeting content versions; never a wildcard, channel expansion or transcript slot. */
  nonTranscriptSources?: Array<{ identity: string; version: string; kind: "discussion" | "article" | "idea" | "document" | "media" }>;
}
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-z][a-z0-9_-]{0,62}$/.test(value);
export function parseTranscriptImportBindings(raw: unknown, artifact: CompanyOSArtifact, enabled: readonly string[]): TranscriptImportBinding[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) throw new Error("Transcript import bindings must be a bounded list");
  const seen = new Set<string>();
  return raw.map(item => {
    const fields = ["workflowId", "importId", "policyField", "sourceIdentityField", "sourceVersionField"];
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).filter(key => !["nonTranscriptSources", "processingField"].includes(key)).sort().join(",") !== [...fields, "cohortId"].sort().join(",")
      || fields.some(key => !identifier(item[key])) || typeof item.cohortId !== "string" || !/^[a-f0-9]{64}$/.test(item.cohortId)) throw new Error("Invalid transcript import binding");
    const binding = item as TranscriptImportBinding;
    if (binding.processingField !== undefined && (!identifier(binding.processingField) || binding.processingField === binding.policyField)) throw new Error("Invalid transcript processing field");
    if (binding.nonTranscriptSources !== undefined) {
      const selected = binding.nonTranscriptSources;
      if (!Array.isArray(selected) || selected.length > 100 || selected.some(source => !source || typeof source !== "object"
        || Object.keys(source).sort().join(",") !== "identity,kind,version" || !["discussion", "article", "idea", "document", "media"].includes(source.kind)
        || [source.identity, source.version].some(value => typeof value !== "string" || !value.length || value.length > 1000 || /[\x00-\x1f]/.test(value)))
        || new Set(selected.map(source => source.identity)).size !== selected.length) throw new Error("Invalid exact non-transcript source selection");
    }
    const workflow = artifact.workflows?.find(workflow => workflow.id === binding.workflowId);
    if (!workflow || !enabled.includes(workflow.id) || seen.has(workflow.id)
      || binding.sourceIdentityField === binding.sourceVersionField
      || [binding.sourceIdentityField, binding.sourceVersionField].some(field => ["trigger_id", "run_date", "trigger_instant"].includes(field) || !workflow.instance.fields.includes(field) || !workflow.instance.key.includes(field))) throw new Error("Transcript import binding requires one enabled Workflow and distinct declared source key fields");
    validateTranscriptSelectionPolicy(workflow.config?.value[binding.policyField]);
    if (binding.processingField !== undefined) validateTranscriptProcessingScope(workflow.config?.value[binding.processingField]);
    seen.add(workflow.id);
    return structuredClone(binding);
  });
}

export interface TranscriptProcessingScope {
  max_transcripts: number;
  sources: Array<{ identity: string; version: string }>;
}
/** A reviewed subset can tighten execution without changing immutable admission history. */
export function validateTranscriptProcessingScope(raw: unknown): TranscriptProcessingScope {
  const value = raw as TranscriptProcessingScope;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "max_transcripts,sources"
    || !Number.isSafeInteger(value.max_transcripts) || value.max_transcripts < 1 || value.max_transcripts > 10000
    || !Array.isArray(value.sources) || value.sources.length > value.max_transcripts
    || value.sources.some(source => !source || typeof source !== "object" || Array.isArray(source)
      || Object.keys(source).sort().join(",") !== "identity,version"
      || [source.identity, source.version].some(part => typeof part !== "string" || !part.length || part.length > 1000 || /[\x00-\x1f]/.test(part)))
    || new Set(value.sources.map(source => source.identity)).size !== value.sources.length)
    throw new Error("Invalid bounded exact transcript processing scope");
  return structuredClone(value);
}

/** Read the existing cohort registry before opening any source-version Workflow. Never allocate a slot here. */
export async function transcriptImportOrigin(args: {
  store: StateStore; instanceId: string; workflow: CompiledWorkflow;
  binding: TranscriptImportBinding; fields: Record<string, string>;
}): Promise<{ originKey: string; receipt: WorkflowSourceAdmission }> {
  const { binding, workflow } = args;
  const source = args.fields[binding.sourceIdentityField], version = args.fields[binding.sourceVersionField];
  if ([source, version].some(value => typeof value !== "string" || !value.length || value.length > 1000 || /[\x00-\x1f]/.test(value))) throw new Error("Transcript opening needs an exact bounded source identity and version");
  const inputHash = sha256({ instance_id: args.instanceId, import_id: binding.importId });
  const registry = await args.store.getEffect(`brain-import-cohorts:${inputHash}`);
  if (!registry || registry.status !== "claimed" || (registry.inputHash ?? registry.input_hash) !== inputHash) throw new Error("Transcript import cohort has not been frozen in this Instance");
  const state = registry.evidence as unknown as { version: number; cohorts: TranscriptCohort[] };
  if (!state || state.version !== 1 || !Array.isArray(state.cohorts) || state.cohorts.length > 1000) throw new Error("Invalid retained transcript cohort registry");
  const index = state.cohorts.findIndex(cohort => cohort.id === binding.cohortId);
  if (index < 0) throw new Error("The bound transcript cohort is absent");
  const cohort = state.cohorts[index];
  const policyDigest = sha256(validateTranscriptSelectionPolicy(workflow.config?.value[binding.policyField]));
  if (cohort.policy_digest !== policyDigest) throw new Error("Workspace transcript policy requires a matching frozen cohort activation");
  const selected = state.cohorts.slice(0, index + 1).flatMap(cohort => cohort.admitted);
  if (selected.length !== cohort.cumulative_count || new Set(selected.map(item => item.identity)).size !== selected.length
    || cohort.cumulative_count > cohort.policy.max_transcripts) throw new Error("Retained transcript admissions violate the cohort ceiling");
  const processing = binding.processingField === undefined ? undefined
    : validateTranscriptProcessingScope(workflow.config?.value[binding.processingField]);
  if (processing?.sources.some(source => !selected.some(item => item.identity === source.identity)))
    throw new Error("Transcript processing scope contains an identity outside the frozen cohort");
  if (processing && selected.some(item => item.identity === source)
    && !processing.sources.some(item => item.identity === source && item.version === version))
    throw new Error("Source identity or version is outside the activated transcript processing scope");
  const extra = binding.nonTranscriptSources?.find(item => item.identity === source);
  if (binding.nonTranscriptSources?.some(item => selected.some(transcript => transcript.identity === item.identity))) throw new Error("A transcript cannot be reclassified as a non-transcript source");
  if (!selected.some(item => item.identity === source) && (!extra || extra.version !== version)) throw new Error("Source identity or version is outside the frozen transcript cohort or exact non-transcript selection");
  if (extra) return { originKey: `transcript:${sha256({ import_id: binding.importId, source_identity: source, source_version: version })}`,
    receipt: { kind: "non-transcript-selection", sourceKind: extra.kind, importId: binding.importId, cohortId: cohort.id,
      policyDigest: sha256({ policyDigest, selected: extra }), sourceIdentity: source, sourceVersion: version } };
  // The initial discovery version may be metadata-only. The Workflow must read
  // the exact content version from authorized Records before any model step.
  // Policy/cohort/Artifact/request changes never reset a completed source version.
  return { originKey: `transcript:${sha256({ import_id: binding.importId, source_identity: source, source_version: version })}`,
    receipt: { kind: "transcript-cohort", importId: binding.importId, cohortId: cohort.id,
      policyDigest, sourceIdentity: source, sourceVersion: version } };
}
