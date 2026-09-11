import type { CapabilityCallContext, Connector } from "../capabilities/contracts.ts";
import { EVIDENCE_QUERY_INPUT, type EvidenceQuery, type EvidenceScope } from "../capabilities/evidence.ts";
import type { CompanyOSArtifact } from "../companyos-builder/types.ts";
import type { CompanyRecordsService } from "../records/service.ts";
import { sha256 } from "../runtime/canonical.ts";
import { workflowEffectKey } from "../runtime/workflow-engine/guard.ts";
import type { StateStore } from "../state-store/interface.ts";
import type { WorkflowExecutionStore } from "../state-store/workflow-engine.ts";
import { validateJsonSchemaValue } from "../capabilities/validation.ts";
import type { BuilderJobStore } from "../state-store/builder-jobs.ts";
import type { ReleaseRun } from "../state-store/release-runs.ts";
import { compareRecordInstants } from "../records/instant.ts";

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 100
  && new Set(value).size === value.length && value.every(v => typeof v === "string" && v.length > 0 && v.length <= 255);
export function parseEvidenceScopes(raw: unknown): EvidenceScope[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 100) throw new Error("Evidence requires explicit read scopes");
  const keys = ["agent_id", "workflow_id", "read_groups", "workflow_ids", "source_ids", "paths", "max_history_days"];
  const scopes = raw.map(value => {
    if (!value || typeof value !== "object" || Object.keys(value).some(key => !keys.includes(key))
      || typeof value.agent_id !== "string" || !value.agent_id || (value.workflow_id !== null && (typeof value.workflow_id !== "string" || !value.workflow_id))
      || !strings(value.read_groups) || !value.read_groups.length || !strings(value.workflow_ids) || !strings(value.source_ids) || !strings(value.paths)
      || !Number.isInteger(value.max_history_days) || value.max_history_days < 1 || value.max_history_days > 90) throw new Error("Invalid evidence read scope");
    return structuredClone(value) as EvidenceScope;
  });
  if (new Set(scopes.map(scope => JSON.stringify([scope.agent_id, scope.workflow_id]))).size !== scopes.length) throw new Error("Ambiguous evidence read scopes");
  return scopes;
}

interface EvidenceDependencies {
  artifact: CompanyOSArtifact; scopes: EvidenceScope[]; workflows: WorkflowExecutionStore;
  control: StateStore; records?: CompanyRecordsService; now?: () => Date;
  builders?: Pick<BuilderJobStore, "listForRequester">;
  releases?: (instanceId: string, candidateId: string, cutoff: string) => Promise<ReleaseRun[]>;
}

/** Source-specific physical reads with one bounded contract; no domain event interpretation. */
export class HistoricalEvidenceConnector implements Connector {
  readonly id = "oregano/historical-evidence";
  readonly version = "1.0.0";
  readonly capabilities = ["evidence.query"] as const;
  readonly #args: EvidenceDependencies;
  constructor(args: EvidenceDependencies) {
    this.#args = { ...args, scopes: parseEvidenceScopes(args.scopes) };
    for (const scope of this.#args.scopes) {
      const agent = args.artifact.agents.find(agent => agent.id === scope.agent_id);
      if (!agent || scope.paths.some(path => !Object.hasOwn(agent.materials, path))) throw new Error("Evidence context is outside compiled Agent read scope");
      if (scope.workflow_id !== null && !args.artifact.workflows?.some(workflow => workflow.id === scope.workflow_id && workflow.agentId === scope.agent_id)) throw new Error("Evidence scope has no owning workflow");
      if (scope.workflow_ids.some(id => !args.artifact.workflows?.some(workflow => workflow.id === id))) throw new Error("Evidence scope names an unknown workflow");
    }
  }
  async invoke(capability: string, raw: unknown, context: CapabilityCallContext) {
    const { artifact, workflows, control, records } = this.#args;
    const now = this.#args.now?.() ?? new Date();
    if (capability !== "evidence.query" || context.instanceId !== artifact.instance.id || context.subject?.status !== "active") throw new Error("Evidence access denied");
    const scope = this.#args.scopes.find(scope => scope.agent_id === context.agentId && scope.workflow_id === (context.workflow?.id ?? null));
    if (!scope || !context.subject.groupIds.some(group => scope.read_groups.includes(group))) throw new Error("Evidence access denied by current invocation scope");
    if (validateJsonSchemaValue(EVIDENCE_QUERY_INPUT, raw).length) throw new Error("Invalid bounded evidence query");
    const input = raw as EvidenceQuery, limit = input.limit ?? 50;
    const cutoff = Date.parse(context.workflow?.cutoff ?? now.toISOString());
    if (!Number.isFinite(cutoff) || Date.parse(input.from) >= Date.parse(input.to) || Date.parse(input.to) > Math.min(cutoff, now.getTime())
      || Date.parse(input.from) < cutoff - scope.max_history_days * 86_400_000) throw new Error("Evidence query exceeds the trusted invocation time window");
    const allowed = input.kind === "workflows" ? scope.workflow_ids : input.kind === "records" ? scope.source_ids : scope.paths;
    if (input.references.some(id => !allowed.includes(id))) throw new Error("Evidence reference is outside the current read scope");
    const items: Record<string, unknown>[] = [], limitations: string[] = [];
    let complete = true;
    const gap = (reason: string) => { complete = false; if (!limitations.includes(reason)) limitations.push(reason); };
    if (input.kind === "context") {
      const agent = artifact.agents.find(agent => agent.id === context.agentId)!;
      for (const path of input.references) {
        const content = agent.materials[path];
        if (content === undefined) { gap("context-unavailable"); continue; }
        items.push({ id: path, kind: "artifact-material", occurred_at: null, observed_at: now.toISOString(),
          artifact_hash: artifact.artifactHash, workspace_commit: artifact.provenance.workspaceCommit, digest: sha256(content), content });
      }
    } else if (input.kind === "records") {
      if (!records) gap("record-history-adapter-unavailable");
      else for (const sourceId of input.references) {
        const versions = await records.history({ sourceId, from: input.from, to: input.to, limit: limit + 1,
          subject: { principal_id: context.subject.principalId, status: context.subject.status, roles: [], group_ids: context.subject.groupIds } });
        for (const value of versions) items.push({ id: value.version_id, kind: "record-observation", occurred_at: null,
          observed_at: value.observed_at, source_id: value.source_id, object_id: value.object_id, digest: value.digest,
          deleted: value.deleted, values: value.values, source_receipt: value.source_receipt });
        // Retained snapshots can miss transitions between observations, including a direct entry and exit.
        gap("retained-observations-do-not-prove-complete-provider-event-history");
      }
    } else {
      const jobs = input.include_linked_builds ? await this.#args.builders?.listForRequester(artifact.instance.id, context.subject.principalId) : [];
      if (jobs?.length === 30) gap("builder-history-truncated");
      const runs = await workflows.history({ instanceId: artifact.instance.id, workflowIds: input.references,
        from: input.from, to: input.to, excludeRunId: context.runId, limit: limit + 1 });
      for (const run of runs) {
        if (run.instanceId !== artifact.instance.id || !input.references.includes(run.workflowId) || run.runId === context.runId
          || Date.parse(run.trigger.instant) <= Date.parse(input.from) || Date.parse(run.trigger.instant) > Date.parse(input.to)) throw new Error("Workflow history escaped its scope");
        const pinned = await workflows.getArtifact(run.artifactHash);
        const manifest = pinned?.workflows?.find(workflow => workflow.id === run.workflowId);
        if (!pinned || pinned.instance.id !== artifact.instance.id || manifest?.manifestHash !== run.manifestHash) { gap("historical-artifact-unavailable"); continue; }
        const steps = Object.fromEntries(Object.entries(run.state.steps).filter(([id, step]) => (!input.step_ids || input.step_ids.includes(id)) && Date.parse(step.startedAt) <= Date.parse(input.to))
          .map(([id, step]) => [id, !step.completedAt || Date.parse(step.completedAt) > Date.parse(input.to)
            ? { status: "incomplete-at-cutoff", startedAt: step.startedAt } : step]));
        const decisions = Object.fromEntries(Object.entries(run.state.decisions).filter(([, decision]) => decision.decidedAt && Date.parse(decision.decidedAt) <= Date.parse(input.to)));
        const effects: Record<string, unknown>[] = [];
        for (const step of manifest.steps) {
          if (!step.tool || !["message", "effect", "decision"].includes(step.kind) || step.forEach || !run.state.steps[step.id]
            || (input.step_ids && !input.step_ids.includes(step.id))) continue;
          const key = workflowEffectKey(pinned, { workflowId: run.workflowId, runId: run.runId, stepId: step.id });
          const effect = await control.getEffect(key);
          if (effect) effects.push({ id: key, step_id: step.id, status: effect.status, evidence: effect.evidence ?? null });
        }
        const events = await control.listEvents(run.runId, 201);
        if (events.length > 200) gap("run-event-history-truncated");
        const capturedFeedback = events.slice(0, 200).filter(event => event.event === "workflow.feedback.received")
          .map(event => event.evidence as Record<string, unknown>).filter(value => value && typeof value.occurred_at === "string" && compareRecordInstants(value.occurred_at, input.to) <= 0);
        const feedback = [...new Map(capturedFeedback.map(value => [value.event_id, value])).values()];
        if (feedback.some(value => value.truncated)) gap("feedback-text-truncated");
        if (Date.parse(run.updatedAt) > Date.parse(input.to)) gap("run-state-updated-after-cutoff");
        const outputRefs = Object.fromEntries(Object.entries(steps).filter(([, step]) => "output" in step)
          .map(([id, step]) => [id, { reference: `workflow-output:${run.runId}#${id}`, digest: sha256((step as { output: unknown }).output) }]));
        const linkedJobs = (jobs ?? []).filter(job => job.instanceId === artifact.instance.id && job.requesterPrincipal === context.subject!.principalId
          && Date.parse(job.createdAt) <= Date.parse(input.to) && Object.values(outputRefs).some(ref => job.brief?.brief.constraints.includes(ref.reference)));
        const builds = [];
        for (const job of linkedJobs) {
          const releases = await this.#args.releases?.(artifact.instance.id, job.jobId, input.to);
          if (releases?.length === 11) gap("release-history-truncated");
          if (releases?.some(release => release.candidate.instanceId !== artifact.instance.id || release.candidate.id !== job.jobId
            || Date.parse(release.updatedAt) > Date.parse(input.to))) throw new Error("Linked release escaped its scope");
          builds.push({ id: job.jobId, created_at: job.createdAt, observed_at: job.updatedAt,
            state: Date.parse(job.updatedAt) > Date.parse(input.to) ? "unknown-at-cutoff" : job.state,
            source_refs: job.brief!.brief.constraints.filter(ref => Object.values(outputRefs).some(value => value.reference === ref)),
            proposed_behavior: job.brief!.brief.proposedBehavior, acceptance_criteria: job.brief!.brief.acceptanceCriteria,
            constraints: job.brief!.brief.constraints,
            releases: releases?.slice(0, 10).map(release => ({ id: release.id, stage: release.stage, accepted_by: release.acceptedBy,
              accepted_at: release.acceptedAt, observed_at: release.updatedAt, candidate_digest: release.candidateDigest,
              deployment: release.deployment ?? null, verification: release.verification ?? null })) ?? null });
        }
        if (input.include_linked_builds && !jobs) gap("linked-builder-reader-unavailable");
        items.push({ id: run.runId, kind: "workflow-run", workflow_id: run.workflowId, occurred_at: run.trigger.instant,
          observed_at: run.updatedAt, artifact_hash: run.artifactHash, manifest_hash: run.manifestHash, fields: run.fields,
          status: Date.parse(run.updatedAt) > Date.parse(input.to) ? "unknown-at-cutoff" : run.state.status,
          blocked: run.state.blocked ?? null, steps, output_refs: outputRefs, decisions, effects, feedback, builds });
      }
      limitations.push("retained-run-history-only; missing openings and uncaptured feedback are not proved absent");
    }
    if (items.length > limit) gap("result-limit");
    const selected: Record<string, unknown>[] = []; let size = 0;
    for (const item of items.slice(0, limit)) {
      const length = JSON.stringify(item).length;
      if (size + length > 120_000) { gap("result-byte-limit"); break; }
      size += length; selected.push(item);
    }
    const output = { items: selected, artifact_hash: artifact.artifactHash,
      coverage: { from: input.from, to: input.to, observed_at: now.toISOString(), complete, limitations } };
    return { output, evidence: { artifact_hash: artifact.artifactHash, query_digest: sha256(input), result_digest: sha256(output),
      coverage: output.coverage, access_decision: { allowed: true, principal: context.subject.principalId, scope_digest: sha256(scope) } } };
  }
}
