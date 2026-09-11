import type { ConversationMessage, Participation } from "../conversation-participation.ts";
import type { CapabilityCallContext, Connector, JsonValue } from "../../capabilities/contracts.ts";
import type { BuilderJob } from "../../state-store/builder-jobs.ts";
import type { CheckedProposal, ProposalPublicationReceipt } from "../repository/contracts.ts";
import { sha256 } from "../canonical.ts";

export type BuilderTestExecution =
  | { kind: "agent"; agentId: string; prompt: string; interaction?: "automatic" | "interactive" }
  | { kind: "workflow"; workflowId: string; fields: Record<string, string> };

/** Instance authority, never a grant supplied by the candidate or coding process. */
export interface BuilderTestResource {
  id: string;
  capability: string;
  match: Record<string, string>;
}

export interface BuilderTestResult {
  participation?: Participation;
  artifactHash: string;
  candidateCommit: string;
  executionDigest: string;
  completedAt: string;
  summary: string;
  /** Trusted execution evidence. A model's assertion of success is not a receipt. */
  evidence: JsonValue;
}

export interface BuilderTestSession {
  version: 1;
  id: string;
  revision: number;
  jobId: string;
  previousTestSessionId?: string;
  instanceId: string;
  repositoryId: string;
  requester: string;
  sourceConversation: string;
  baseCommit: string;
  candidateCommit: string;
  coreCommit: string;
  sourceArtifactHash: string;
  briefDigest: string;
  checksDigest: string;
  scopeDigest: string;
  execution: BuilderTestExecution;
  resources: BuilderTestResource[];
  stage: "prepared" | "running" | "interactive" | "responding" | "expired" | "reviewable" | "feedback-pending" | "changes-requested" | "accepted" | "failed" | "discarded";
  conversation?: {
    expiresAt: string;
    turns: { messageId: string; prompt: string; message?: ConversationMessage; result: BuilderTestResult }[];
    pending?: { messageId: string; prompt: string; message?: ConversationMessage; previousResultDigest?: string };
    generation: number;
  };
  artifactHash?: string;
  testConversation?: string;
  testUrl?: string;
  result?: BuilderTestResult;
  /** Silent context does not invalidate the last visible result card. Cleared by a new answer. */
  retainedResultDigest?: string;
  feedback?: { principal: string; messageId: string; text: string; receivedAt: string };
  acceptance?: { principal: string; actionId: string; resultDigest: string; acceptedAt: string };
  failureDigest?: string;
  /** Independent conversations for the same immutable candidate. */
  testConversations?: Record<string, NonNullable<BuilderTestSession["conversation"]>>;
  activeTestConversation?: string;
  idleDays?: number;
  discardedBy?: string;
}

export interface BuilderTestStore {
  get(id: string): Promise<BuilderTestSession | undefined>;
  create(session: BuilderTestSession): Promise<BuilderTestSession>;
  /** One atomic update; a lost revision never overwrites feedback or acceptance. */
  replace(previous: BuilderTestSession, next: BuilderTestSession): Promise<boolean>;
}

const digestPattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{40}$/;
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

export function parseBuilderTestExecution(value: unknown): BuilderTestExecution {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A concrete Agent or workflow test is required.");
  const item = value as Record<string, unknown>;
  if (item.kind === "agent" && Object.keys(item).every((key) => ["kind", "agentId", "prompt", "interaction"].includes(key))
    && bounded(item.agentId, 128) && bounded(item.prompt, 4000)
    && (item.interaction === undefined || item.interaction === "automatic" || item.interaction === "interactive")) {
    return { kind: "agent", agentId: item.agentId, prompt: item.prompt,
      ...(item.interaction === undefined ? {} : { interaction: item.interaction }) };
  }
  if (item.kind === "workflow" && Object.keys(item).every((key) => ["kind", "workflowId", "fields"].includes(key))
    && bounded(item.workflowId, 128) && item.fields && typeof item.fields === "object" && !Array.isArray(item.fields)) {
    const fields = Object.entries(item.fields);
    if (fields.length <= 30 && fields.every(([key, entry]) => /^[a-z][a-z0-9_]{0,63}$/.test(key) && bounded(entry, 512))) {
      return { kind: "workflow", workflowId: item.workflowId, fields: Object.fromEntries(fields) as Record<string, string> };
    }
  }
  throw new Error("Invalid Builder functional test execution.");
}

export function parseBuilderTestResources(value: unknown): BuilderTestResource[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error("Builder test resources must be a bounded Instance list.");
  const resources = value.map((entry: unknown): BuilderTestResource => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid Builder test resource.");
    const item = entry as Record<string, unknown>;
    if (Object.keys(item).some((key) => !["id", "capability", "match"].includes(key))
      || !bounded(item.id, 128) || !bounded(item.capability, 128) || !item.match || typeof item.match !== "object" || Array.isArray(item.match)) throw new Error("Invalid Builder test resource.");
    const fields = Object.entries(item.match);
    if (!fields.length || fields.length > 20 || fields.some(([key, field]) => !/^[a-z][a-z0-9_]{0,63}$/.test(key) || !bounded(field, 512))) throw new Error("A test resource needs exact input constraints.");
    return { id: item.id, capability: item.capability, match: Object.fromEntries(fields) as Record<string, string> };
  });
  if (new Set(resources.map((resource) => resource.id)).size !== resources.length) throw new Error("Builder test resource IDs must be unique.");
  return resources;
}

export function checkedBuilderProposal(job: BuilderJob) {
  const evidence = job.evidence as { proposal?: ProposalPublicationReceipt; validation?: CheckedProposal } | undefined;
  const proposal = evidence?.proposal, checked = evidence?.validation;
  if (job.state !== "published" || !job.brief || !proposal || !checked?.validationPassed || !checked.releaseChangeClass
    || proposal.jobId !== job.jobId || proposal.baseCommit !== job.baseCommit || proposal.repositoryId !== job.repositoryId
    || !commitPattern.test(proposal.proposalCommit) || !digestPattern.test(job.brief.artifactHash)) throw new Error("Functional tests require an independently checked published proposal.");
  return { proposal, checked, brief: job.brief };
}

export function prepareBuilderTestSession(args: { job: BuilderJob; coreCommit: string; resources: readonly BuilderTestResource[]; execution: BuilderTestExecution }): BuilderTestSession {
  const { job } = args, { proposal, checked, brief } = checkedBuilderProposal(job);
  if (brief.brief.test.strategy !== "test-resources" || !commitPattern.test(args.coreCommit)) throw new Error("This executor requires the designated test-resources strategy and exact Core.");
  const available = parseBuilderTestResources(args.resources);
  const resources = brief.brief.test.targetBindings.map((id) => {
    const resource = available.find((entry) => entry.id === id);
    if (!resource) throw new Error("Selected test resource is not qualified in this Instance.");
    return resource;
  });
  if (!resources.length || new Set(resources.map((resource) => resource.id)).size !== resources.length) throw new Error("Select exact unique test resources.");
  const execution = parseBuilderTestExecution(args.execution);
  return {
    version: 1, id: `builder-test-${sha256([job.instanceId, job.jobId]).slice(0, 40)}`, revision: 0,
    jobId: job.jobId, instanceId: job.instanceId, repositoryId: job.repositoryId, requester: job.requesterPrincipal,
    sourceConversation: job.sourceConversationKey, baseCommit: job.baseCommit, candidateCommit: proposal.proposalCommit,
    coreCommit: args.coreCommit, sourceArtifactHash: brief.artifactHash, briefDigest: brief.digest,
    checksDigest: sha256(checked), scopeDigest: sha256({ resources, execution }), execution, resources, stage: "prepared",
  };
}

export function builderTestResultDigest(session: BuilderTestSession): string {
  if (!session.result || !session.artifactHash || !session.testConversation) throw new Error("This candidate has no completed functional test.");
  if (session.retainedResultDigest) return session.retainedResultDigest;
  return sha256({ id: session.id, previousTestSessionId: session.previousTestSessionId, candidateCommit: session.candidateCommit, artifactHash: session.artifactHash,
    coreCommit: session.coreCommit, checksDigest: session.checksDigest, briefDigest: session.briefDigest,
    scopeDigest: session.scopeDigest, testConversation: session.testConversation, testUrl: session.testUrl, result: session.result,
    ...(session.conversation ? { conversation: session.conversation } : {}),
    ...(session.testConversations ? { testConversations: session.testConversations, activeTestConversation: session.activeTestConversation } : {}) });
}

export function builderTestSessionId(job: Pick<BuilderJob, "instanceId" | "jobId">): string {
  return `builder-test-${sha256([job.instanceId, job.jobId]).slice(0, 40)}`;
}

export function isInteractiveAgentTest(session: Pick<BuilderTestSession, "execution">): boolean {
  return session.execution.kind === "agent" && session.execution.interaction === "interactive";
}

/** Only trusted host execution may supply results; chat exposes feedback and acceptance, not recordResult. */
export class BuilderFunctionalTests {
  readonly store: BuilderTestStore;
  readonly now: () => Date;
  readonly idleDays: number;
  constructor(store: BuilderTestStore, now: () => Date = () => new Date(), idleDays = 7) {
    if (!Number.isInteger(idleDays) || idleDays < 1 || idleDays > 90) throw new Error("Test inactivity must be between one and ninety days.");
    this.store = store; this.now = now; this.idleDays = idleDays;
  }
  #expiry(session: BuilderTestSession) { return new Date(this.now().getTime() + (session.idleDays ?? this.idleDays) * 86400000).toISOString(); }
  async #update(id: string, update: (session: BuilderTestSession) => BuilderTestSession): Promise<BuilderTestSession> {
    const previous = await this.store.get(id);
    if (!previous) throw new Error("Unknown Builder test session.");
    const next = update(structuredClone(previous));
    next.revision = previous.revision + 1;
    if (!await this.store.replace(previous, next)) throw new Error("Builder test changed concurrently; reload the current result.");
    return next;
  }
  async begin(id: string, artifactHash: string, testConversation: string, testUrl?: string) {
    return this.#update(id, (session) => {
      if (session.stage !== "prepared" || !digestPattern.test(artifactHash) || !bounded(testConversation, 512)) throw new Error("Test preparation is incomplete or already consumed.");
      if (testUrl && (testUrl.length > 2048 || new URL(testUrl).protocol !== "https:")) throw new Error("Test result URL is invalid.");
      return { ...session, stage: "running", artifactHash, testConversation, idleDays: this.idleDays, ...(testUrl ? { testUrl } : {}),
        ...(isInteractiveAgentTest(session) ? { conversation: { expiresAt: this.#expiry(session), turns: [], generation: 0 } } : {}) };
    });
  }
  async recordResult(id: string, result: BuilderTestResult) {
    return this.#update(id, (session) => {
      if (result.participation === "context-only" || session.stage !== "running" || result.artifactHash !== session.artifactHash || result.candidateCommit !== session.candidateCommit
        || result.executionDigest !== session.scopeDigest || !bounded(result.summary, 8000) || !Number.isFinite(Date.parse(result.completedAt))
        || JSON.stringify(result.evidence).length > 100_000) throw new Error("Test result does not prove this exact execution.");
      if (session.conversation && session.execution.kind === "agent") {
        return { ...session, stage: "interactive", result: structuredClone(result), conversation: { ...session.conversation,
          turns: [{ messageId: "initial", prompt: session.execution.prompt, result: structuredClone(result) }] } };
      }
      return { ...session, stage: "reviewable", result: structuredClone(result) };
    });
  }
  async beginTurn(id: string, principal: string, messageId: string, prompt: string, conversationReference?: string, message?: ConversationMessage) {
    return this.#update(id, (session) => {
      if (session.stage !== "interactive" || !session.conversation || principal !== session.requester
        || !bounded(messageId, 512) || !bounded(prompt, 4000)
        || Date.parse(session.conversation.expiresAt) <= this.now().getTime()) throw new Error("This test cannot accept another message. Ask Builder to resume an available build or select another test.");
      const reference = conversationReference ?? session.testConversation!;
      if (message && (message.id !== messageId || message.senderId !== principal || message.conversationId !== reference
        || message.text !== prompt || !Number.isFinite(Date.parse(message.sentAt)))) throw new Error("Test conversation identity does not match the authenticated message.");
      const histories = session.testConversations ?? { [session.testConversation!]: session.conversation };
      if (!bounded(reference, 512) || (!histories[reference] && Object.keys(histories).length >= 20)) throw new Error("This build has reached its test conversation limit.");
      const conversation = histories[reference] ?? { expiresAt: this.#expiry(session), turns: [], generation: 0 };
      if (conversation.turns.length >= 20 || conversation.turns.some(turn => turn.messageId === messageId)) throw new Error("Test reply is duplicated or this conversation is full.");
      return { ...session, stage: "responding", activeTestConversation: reference,
        testConversations: { ...histories, [reference]: conversation },
        conversation: { ...conversation, expiresAt: this.#expiry(session), pending: { messageId, prompt, previousResultDigest: session.result ? builderTestResultDigest(session) : undefined, ...(message ? { message: structuredClone(message) } : {}) } } };
    });
  }
  async recordTurn(id: string, messageId: string, result: BuilderTestResult) {
    return this.#update(id, (session) => {
      const conversation = session.conversation, pending = conversation?.pending;
      if (session.stage !== "responding" || !conversation || pending?.messageId !== messageId
        || Date.parse(conversation.expiresAt) <= this.now().getTime()
        || result.artifactHash !== session.artifactHash || result.candidateCommit !== session.candidateCommit
        || result.executionDigest !== session.scopeDigest || (result.participation === "context-only" ? result.summary !== "" : !bounded(result.summary, 8000))
        || !Number.isFinite(Date.parse(result.completedAt)) || JSON.stringify(result.evidence).length > 100_000) throw new Error("This reply does not belong to the active candidate test turn.");
      const { previousResultDigest, ...input } = pending;
      const completed = { ...conversation, expiresAt: this.#expiry(session), pending: undefined,
        turns: [...conversation.turns, { ...input, result: structuredClone(result) }] };
      return { ...session, stage: "interactive", result: result.participation === "context-only" ? session.result : structuredClone(result),
        retainedResultDigest: result.participation === "context-only" ? previousResultDigest : undefined, conversation: completed,
        testConversations: { ...session.testConversations, [session.activeTestConversation ?? session.testConversation!]: completed } };
    });
  }
  async finish(id: string, principal: string) {
    return this.#update(id, (session) => {
      if (session.stage !== "interactive" || !session.conversation || principal !== session.requester || !session.result
        || Date.parse(session.conversation.expiresAt) <= this.now().getTime()) throw new Error("Only the requester can finish an active test with a completed reply.");
      return { ...session, stage: "reviewable" };
    });
  }
  async restart(id: string, principal: string) {
    return this.#update(id, (session) => {
      if (!["interactive", "reviewable", "expired"].includes(session.stage) || !session.conversation || principal !== session.requester) {
        throw new Error("Only the requester can restart an unaccepted interactive test.");
      }
      return { ...session, stage: "interactive", result: undefined, retainedResultDigest: undefined, conversation: {
        expiresAt: this.#expiry(session), turns: [], generation: session.conversation.generation + 1,
      } };
    });
  }
  async expire(id: string) {
    return this.#update(id, (session) => {
      if (!["interactive", "responding"].includes(session.stage) || !session.conversation
        || Date.parse(session.conversation.expiresAt) > this.now().getTime()) throw new Error("The test is not expired.");
      return { ...session, stage: "expired" };
    });
  }
  async requestChanges(id: string, feedback: NonNullable<BuilderTestSession["feedback"]>) {
    return this.#update(id, (session) => {
      if (!["reviewable", "interactive", "expired", "feedback-pending"].includes(session.stage) || feedback.principal !== session.requester || !bounded(feedback.messageId, 512)
        || !bounded(feedback.text, 4000) || !Number.isFinite(Date.parse(feedback.receivedAt))) throw new Error("Only the authenticated requester may revise this reviewable test.");
      return { ...session, stage: "changes-requested", feedback: structuredClone(feedback) };
    });
  }
  async requestFeedback(id: string, principal: string) {
    return this.#update(id, (session) => {
      if (!["reviewable", "interactive"].includes(session.stage) || principal !== session.requester) throw new Error("Only the authenticated requester may request changes to this result.");
      return { ...session, stage: "feedback-pending" };
    });
  }
  /** Authority is checked by the current release policy before this trusted host call. */
  async accept(id: string, acceptance: NonNullable<BuilderTestSession["acceptance"]>) {
    return this.#update(id, (session) => {
      if (!["reviewable", "interactive"].includes(session.stage) || (session.stage === "interactive" && Date.parse(session.conversation!.expiresAt) <= this.now().getTime()) || !bounded(acceptance.principal, 512) || !bounded(acceptance.actionId, 512)
        || acceptance.resultDigest !== builderTestResultDigest(session) || !Number.isFinite(Date.parse(acceptance.acceptedAt))) throw new Error("Human acceptance must identify the exact current functional test result.");
      return { ...session, stage: "accepted", acceptance: structuredClone(acceptance) };
    });
  }
  async discard(id: string, principal: string) {
    return this.#update(id, session => {
      if (session.requester !== principal || session.stage === "accepted") throw new Error("Only the requester may discard an unpublished build.");
      return { ...session, stage: "discarded", discardedBy: principal };
    });
  }
  async resume(id: string, principal: string) {
    return this.#update(id, session => {
      if (session.requester !== principal || !session.conversation || !["expired", "interactive"].includes(session.stage)) throw new Error("This test cannot be resumed.");
      return { ...session, stage: "interactive", conversation: { ...session.conversation, expiresAt: this.#expiry(session) } };
    });
  }
  async fail(id: string, error: unknown) {
    return this.#update(id, (session) => {
      if (!["prepared", "running", "responding"].includes(session.stage)) throw new Error("A completed test cannot be replaced by a failure.");
      return { ...session, stage: "failed", failureDigest: sha256(error instanceof Error ? error.message : String(error)) };
    });
  }
  async releaseEvidence(job: BuilderJob, accepted: boolean) {
    const { checked, proposal, brief } = checkedBuilderProposal(job);
    const id = `builder-test-${sha256([job.instanceId, job.jobId]).slice(0, 40)}`;
    const session = await this.store.get(id);
    if (!session || !(accepted ? session.stage === "accepted" : ["interactive", "reviewable", "accepted"].includes(session.stage))
      || (session.stage === "interactive" && Date.parse(session.conversation!.expiresAt) <= this.now().getTime())
      || session.candidateCommit !== proposal.proposalCommit || session.baseCommit !== job.baseCommit
      || session.sourceArtifactHash !== brief.artifactHash || session.briefDigest !== brief.digest
      || session.checksDigest !== sha256(checked)) throw new Error("The exact candidate has no current functional-test evidence.");
    return { session, digest: builderTestResultDigest(session) };
  }
}

/** A compiled candidate can narrow intent but cannot expand the Instance test scope. */
export function scopeBuilderTestConnector(connector: Connector, args: {
  instanceId: string; runId: string; resources: readonly BuilderTestResource[];
  assertActive(): Promise<void>;
}): Connector {
  return { id: connector.id, version: connector.version, capabilities: connector.capabilities,
    async invoke(capability: string, input: unknown, context: CapabilityCallContext) {
      if (context.instanceId !== args.instanceId || context.runId !== args.runId
        || !input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invocation is outside the Builder test execution.");
      const value = input as Record<string, unknown>;
      if (!args.resources.some((resource) => resource.capability === capability
        && Object.entries(resource.match).every(([key, expected]) => value[key] === expected))) throw new Error("Capability input is outside the exact Builder test resources.");
      await args.assertActive();
      return connector.invoke(capability, input, context);
    },
  };
}
