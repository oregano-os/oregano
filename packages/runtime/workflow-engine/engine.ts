import { validateCollection, validateCollectionCandidate } from "./collection.ts";
import { randomUUID } from "node:crypto";
import type { Connector, JsonValue } from "../../capabilities/contracts.ts";
import type { CompanyOSArtifact } from "../../companyos-builder/types.ts";
import type { CompiledWorkflow, CompiledWorkflowStep, WorkflowSchedule } from "../../companyos-builder/workflow-types.ts";
import type { StateStore } from "../../state-store/interface.ts";
import { findByCanonicalPrincipal, isHumanRosterMember, type RosterMember } from "../../state-store/roster.ts";
import type { ClaimedDurableTimer } from "../../state-store/durable-timers.ts";
import type { WorkflowAssignment, WorkflowConversation, WorkflowExecutionStore, WorkflowMutableState, WorkflowRun, WorkflowRunIdentity } from "../../state-store/workflow-engine.ts";
import { CompanyOSRuntime } from "../companyos-runtime.ts";
import { DurableTimerService } from "../durable-timers.ts";
import { canonicalJson, jsonDigest, sha256 } from "../canonical.ts";
import { localDateAt } from "../local-time.ts";
import { workflowBusinessDeadline, workflowDeliveryInstant, workflowNextTrigger, workflowPreviousTrigger } from "./calendar.ts";
import { authorizeWorkflowDecisionPrincipal, workflowDecisionId, workflowDecisionMemberAllowed } from "./decision-notice.ts";
import { assertWorkflowArtifact, workflowEffectKey, workflowExecutionStepId, workflowToolInput } from "./guard.ts";
import { assertWorkflowOutput, resolveWorkflowValue, workflowItems, workflowOpeningFields } from "./references.ts";
import { workflowContext, WorkflowLeaseLostError, WorkflowRunContextReader, WorkflowReviewContextReader } from "./readers.ts";
import { workflowAssignmentKey, workflowPublicationKey, workflowInstant, workflowOriginDigest, workflowRunId } from "./state-validation.ts";
import { workflowEffectReview } from "./effect-review.ts";
import { prepareWorkflowReviewDelivery, workflowReviewNoticeInput, workflowReviewStepId, workflowReviewEffectKey } from "./review-notice.ts";
import { verifyCompletedWorkflow } from "./verification.ts";
import type { WorkflowVerificationRequirement } from "./verification-requirements.ts";
import { prepareDecisionRecovery, type VerifyPublicationNotSent } from "./decision-recovery.ts";

export interface WorkflowEngineOptions {
  artifact: CompanyOSArtifact;
  store: WorkflowExecutionStore;
  control: StateStore;
  timers: DurableTimerService;
  /** Exact enabled processes and authenticated operator principals are Instance authority. */
  enabledWorkflowIds: readonly string[];
  operatorPrincipals: readonly string[];
  currentRoster: () => Promise<RosterMember[]>;
  connectors: (artifact: CompanyOSArtifact) => Promise<Connector[]>;
  /** Qualify every destination before the first message in a prepared collection. */
  qualifyMessageDestinations: (artifact: CompanyOSArtifact, inputs: readonly JsonValue[]) => Promise<JsonValue>;
  /** Qualified Connector/Instance resolution; Core does not parse provider-specific thread strings. */
  conversationForReceipt: (args: { artifact: CompanyOSArtifact; destinationBinding: string; output: JsonValue }) => Promise<WorkflowConversation>;
  clock?: () => string;
  assignmentLifetimeMs?: number;
  verifyPublicationNotSent?: VerifyPublicationNotSent;
}

const terminal = (run: WorkflowRun): boolean => ["done", "cancelled", "failed"].includes(run.state.status);
const timerId = (run: WorkflowRunIdentity, stepId: string, kind: string, instant: string): string => sha256({ instanceId: run.instanceId, workflowId: run.workflowId, runId: run.runId, stepId, kind, instant });
const opaqueId = (value: string): void => { if (typeof value !== "string" || !value.length || value.length > 255 || /[\u0000-\u001f]/.test(value)) throw new Error("Workflow event identity must be bounded and explicit"); };

/** Bounded forward-only execution. Business calculations remain isolated Company Tools. */
export class WorkflowEngine {
  readonly #options: WorkflowEngineOptions;
  readonly #artifact: CompanyOSArtifact;
  constructor(options: WorkflowEngineOptions) {
    this.#artifact = structuredClone(options.artifact); assertWorkflowArtifact(this.#artifact);
    if (options.timers.instanceId !== options.artifact.instance.id) throw new Error("Workflow timers belong to another Instance");
    this.#options = { ...options, enabledWorkflowIds: [...options.enabledWorkflowIds], operatorPrincipals: [...options.operatorPrincipals] };
    const ttl = options.assignmentLifetimeMs ?? 30 * 86_400_000;
    if (!Number.isSafeInteger(ttl) || ttl < 60_000 || ttl > 3660 * 86_400_000) throw new Error("Workflow conversation lifetime is outside the supported bound");
  }
  #now(): string { const now = this.#options.clock?.() ?? new Date().toISOString(); workflowInstant(now); return now; }
  #enabled(workflowId: string): void {
    if (!this.#options.enabledWorkflowIds.includes(workflowId)) throw new Error("Workflow execution is not enabled in this Instance");
  }
  async #operator(principal: string): Promise<void> {
    const member = findByCanonicalPrincipal(await this.#options.currentRoster(), principal);
    if (!this.#options.operatorPrincipals.includes(principal) || !member?.id || !isHumanRosterMember(member) || !/^(active|aktiv)$/i.test(member.status)) throw new Error("Workflow operation requires an authenticated active authorized human operator");
  }
  async #definition(run: WorkflowRun): Promise<{ artifact: CompanyOSArtifact; workflow: CompiledWorkflow; step: CompiledWorkflowStep }> {
    const artifact = await this.#options.store.getArtifact(run.artifactHash);
    const workflow = artifact?.workflows?.find((workflow) => workflow.id === run.workflowId);
    const step = workflow?.steps.find((step) => step.id === run.state.cursor);
    if (!artifact || !workflow || !step || workflow.manifestHash !== run.manifestHash) throw new Error("Workflow historical Artifact, manifest or step is unavailable");
    return { artifact, workflow, step };
  }
  #calendar(workflow: CompiledWorkflow, path?: string): WorkflowSchedule | undefined {
    if (path) {
      const schedule = workflow.schedules.find((schedule) => schedule.path === path);
      if (!schedule) throw new Error("Workflow calendar is missing from the historical Artifact");
      return schedule.declaration;
    }
    return workflow.schedules.find((schedule) => workflow.trigger.kind === "schedule" && schedule.path === workflow.trigger.schedulePath)?.declaration
      ?? workflow.schedules[0]?.declaration;
  }
  #finish(state: WorkflowMutableState, step: CompiledWorkflowStep, output: JsonValue, now: string, target = step.next[0]!): void {
    assertWorkflowOutput(step, output);
    const prior = state.steps[step.id];
    state.steps[step.id] = { ...prior, status: "succeeded", startedAt: prior?.startedAt ?? now, completedAt: now, output };
    state.cursor = target === "end" ? null : target; state.status = state.cursor ? "running" : "done";
    delete state.wait; delete state.blocked;
  }
  async #save(run: WorkflowRun, state: WorkflowMutableState, name: string, evidence?: JsonValue, assignments?: WorkflowAssignment[], principal?: string): Promise<WorkflowRun> {
    const saved = await this.#options.store.commit({ instanceId: run.instanceId, runId: run.runId, expectedRevision: run.revision,
      leaseToken: run.lease!.token, now: this.#now(), state, event: { name, stepId: run.state.cursor ?? "end", evidence, ...(principal ? { principal } : {}) }, ...(assignments ? { assignments } : {}) });
    if (!saved) throw new WorkflowLeaseLostError();
    return saved;
  }
  async #ensureTimers(run: WorkflowRun): Promise<void> {
    if (terminal(run)) return;
    const waits = [...(run.state.wait ? [run.state.wait] : []), ...Object.values(run.state.decisions).filter((decision) => decision.status === "pending").map((decision) => ({
      stepId: decision.stepId, kind: "decision" as const, dueAt: decision.expiresAt, timerId: timerId(run, decision.stepId, "decision", decision.expiresAt),
    }))];
    for (const wait of waits) await this.#options.timers.schedule({ timerId: wait.timerId, timerKind: "workflow", dueAt: wait.dueAt, idempotencyKey: wait.timerId,
      payload: { run_id: run.runId, workflow_id: run.workflowId, step_id: wait.stepId, kind: wait.kind, instant: wait.dueAt, artifact_hash: run.artifactHash } });
  }

  async openOperator(args: { workflowId: string; requestId: string; principal: string; fields: Record<string, string>; triggerVariant?: number; instant?: string; previousInstant?: string; params?: Record<string, JsonValue> }): Promise<WorkflowRun> {
    await this.#operator(args.principal); this.#enabled(args.workflowId); opaqueId(args.requestId);
    if (args.triggerVariant !== undefined) {
      if (!Number.isSafeInteger(args.triggerVariant) || args.triggerVariant < 0 || args.triggerVariant > 999 || args.params !== undefined) throw new Error("Invalid or conflicting workflow trigger variant");
      const workflow = this.#artifact.workflows?.find((candidate) => candidate.id === args.workflowId);
      if (!workflow || workflow.trigger.kind !== "schedule") throw new Error("Workflow trigger variant requires a declared schedule");
      const triggerId = workflow.trigger.id;
      const variant = this.#calendar(workflow)?.triggers.filter((trigger) => trigger.id === triggerId)[args.triggerVariant];
      if (!variant) throw new Error("Workflow trigger variant is absent from the retained calendar");
      args = { ...args, params: structuredClone(variant.params ?? {}) };
    }
    return this.#open(args, `operator:${sha256(args.requestId)}`);
  }

  /** Scheduler supplies exact reviewed opening fields; Core never invents business period identifiers. */
  async openScheduled(args: { workflowId: string; principal: string; fields: Record<string, string>; instant: string }): Promise<WorkflowRun> {
    await this.#operator(args.principal); this.#enabled(args.workflowId);
    if (["trigger_id", "run_date", "trigger_instant"].some(field => Object.hasOwn(args.fields, field))) throw new Error("Opening fields cannot override trusted trigger identity");
    const workflow = this.#artifact.workflows?.find((candidate) => candidate.id === args.workflowId);
    if (!workflow || workflow.trigger.kind !== "schedule") throw new Error("Workflow has no declared schedule");
    const calendar = this.#calendar(workflow)!;
    if (calendar.activation !== "active") throw new Error("Workflow schedule activation is blocked");
    const occurrence = workflowNextTrigger(calendar, workflow.trigger.id, args.instant);
    if (occurrence.instant !== args.instant) throw new Error("Opening is not an exact declared schedule occurrence");
    const fields = { ...args.fields, trigger_id: workflow.trigger.id, run_date: occurrence.localDate,
      ...(workflow.instance.fields.includes("trigger_instant") ? { trigger_instant: occurrence.instant } : {}) };
    if (workflow.instance.key.some((key) => !fields[key as keyof typeof fields])) throw new Error("Scheduled opening is missing a declared instance key field");
    const originKey = `schedule:${sha256(workflow.instance.key.map((key) => [key, fields[key as keyof typeof fields]]))}`;
    return this.#open({ ...args, params: occurrence.params }, originKey);
  }

  async #open(args: { workflowId: string; principal: string; fields: Record<string, string>; instant?: string; previousInstant?: string; params?: Record<string, JsonValue> }, originKey: string): Promise<WorkflowRun> {
    const workflow = this.#artifact.workflows?.find((workflow) => workflow.id === args.workflowId);
    if (!workflow) throw new Error("Unknown workflow");
    const now = this.#now(), instant = args.instant ?? now; workflowInstant(instant);
    const calendar = this.#calendar(workflow);
    if (["trigger_id", "run_date", "trigger_instant"].some(field => Object.hasOwn(args.fields, field))) throw new Error("Opening fields cannot override trusted trigger identity");
    const fields = { trigger_id: workflow.trigger.kind === "schedule" ? workflow.trigger.id : "operator", run_date: localDateAt(instant, calendar?.timezone ?? "UTC"),
      ...(workflow.instance.fields.includes("trigger_instant") ? { trigger_instant: instant } : {}), ...structuredClone(args.fields) };
    const missing = workflowOpeningFields(workflow).filter((field) => !fields[field as keyof typeof fields]);
    if (missing.length) throw new Error(`Workflow opening requires reviewed fields: ${missing.join(", ")}`);
    const trigger = { id: fields.trigger_id, instant, params: structuredClone(args.params ?? {}) } as WorkflowRunIdentity["trigger"];
    if (args.previousInstant) { workflowInstant(args.previousInstant); trigger.previous_instant = args.previousInstant; }
    else if (JSON.stringify(workflow.steps).includes('"$trigger.previous_instant"')) {
      if (!calendar || workflow.trigger.kind !== "schedule") throw new Error("Workflow requires an explicit previous trigger instant");
      trigger.previous_instant = workflowPreviousTrigger(calendar, workflow.trigger.id, instant).instant;
    }
    if (trigger.previous_instant && trigger.previous_instant >= instant) throw new Error("Previous trigger must precede this opening");
    const identity: WorkflowRunIdentity = { instanceId: this.#artifact.instance.id, workflowId: workflow.id, runId: "", artifactHash: this.#artifact.artifactHash,
      manifestHash: workflow.manifestHash, originKey, originDigest: "", subjectPrincipal: args.principal,
      trigger, fields, createdAt: now };
    identity.runId = workflowRunId(identity); identity.originDigest = workflowOriginDigest(identity);
    const prior = await this.#options.store.findOrigin(identity.instanceId, identity.workflowId, identity.originKey);
    if (prior) {
      // A request without an explicit instant retains its original opening time on retry.
      if (!args.instant) {
        identity.trigger.instant = prior.trigger.instant; identity.fields.run_date = prior.fields.run_date!;
        if (workflow.instance.fields.includes("trigger_instant")) identity.fields.trigger_instant = prior.trigger.instant;
        if (!args.previousInstant) identity.trigger.previous_instant = prior.trigger.previous_instant;
        identity.originDigest = workflowOriginDigest(identity);
      }
      if (prior.originDigest !== identity.originDigest) throw new Error("Workflow opening identity conflicts with changed input");
      return prior;
    }
    const agent = this.#artifact.agents.find((agent) => agent.id === workflow.agentId)!;
    await this.#options.store.putArtifact(this.#artifact);
    return this.#options.store.create({ identity, state: { status: "running", cursor: workflow.entry, logicalInstant: instant, steps: {}, decisions: {} },
      meta: { runId: identity.runId, workflow: workflow.id, workflowVersion: String(workflow.version), companyCommit: this.#artifact.provenance.workspaceCommit,
        companySnapshotHash: this.#artifact.provenance.workspaceHash, agentDefinitionHash: sha256({ instructions: agent.instructions, materials: agent.materials }), agentAdapter: "companyos-workflow-engine", adapterVersion: "1" } });
  }

  async step(runId: string): Promise<WorkflowRun | undefined> {
    const store = this.#options.store, instanceId = this.#artifact.instance.id;
    const existing = await store.read(instanceId, runId);
    if (!existing || terminal(existing)) return existing;
    if (existing.state.blocked) return this.#deliverReview(existing);
    this.#enabled(existing.workflowId); await this.#ensureTimers(existing);
    if (existing.state.status === "waiting") return existing;
    const now = this.#now();
    const run = await store.claim({ instanceId, runId, owner: "workflow-worker", token: randomUUID(), now, expiresAt: new Date(Date.parse(now) + 300_000).toISOString() });
    if (!run) return store.read(instanceId, runId);
    try {
      const { artifact, workflow, step } = await this.#definition(run);
      const state = structuredClone(run.state), roster = await this.#options.currentRoster(), ctx = workflowContext(run, roster);
      const subject = findByCanonicalPrincipal(roster, run.subjectPrincipal);
      if (!subject || !/^(active|aktiv)$/i.test(subject.status)) throw new Error("Workflow initiating subject is no longer active");
      if (run.trigger.instant > now && !Object.keys(state.steps).length) {
        state.status = "waiting"; state.wait = { stepId: step.id, kind: "start", dueAt: run.trigger.instant, timerId: timerId(run, step.id, "start", run.trigger.instant) };
        return await this.#save(run, state, "workflow.awaiting-start");
      }
      if (step.route) {
        const outcome = resolveWorkflowValue(step.route.on, workflow, ctx);
        const target = step.route.targets[String(outcome)];
        if (!target) throw new Error("Workflow route has no declared target for its actual outcome");
        this.#finish(state, step, { outcome }, now, target);
        return await this.#save(run, state, "workflow.routed", { outcome, target });
      }
      if (step.start) {
        const target = artifact.workflows?.find((candidate) => candidate.id === step.start!.workflowId);
        if (!target || target.trigger.kind !== "operator" || target.steps.some((candidate) => candidate.start)) throw new Error("Workflow start target must be a leaf operator workflow");
        const items = step.forEach ? workflowItems(step, workflow, ctx) : [{ key: "single", value: null }];
        const prepared = items.map((item) => {
          const fields = resolveWorkflowValue(step.start!.fields, workflow, { ...ctx, item: item.value }) as Record<string, string>;
          if (Object.values(fields).some((value) => typeof value !== "string" || !value) || workflowOpeningFields(target).some((field) => !["trigger_id", "run_date", "trigger_instant"].includes(field) && !fields[field])
            || Object.keys(fields).some((field) => !target.instance.fields.includes(field) || ["trigger_id", "run_date", "trigger_instant"].includes(field))) throw new Error("Child opening fields do not match the target contract");
          return { ...item, fields };
        });
        const prior = state.steps[step.id] ?? { status: "running" as const, startedAt: now, items: {} };
        state.steps[step.id] = prior; prior.items ??= {};
        const item = prepared.find((item) => !prior.items![jsonDigest(item.key)]);
        if (item) {
          const childEngine = new WorkflowEngine({ ...this.#options, artifact });
          // Semantic child identity survives repeated intake ticks and parent retries.
          const requestId = "workflow-start:" + sha256({ workflow: target.id, fields: item.fields });
          const child = await childEngine.openOperator({ workflowId: target.id, requestId, principal: run.subjectPrincipal, fields: item.fields });
          prior.items[jsonDigest(item.key)] = { key: item.key, output: { run_id: child.runId } };
          return await this.#save(run, state, "workflow.child-opened", { child_run_id: child.runId });
        }
        this.#finish(state, step, step.forEach ? { items: prepared.map((item) => prior.items![jsonDigest(item.key)]!) } : prior.items[jsonDigest("single")]!.output, now);
        return await this.#save(run, state, "workflow.children-opened");
      }
      if (step.collect) {
        const dueAt = workflowBusinessDeadline(this.#calendar(workflow, step.collect.calendarPath)!, now, step.collect.timeoutBusinessDays);
        state.steps[step.id] = { status: "waiting", startedAt: now };
        state.status = "waiting"; state.wait = { stepId: step.id, kind: "step", dueAt, timerId: timerId(run, step.id, "step", dueAt) };
        return await this.#save(run, state, "workflow.collecting", { due_at: dueAt });
      }
      if (step.wait) {
        const dueAt = "triggerId" in step.wait
          ? workflowNextTrigger(this.#calendar(workflow, step.wait.schedulePath)!, step.wait.triggerId, state.logicalInstant).instant
          : workflowBusinessDeadline(this.#calendar(workflow, step.wait.calendarPath)!, now, step.wait.businessDays);
        state.steps[step.id] = { status: "waiting", startedAt: now };
        state.status = "waiting"; state.wait = { stepId: step.id, kind: "step", dueAt, timerId: timerId(run, step.id, "step", dueAt) };
        return await this.#save(run, state, "workflow.waiting", { due_at: dueAt });
      }
      if (step.decision) return await this.#decisionStep(run, artifact, workflow, step, roster);
      const calendar = this.#calendar(workflow);
      if (step.message && calendar) {
        const dueAt = workflowDeliveryInstant(calendar, now);
        if (dueAt !== now) {
          state.status = "waiting"; state.wait = { stepId: step.id, kind: "delivery", dueAt, timerId: timerId(run, step.id, "delivery", dueAt) };
          return await this.#save(run, state, "workflow.awaiting-delivery-window", { due_at: dueAt });
        }
      }
      const items = step.forEach ? workflowItems(step, workflow, ctx) : undefined;
      const inputDigest = jsonDigest(items ?? workflowToolInput(artifact, workflow, step, ctx));
      if (!state.steps[step.id]?.inputDigest) {
        const qualification = step.message ? await this.#options.qualifyMessageDestinations(artifact,
          items ? items.map((item) => workflowToolInput(artifact, workflow, step, { ...ctx, item: item.value })) : [workflowToolInput(artifact, workflow, step, ctx)]) : undefined;
        state.steps[step.id] = { status: "running", startedAt: now, inputDigest, ...(items ? { items: {} } : {}), ...(qualification === undefined ? {} : { evidence: { destination_qualification: qualification } }) };
        return await this.#save(run, state, "workflow.step-prepared", { input_digest: inputDigest });
      }
      if (state.steps[step.id]!.inputDigest !== inputDigest) throw new Error("Prepared workflow input changed before dispatch");
      const item = items?.find((item) => !Object.hasOwn(state.steps[step.id]!.items ?? {}, jsonDigest(item.key)));
      if (items && !item) {
        const output = { items: items.map((item) => state.steps[step.id]!.items![jsonDigest(item.key)]!) };
        this.#finish(state, step, output, now); return await this.#save(run, state, "workflow.foreach-completed");
      }
      const reader = new WorkflowRunContextReader({ store, instanceId, runId, leaseToken: run.lease!.token, roster: this.#options.currentRoster, clock: () => this.#now(), ...(item ? { itemKey: item.key } : {}) });
      const current = await reader.read(), input = workflowToolInput(artifact, workflow, step, current);
      const result = await this.#executeTool(run, artifact, workflow, step, reader, input, item?.key);
      const assignments = await this.#assignments(run, artifact, step, input, result.output, item?.key);
      if (items && item) state.steps[step.id]!.items![jsonDigest(item.key)] = { key: item.key, output: result.output };
      else this.#finish(state, step, result.output, this.#now());
      return await this.#save(run, state, item ? "workflow.item-completed" : "workflow.step-completed", { output_digest: jsonDigest(result.output), ...(item ? { item_key: item.key } : {}) }, assignments);
    } catch (error) {
      if (error instanceof WorkflowLeaseLostError) return store.read(instanceId, runId);
      const state = structuredClone(run.state), message = error instanceof Error ? error.message : String(error);
      state.status = "waiting"; state.blocked = { stepId: state.cursor!, code: /receipt|reconciliation|review|outcome/i.test(message) ? "effect-needs-review" : /Output of/.test(message) ? "required-output-missing" : "step-failed", errorDigest: sha256(message) };
      if (state.steps[state.cursor!]?.status !== "succeeded") state.steps[state.cursor!] = { ...state.steps[state.cursor!], status: "failed", startedAt: state.steps[state.cursor!]?.startedAt ?? this.#now() };
      const saved = await store.commit({ instanceId, runId, expectedRevision: run.revision, leaseToken: run.lease!.token, now: this.#now(), state,
        event: { name: "workflow.blocked", stepId: state.cursor!, evidence: { code: state.blocked.code, error_digest: state.blocked.errorDigest } } });
      return saved ?? store.read(instanceId, runId);
    }
  }

  async #executeTool(run: WorkflowRun, artifact: CompanyOSArtifact, workflow: CompiledWorkflow, step: CompiledWorkflowStep, reader: WorkflowRunContextReader, input: JsonValue, itemKey?: string | number): Promise<{ output: JsonValue }> {
    const runtime = new CompanyOSRuntime({ artifact, state: this.#options.control, connectors: await this.#options.connectors(artifact), workflowContext: reader });
    const request = { runId: run.runId, stepId: workflowExecutionStepId(step.id, itemKey), agentId: workflow.agentId, grantId: step.tool!.grantId, input, subjectPrincipal: run.subjectPrincipal };
    if (Number(step.maxRisk.slice(1)) >= 3 && !await this.#options.control.approvalRequestExists(run.runId, request.stepId, step.tool!.runtimeId, jsonDigest(input))) {
      const deadlines = step.requiresDecisions.map((requirement) => run.state.decisions[requirement.stepId]!.expiresAt).sort();
      await runtime.requestApproval(request, { expiresAt: new Date(deadlines[0]!) });
    }
    const result = await runtime.execute(request);
    if (!result || typeof result !== "object" || !Object.hasOwn(result, "output")) throw new Error("Workflow Tool has no verified outcome; effect reconciliation or approval review is required");
    return result as { output: JsonValue };
  }

  async #assignments(run: WorkflowRun, artifact: CompanyOSArtifact, step: CompiledWorkflowStep, input: JsonValue, output: JsonValue, itemKey?: string | number): Promise<WorkflowAssignment[]> {
    if (!step.message && !step.decision) return [];
    const destination = (input as Record<string, JsonValue>).destination_binding;
    if (typeof destination !== "string" || (output as Record<string, JsonValue>)?.destination_binding !== destination) throw new Error("Publication receipt differs from its requested destination");
    if (Object.hasOwn(input as object, "thread_reference")) {
      if ((output as Record<string, JsonValue>)?.thread_reference !== (input as Record<string, JsonValue>).thread_reference) throw new Error("Publication receipt differs from its requested thread");
    }
    if (!step.decision && typeof (output as Record<string, JsonValue>)?.thread_reference !== "string") return [];
    const conversation = await this.#options.conversationForReceipt({ artifact, destinationBinding: destination, output });
    if (step.decision?.thread !== undefined) {
      const notice = (output as Record<string, JsonValue>).message_id;
      if (typeof notice !== "string" || !notice) throw new Error("Threaded decision has no exact notice identity");
      conversation.decisionMessageId = notice;
    }
    const privateDelivery = !!step.decision || step.message?.recipient !== undefined;
    const recipientIds = [...new Set(artifact.workflowBindings?.directRecipients.filter((entry) => entry.destinationBinding === destination).map((entry) => entry.memberId) ?? [])];
    const memberId = step.decision ? itemKey : recipientIds.length === 1 ? recipientIds[0] : undefined;
    if (privateDelivery) {
      if (!memberId) throw new Error("Private publication has no exact Instance recipient mapping");
      const member = conversation.subjectPrincipal ? findByCanonicalPrincipal(await this.#options.currentRoster(), conversation.subjectPrincipal) : undefined;
      if (!member || member.id !== memberId) throw new Error("Private publication receipt does not resolve to its exact human recipient");
    }
    const assignment: WorkflowAssignment = { ...conversation, instanceId: run.instanceId, assignmentKey: workflowAssignmentKey(run.instanceId, conversation), runId: run.runId, stepId: step.id, artifactHash: run.artifactHash,
      expiresAt: new Date(Date.parse(this.#now()) + (this.#options.assignmentLifetimeMs ?? 30 * 86_400_000)).toISOString() };
    const receipt = output as Record<string, JsonValue>, sent = input as Record<string, JsonValue>;
    if (typeof receipt.message_id !== "string" || typeof receipt.published_at !== "string" || typeof sent.content !== "string") throw new Error("Publication has no exact delivered text and receipt");
    const format = sent.format === "provider-markdown" ? "provider-markdown" : "plain-text";
    const published: WorkflowAssignment = { ...assignment, assignmentKey: workflowPublicationKey(run.instanceId, conversation, receipt.message_id),
      publication: { messageId: receipt.message_id, content: sent.content, format, publishedAt: receipt.published_at, sequence: run.revision + 1,
        contentDigest: sha256({ content: sent.content, format }) } };
    // Threaded messages contribute evidence without replacing their parent's
    // execution assignment. Each provider message has its own immutable key.
    return [...(!step.decision && Object.hasOwn(input as object, "thread_reference") ? [] : [assignment]), published];
  }

  async #decisionStep(run: WorkflowRun, artifact: CompanyOSArtifact, workflow: CompiledWorkflow, step: CompiledWorkflowStep, roster: RosterMember[]): Promise<WorkflowRun> {
    const state = structuredClone(run.state), now = this.#now(), declaration = step.decision!;
    let decision = state.decisions[step.id];
    if (!decision) {
      const bound = resolveWorkflowValue(declaration.binds, workflow, workflowContext(run, roster));
      const recipient = declaration.recipient === undefined ? undefined : resolveWorkflowValue(declaration.recipient, workflow, workflowContext(run, roster));
      const recipients = roster.filter((member) => (recipient === undefined || member.id === recipient) && workflowDecisionMemberAllowed(member, workflow, step)).map((member) => member.id!).sort();
      if (!recipients.length || new Set(recipients).size !== recipients.length) throw new Error("Workflow decision has no unambiguous active human role recipient");
      decision = { stepId: step.id, role: declaration.role, status: "pending", bound, boundDigest: jsonDigest(bound), recipients, deliveries: {}, createdAt: now,
        expiresAt: workflowBusinessDeadline(this.#calendar(workflow, declaration.calendarPath)!, now, declaration.timeoutBusinessDays) };
      state.decisions[step.id] = decision;
      state.steps[step.id] = { status: "running", startedAt: now, inputDigest: decision.boundDigest };
      // Preflight every recipient before the first notice can send.
      const prepared = { ...run, state };
      const inputs = recipients.map((recipient) => workflowToolInput(artifact, workflow, step, { ...workflowContext(prepared, roster), itemKey: recipient } as any));
      state.steps[step.id]!.evidence = { destination_qualification: await this.#options.qualifyMessageDestinations(artifact, inputs) };
      return await this.#save(run, state, "workflow.decision-prepared", { bound_digest: decision.boundDigest, expires_at: decision.expiresAt });
    }
    if (decision.status !== "pending") throw new Error("Workflow decision was already resolved");
    if (decision.expiresAt <= now) {
      decision.status = "timed-out"; decision.decidedAt = now;
      this.#finish(state, step, { bound: decision.bound, decision: "timed-out" }, now, declaration.targets.timeout);
      return await this.#save(run, state, "workflow.decision-timed-out");
    }
    const calendar = this.#calendar(workflow, declaration.calendarPath)!, dueAt = workflowDeliveryInstant(calendar, now);
    if (dueAt !== now) {
      state.status = "waiting"; state.wait = { stepId: step.id, kind: "delivery", dueAt, timerId: timerId(run, step.id, "delivery", dueAt) };
      return await this.#save(run, state, "workflow.awaiting-delivery-window", { due_at: dueAt });
    }
    const recipient = decision.recipients.find((id) => !Object.hasOwn(decision!.deliveries, id));
    if (recipient) {
      const reader = new WorkflowRunContextReader({ store: this.#options.store, instanceId: run.instanceId, runId: run.runId, leaseToken: run.lease!.token,
        roster: this.#options.currentRoster, clock: () => this.#now(), itemKey: recipient });
      const input = workflowToolInput(artifact, workflow, step, await reader.read());
      const result = await this.#executeTool(run, artifact, workflow, step, reader, input, recipient);
      const assignments = await this.#assignments(run, artifact, step, input, result.output, recipient);
      decision.deliveries[recipient] = result.output;
      return await this.#save(run, state, "workflow.decision-delivered", { recipient_id: recipient, bound_digest: decision.boundDigest }, assignments);
    }
    state.status = "waiting"; state.steps[step.id]!.status = "waiting";
    state.wait = { stepId: step.id, kind: "decision", dueAt: decision.expiresAt, timerId: timerId(run, step.id, "decision", decision.expiresAt) };
    return await this.#save(run, state, "workflow.awaiting-decision", { bound_digest: decision.boundDigest, expires_at: decision.expiresAt });
  }


  /** The host captures verified conversation and event identity; models submit facts only. */
  async collect(args: { principal: string; conversation: WorkflowConversation; eventId: string; output: JsonValue }): Promise<WorkflowRun> {
    opaqueId(args.eventId);
    const now = this.#now(), store = this.#options.store, instanceId = this.#artifact.instance.id;
    const assignment = await store.assignment({ instanceId, conversation: { ...args.conversation, subjectPrincipal: args.principal }, now });
    if (!assignment || assignment.subjectPrincipal !== args.principal) throw new Error("Collection requires its exact private human assignment");
    const run = await store.claim({ instanceId, runId: assignment.runId, owner: "workflow-collection", token: randomUUID(), now, expiresAt: new Date(Date.parse(now) + 300_000).toISOString() });
    if (!run) throw new Error("Workflow collection is busy or closed");
    try {
      this.#enabled(run.workflowId);
      const { artifact, workflow, step } = await this.#definition(run);
      const roster = await this.#options.currentRoster(), member = findByCanonicalPrincipal(roster, args.principal);
      if (!member || !isHumanRosterMember(member) || !/^(active|aktiv)$/i.test(member.status)) throw new Error("Collection requires an active human");
      const source = /^\$steps\.([a-z][a-z0-9-]*)\.thread_reference$/.exec(String(step.collect?.from));
      if (!step.collect || !source || assignment.stepId !== source[1] || run.state.status !== "waiting" || run.state.blocked
        || !run.state.wait || run.state.wait.dueAt <= now) throw new Error("Collection is not waiting for this conversation");
      validateCollection(step, args.output);
      await validateCollectionCandidate({ artifact, agentId: workflow.agentId, runId: run.runId, step,
        context: resolveWorkflowValue(step.collect.context, workflow, workflowContext(run, roster)), facts: args.output });
      const state = structuredClone(run.state);
      this.#finish(state, step, args.output, now);
      return await this.#save(run, state, "workflow.facts-collected", { response_event_id: args.eventId, output_digest: jsonDigest(args.output) }, undefined, args.principal);
    } finally { await store.release({ instanceId, runId: run.runId, leaseToken: run.lease!.token }); }
  }

  /** Trusted transport must authenticate principal, conversation and provider event identity. */
  async decide(args: { principal: string; conversation: WorkflowConversation; eventId: string; requestId: string; decision: "approved" | "rejected" }, onValidated?: (language?: string) => Promise<void>): Promise<WorkflowRun> {
    opaqueId(args.eventId);
    const now = this.#now(), store = this.#options.store, instanceId = this.#artifact.instance.id;
    const assignment = await store.deliveredAssignment({ instanceId, conversation: { ...args.conversation, subjectPrincipal: args.principal } });
    if (!assignment) throw new Error("Human response has no exact active delivered workflow assignment");
    const prior = await store.read(instanceId, assignment.runId);
    if (!prior) throw new Error("Workflow decision run is missing");
    const priorDecision = prior.state.decisions[assignment.stepId];
    if (priorDecision?.responseEventId === args.eventId && priorDecision.status === args.decision && priorDecision.approvingPrincipal === args.principal
      && workflowDecisionId(prior.runId, assignment.stepId, priorDecision.boundDigest) === args.requestId) return prior;
    if (terminal(prior) || assignment.expiresAt <= now) throw new Error("Human response has no active delivered workflow assignment");
    this.#enabled(prior.workflowId);
    const run = await store.claim({ instanceId, runId: prior.runId, owner: "workflow-human-response", token: randomUUID(), now, expiresAt: new Date(Date.parse(now) + 300_000).toISOString() });
    if (!run) throw new WorkflowLeaseLostError();
    try {
      const { artifact, workflow, step } = await this.#definition(run), decision = run.state.decisions[step.id];
      if (!step.decision || assignment.stepId !== step.id || !decision || decision.status !== "pending" || decision.expiresAt <= now
        || workflowDecisionId(run.runId, step.id, decision.boundDigest) !== args.requestId) throw new Error("Human response is stale, expired or names another bound decision");
      const member = authorizeWorkflowDecisionPrincipal(await this.#options.currentRoster(), args.principal, workflow, step);
      if (!Object.hasOwn(decision.deliveries, member.id!)) throw new Error("Human response has no delivered review notice for this exact member");
      // Presentation is optional and cannot authorize, veto or alter the decision.
      if (onValidated) { try { await onValidated(artifact.language); } catch { /* Continue durable processing if presentation fails. */ } }
      const state = structuredClone(run.state), recorded = state.decisions[step.id]!;
      recorded.status = args.decision; recorded.approvingPrincipal = args.principal; recorded.responseEventId = args.eventId; recorded.decidedAt = now;
      this.#finish(state, step, { bound: recorded.bound, decision: args.decision }, now, args.decision === "approved" ? step.decision.targets.approve : step.decision.targets.reject);
      return await this.#save(run, state, `workflow.decision-${args.decision}`, { principal: args.principal, response_event_id: args.eventId, bound_digest: recorded.boundDigest }, undefined, args.principal);
    } finally {
      await store.release({ instanceId, runId: run.runId, leaseToken: run.lease!.token });
    }
  }

  async wake(timer: ClaimedDurableTimer): Promise<boolean> {
    if (timer.instanceId !== this.#artifact.instance.id || timer.timerKind !== "workflow") throw new Error("Timer is outside this workflow Instance");
    const payload = timer.payload as Record<string, JsonValue>, now = this.#now(), store = this.#options.store;
    if (typeof payload.run_id !== "string" || typeof payload.step_id !== "string" || typeof payload.instant !== "string") throw new Error("Workflow timer payload is invalid");
    const claimed = await this.#options.timers.store.readClaim({ instanceId: timer.instanceId, timerId: timer.timerId, leaseToken: timer.leaseToken, now });
    if (!claimed || canonicalJson(claimed) !== canonicalJson(timer)) return false;
    if (timer.timerId !== timerId({ instanceId: timer.instanceId, workflowId: payload.workflow_id, runId: payload.run_id } as WorkflowRunIdentity, payload.step_id, String(payload.kind), payload.instant)) throw new Error("Workflow timer identity differs from its persisted wait");
    const previous = await store.read(timer.instanceId, payload.run_id);
    if (!previous || terminal(previous)) return this.#options.timers.complete(timer, { outcome: "terminal-or-absent" }, now);
    if (previous.artifactHash !== payload.artifact_hash || previous.workflowId !== payload.workflow_id) throw new Error("Workflow timer does not match the pinned run");
    if (payload.instant > now) throw new Error("Workflow timer cannot fire before its declared instant");
    const run = await store.claim({ instanceId: timer.instanceId, runId: previous.runId, owner: "workflow-timer", token: randomUUID(), now, expiresAt: new Date(Date.parse(now) + 300_000).toISOString() });
    if (!run) return this.#options.timers.retry(timer, timer.dueAt, { outcome: "run-busy" });
    try {
      const { step } = await this.#definition(run), state = structuredClone(run.state);
      if (payload.kind === "decision") {
        const decision = state.decisions[payload.step_id];
        if (step.id !== payload.step_id || !step.decision || decision?.status !== "pending" || decision.expiresAt !== payload.instant) {
          await this.#save(run, state, "workflow.stale-timer"); return this.#options.timers.complete(timer, { outcome: "stale" }, now);
        }
        decision.status = "timed-out"; decision.decidedAt = now;
        this.#finish(state, step, { bound: decision.bound, decision: "timed-out" }, now, step.decision.targets.timeout);
      } else {
        if (state.wait?.timerId !== timer.timerId || state.wait.dueAt !== payload.instant || step.id !== payload.step_id) {
          await this.#save(run, state, "workflow.stale-timer"); return this.#options.timers.complete(timer, { outcome: "stale" }, now);
        }
        if (payload.kind === "step") {
          state.logicalInstant = payload.instant;
          if (step.collect) { state.status = "cancelled"; state.cursor = null; delete state.wait; }
          else this.#finish(state, step, { instant: payload.instant }, now);
        } else { state.status = "running"; delete state.wait; }
      }
      await this.#save(run, state, "workflow.timer-fired", { timer_id: timer.timerId, instant: payload.instant });
      return await this.#options.timers.complete(timer, { outcome: "applied", run_id: run.runId }, now);
    } finally {
      await store.release({ instanceId: run.instanceId, runId: run.runId, leaseToken: run.lease!.token });
    }
  }

  async advance(runId: string, maxSteps = 100): Promise<WorkflowRun | undefined> {
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 200) throw new Error("Workflow worker step budget must be from 1 to 200");
    const workerDeadline = Date.now() + 150_000;
    let run = await this.#options.store.read(this.#artifact.instance.id, runId);
    for (let count = 0; count < maxSteps && Date.now() < workerDeadline && run && !terminal(run); count++) {
      const next = await this.step(runId);
      if (!next) return undefined;
      await this.#ensureTimers(next);
      if (next.revision === run.revision || next.state.status === "waiting") return next;
      run = next;
    }
    return run;
  }

  /** Return a continuation so hosted workers can finish a bounded repair scan across invocations. */
  async repairTimers(afterRunId?: string): Promise<{ scanned: number; afterRunId?: string }> {
    const runs = await this.#options.store.list({ instanceId: this.#artifact.instance.id, limit: 200, activeOnly: true, ...(afterRunId ? { afterRunId } : {}) });
    const deadline = Date.now() + 45_000;
    let scanned = 0;
    for (const run of runs) {
      await this.#ensureTimers(run); scanned++;
      if (Date.now() >= deadline) break;
    }
    return { scanned, ...(scanned > 0 && (scanned < runs.length || runs.length === 200) ? { afterRunId: runs[scanned - 1]!.runId } : {}) };
  }

  async timers(args: { repairAfterRunId?: string } = {}): Promise<{ completed: number; repairAfterRunId?: string; errors: Array<{ timerId: string; errorDigest: string }> }> {
    const repair = await this.repairTimers(args.repairAfterRunId), deadline = Date.now() + 45_000;
    const errors: Array<{ timerId: string; errorDigest: string }> = [];
    let completed = 0, attempted = 0, delayed = false;
    while (attempted < 100 && Date.now() < deadline && !delayed) {
      const now = this.#now();
      const timers = await this.#options.timers.claimDue({ timerKind: "workflow", now, owner: "workflow-timers", leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.parse(now) + 300_000).toISOString(), limit: Math.min(10, 100 - attempted) });
      if (!timers.length) break;
      for (const timer of timers) {
        if (Date.now() >= deadline) {
          await this.#options.timers.retry(timer, timer.dueAt, { outcome: "worker-budget" }); delayed = true; continue;
        }
        attempted++;
        try { if (await this.wake(timer)) completed++; else delayed = true; }
        catch (error) {
          // Keep original identity and time. Finish other claims in this small
          // batch, but never spin on a failing/busy timer in the same tick.
          const errorDigest = sha256(error instanceof Error ? error.message : String(error));
          await this.#options.timers.retry(timer, timer.dueAt, { outcome: "worker-error", error_digest: errorDigest });
          errors.push({ timerId: timer.timerId, errorDigest }); delayed = true;
        }
      }
    }
    return { completed, errors, ...(repair.afterRunId ? { repairAfterRunId: repair.afterRunId } : {}) };
  }

  async cancel(runId: string, principal: string): Promise<boolean> {
    await this.#operator(principal);
    const cancelled = await this.#options.store.cancel({ instanceId: this.#artifact.instance.id, runId, principal, now: this.#now() });
    if (cancelled) for (const timer of await this.#options.timers.list("workflow")) if ((timer.payload as Record<string, JsonValue>).run_id === runId) await this.#options.timers.cancel(timer.timerId, { outcome: "run-cancelled" }, this.#now());
    return cancelled;
  }

  /** Historical evidence only; this never resumes, claims, repairs or dispatches. */
  async verify(runId: string, principal: string, requirements?: readonly WorkflowVerificationRequirement[]) {
    await this.#operator(principal);
    const run = await this.#options.store.read(this.#artifact.instance.id, runId);
    if (!run) throw new Error("Workflow run is unavailable in this Instance");
    const artifact = await this.#options.store.getArtifact(run.artifactHash);
    if (!artifact) throw new Error("Workflow historical Artifact is unavailable");
    return verifyCompletedWorkflow({ artifact, run, control: this.#options.control, requirements });
  }

  /** One effect per page keeps review bounded even for large keyed collections. */
  async review(runId: string, principal: string, offset = 0) {
    await this.#operator(principal);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= 10000) throw new Error("Invalid workflow review offset");
    const run = await this.#options.store.read(this.#artifact.instance.id, runId);
    if (!run?.state.blocked) throw new Error("Workflow has no blocked execution to review");
    const { artifact, workflow, step } = await this.#definition(run), ctx = workflowContext(run, await this.#options.currentRoster());
    const items = !step.tool ? [] : step.forEach ? workflowItems(step, workflow, ctx)
      : step.decision ? (run.state.decisions[step.id]?.recipients ?? []).map((key) => ({ key, value: undefined })) : [{ key: undefined, value: undefined }];
    if (offset >= Math.max(1, items.length)) throw new Error("Workflow review offset exceeds the collection");
    const item = items[offset], context = { ...ctx, ...(item?.key === undefined ? {} : { itemKey: item.key, ...(item.value === undefined ? {} : { item: item.value }) }) };
    const idempotencyKey = item ? workflowEffectKey(artifact, context) : undefined;
    let input: JsonValue = null, inputAvailable = false;
    try { if (item) { input = workflowToolInput(artifact, workflow, step, context); inputAvailable = true; } } catch { /* Broken input must not hide an already retained receipt. */ }
    const effect = idempotencyKey ? await this.#options.control.getEffect(idempotencyKey) : undefined;
    return { runId, workflowId: run.workflowId, artifactHash: run.artifactHash, manifestHash: run.manifestHash,
      revision: run.revision, stepId: step.id, blocked: run.state.blocked,
      message: "Execution is stopped. Inspect the retained receipts and provider state before any separate recovery decision. This report does not authorize retry.",
      offset, totalEffects: items.length, inputAvailable, ...(offset + 1 < items.length ? { nextOffset: offset + 1 } : {}),
      ...(run.state.reviewDelivery ? { delivery: { digest: run.state.reviewDelivery.digest, recipient: run.state.reviewDelivery.memberId,
        pages: run.state.reviewDelivery.pages.length, delivered: run.state.reviewDelivery.outputs.length, ...(run.state.reviewDelivery.blocked ? { blocked: run.state.reviewDelivery.blocked } : {}) } } : {}),
      ...(item?.key === undefined ? {} : { itemKey: item.key }), ...(idempotencyKey ? { idempotencyKey } : {}),
      effect: workflowEffectReview(effect, input) };
  }

  /** A separate R2 control purpose drains its frozen pages while business execution stays stopped. */
  async #deliverReview(existing: WorkflowRun): Promise<WorkflowRun | undefined> {
    this.#enabled(existing.workflowId);
    if (existing.state.reviewDelivery?.blocked || (existing.state.reviewDelivery && existing.state.reviewDelivery.outputs.length === existing.state.reviewDelivery.pages.length)) return existing;
    const store = this.#options.store, now = this.#now();
    const run = await store.claim({ instanceId: existing.instanceId, runId: existing.runId, owner: "workflow-review", token: randomUUID(), now, expiresAt: new Date(Date.parse(now) + 300_000).toISOString() });
    if (!run) return store.read(existing.instanceId, existing.runId);
    try {
      if (run.state.status !== "waiting" || !run.state.blocked) return run;
      const { artifact, workflow, step } = await this.#definition(run), state = structuredClone(run.state);
      const roster = await this.#options.currentRoster();
      if (!state.reviewDelivery) {
        if (!step.tool || step.forEach || step.decision) return run;
        const context = workflowContext(run, roster), effect = await this.#options.control.getEffect(workflowEffectKey(artifact, context));
        let input: JsonValue = null;
        try { input = workflowToolInput(artifact, workflow, step, context); } catch { /* Missing input must not hide a stopped approved request. */ }
        const delivery = prepareWorkflowReviewDelivery({ run, workflow, step, roster, effect, input, language: artifact.language });
        if (!delivery) return run;
        await this.#options.qualifyMessageDestinations(artifact, [delivery.pages[0]!.input]);
        state.reviewDelivery = delivery;
        return await this.#save(run, state, "workflow.review-prepared", { review_digest: delivery.digest, pages: delivery.pages.length });
      }
      const delivery = state.reviewDelivery;
      if (delivery.blocked || delivery.outputs.length === delivery.pages.length) return run;
      const calendar = this.#calendar(workflow);
      if (calendar && workflowDeliveryInstant(calendar, now) !== now) return run;
      const reader = new WorkflowReviewContextReader({ store, instanceId: run.instanceId, runId: run.runId, leaseToken: run.lease!.token, roster: this.#options.currentRoster, clock: () => this.#now() });
      const context = await reader.read(), noticeStep = workflow.steps.find((entry) => entry.id === delivery.decisionStepId)!;
      const input = workflowReviewNoticeInput(artifact, workflow, noticeStep, context);
      await this.#options.qualifyMessageDestinations(artifact, [input]);
      const runtime = new CompanyOSRuntime({ artifact, state: this.#options.control, roster, connectors: await this.#options.connectors(artifact), workflowContext: reader });
      const page = delivery.outputs.length;
      let output: JsonValue;
      try {
        const result = await runtime.execute({ runId: run.runId, stepId: workflowReviewStepId(delivery.blockedStepId, page), agentId: workflow.agentId,
          grantId: noticeStep.tool!.grantId, input, subjectPrincipal: delivery.principal }) as { output?: JsonValue } | undefined;
        if (!result || result.output === undefined) throw new Error("Effect review publication has no verified outcome; inspect it without retry");
        const receipt = result.output as Record<string, JsonValue>, requested = input as Record<string, JsonValue>;
        if (typeof receipt?.message_id !== "string" || receipt.thread_reference !== requested.thread_reference || receipt.destination_binding !== requested.destination_binding) throw new Error("Effect review publication receipt differs from its exact conversation");
        output = result.output;
      } catch (error) {
        if (error instanceof WorkflowLeaseLostError) return store.read(run.instanceId, run.runId);
        const current = await store.read(run.instanceId, run.runId);
        if (!current || terminal(current) || current.lease?.token !== run.lease!.token) return current;
        const effect = await this.#options.control.getEffect(workflowReviewEffectKey(run.instanceId, run.runId, workflowReviewStepId(delivery.blockedStepId, page)));
        if (!effect) throw error;
        delivery.blocked = { errorDigest: sha256(error instanceof Error ? error.message : String(error)) };
        return await this.#save(run, state, "workflow.review-delivery-blocked", { review_digest: delivery.digest, error_digest: delivery.blocked.errorDigest });
      }
      delivery.outputs.push(output);
      return await this.#save(run, state, "workflow.review-delivered", { review_digest: delivery.digest, page, output_digest: jsonDigest(output) });
    } finally {
      await store.release({ instanceId: run.instanceId, runId: run.runId, leaseToken: run.lease!.token });
    }
  }

  /** Reconcile only a pending notice proven never sent; never approve or retry business effects. */
  async recoverUnpublishedDecision(runId: string, principal: string): Promise<WorkflowRun> {
    await this.#operator(principal);
    const now = this.#now(), store = this.#options.store;
    const run = await store.claim({ instanceId: this.#artifact.instance.id, runId, owner: "workflow-operator", token: randomUUID(), now, expiresAt: new Date(Date.parse(now) + 300_000).toISOString() });
    if (!run) throw new Error("Workflow recovery is busy or closed");
    try {
      this.#enabled(run.workflowId);
      const definition = await this.#definition(run);
      const { state, inputs } = await prepareDecisionRecovery({ run, ...definition, roster: await this.#options.currentRoster(), control: this.#options.control,
        verify: this.#options.verifyPublicationNotSent, now, principal });
      const qualification = await this.#options.qualifyMessageDestinations(definition.artifact, inputs);
      return await this.#save(run, state, "workflow.decision-publication-recovery-authorized", {
        recoveries: state.steps[definition.step.id]!.publicationRecoveries! as unknown as JsonValue, destination_qualification: qualification,
      }, undefined, principal);
    } finally { await store.release({ instanceId: run.instanceId, runId, leaseToken: run.lease!.token }); }
  }

  async resume(runId: string, principal: string): Promise<WorkflowRun> {
    await this.#operator(principal);
    const now = this.#now(), run = await this.#options.store.claim({ instanceId: this.#artifact.instance.id, runId, owner: "workflow-operator", token: randomUUID(), now, expiresAt: new Date(Date.parse(now) + 300_000).toISOString() });
    if (!run) throw new Error("Workflow has no resumable blocked state");
    try {
      if (!run.state.blocked) throw new Error("Workflow has no resumable blocked state");
      const { artifact, workflow, step } = await this.#definition(run), ctx = workflowContext(run, await this.#options.currentRoster());
      const keys = step.forEach ? workflowItems(step, workflow, ctx).map((item) => item.key)
        : step.decision ? run.state.decisions[step.id]?.recipients ?? [] : [undefined];
      for (const itemKey of keys) {
        const effect = await this.#options.control.getEffect(workflowEffectKey(artifact, { ...ctx, ...(itemKey === undefined ? {} : { itemKey }) }));
        if (effect && effect.status !== "succeeded") throw new Error("Unknown, failed or claimed workflow effect requires reconciliation; it cannot be retried blindly");
      }
      const state = structuredClone(run.state); delete state.blocked; state.status = "running";
      if (state.steps[step.id]) state.steps[step.id]!.status = "running";
      return await this.#save(run, state, "workflow.resumed", { principal }, undefined, principal);
    } finally {
      await this.#options.store.release({ instanceId: run.instanceId, runId, leaseToken: run.lease!.token });
    }
  }
}
