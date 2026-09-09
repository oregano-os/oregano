import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { buildCompanyOSArtifact } from "../companyos-builder/build.ts";
import { CORE_CAPABILITY_CATALOG } from "../capabilities/catalog.ts";
import { CapabilityEffectOutcomeUnknownError, type CapabilityCallContext, type Connector, type JsonValue } from "../capabilities/contracts.ts";
import { RecordIdentityDirectory } from "../records/identity-directory.ts";
import { WorkflowEngine } from "../runtime/workflow-engine/engine.ts";
import { InMemoryWorkflowExecutionStore } from "../runtime/workflow-engine/memory-store.ts";
import { InMemoryDurableTimerStore } from "../runtime/memory-durable-timers.ts";
import { DurableTimerService } from "../runtime/durable-timers.ts";
import { sha256 } from "../runtime/canonical.ts";
import type { WorkflowExecutionStore, WorkflowConversation } from "../state-store/workflow-engine.ts";
import type { DurableTimerStore } from "../state-store/durable-timers.ts";
import type { StateStore } from "../state-store/interface.ts";
import type { CompanyOSArtifact } from "../companyos-builder/types.ts";

export const ENGINE_OPERATOR = "slack:T10001:U10001";
export const ENGINE_OWNER = "slack:T10001:U10002";
export function engineArtifact(instanceId = `engine-${randomUUID()}`, workspaceRoot = resolve(import.meta.dirname, "fixtures/lindenhof-studio")): CompanyOSArtifact {
  return buildCompanyOSArtifact({ workspaceRoot,
    instance: { version: 1, instanceId, environment: "test", defaultAgentId: "sprint", agentBindings: [],
      bindings: ["directory.members.query", "records.query", "work-item.read", "work-item.batch-update", "communication.message.publish"].map((capability) => ({
        capability, contractVersion: CORE_CAPABILITY_CATALOG.find((c) => c.id === capability)!.version, connector: "test/engine", connectorVersion: "1.0.0",
      })), workflowBindings: { directRecipients: ["jonas-owner", "lea-contributor", "tim-contributor"].map((memberId) => ({ bindingId: "sprint-direct", memberId, destinationBinding: `direct-${memberId}` })) },
    }, coreVersion: "0.5.14", coreCommit: "1".repeat(40), workspaceCommit: "2".repeat(40), workbenchVersion: "0.1.0-experimental.15", builtAt: "2026-09-06T00:00:00.000Z" });
}

/** Synthetic provider boundary, actual compiler, sandboxed Company Tools, Runtime and stores.
 * Every publish and batch call counts: the provider deliberately has no deduplication.
 * Synthetic coverage below is test input, not a Slack/Monday qualification claim.
 */
export function engineFixture(options: { verifyPublicationNotSent?: import("../runtime/workflow-engine/engine.ts").WorkflowEngineOptions["verifyPublicationNotSent"]; store?: WorkflowExecutionStore; control?: StateStore; timerStore?: DurableTimerStore; artifact?: CompanyOSArtifact; recordsConnector?: Connector; batchConnector?: Connector; publicationConnector?: Connector; conversationForReceipt?: import("../runtime/workflow-engine/engine.ts").WorkflowEngineOptions["conversationForReceipt"] } = {}) {
  const artifact = options.artifact ?? engineArtifact(), memory = new InMemoryWorkflowExecutionStore();
  const store = options.store ?? memory, control = options.control ?? memory.control, timerStore = options.timerStore ?? new InMemoryDurableTimerStore();
  const timers = new DurableTimerService({ store: timerStore, instanceId: artifact.instance.id });
  const fixture = {
    artifact, store, control, timerStore, timers, now: "2030-01-04T14:30:00.000Z", roster: structuredClone(artifact.roster),
    calls: [] as Array<{ capability: string; input: any; context: CapabilityCallContext }>,
    missingThread: false, unknownBatch: false, unknownPublication: false, failQuery: false,
    submissions: [] as Array<{ record_id: string; values: Record<string, JsonValue> }>,
    items: [{ record_id: "item-1", values: { work_item_id: "item-1", title: "Fictional deliverable", assignee_ids: ["lea-contributor"], status: "Working", provider_version: "v1", group: "in_sprint", url: "https://example.test/items/1" } }] as Array<{ record_id: string; values: Record<string, JsonValue> }>,
    planning: [] as Array<{ record_id: string; values: Record<string, JsonValue> }>,
  };
  const connector: Connector = { id: "test/engine", version: "1.0.0", capabilities: artifact.bindings.map((b) => b.capability), async invoke(capability, raw, context) {
    const input = raw as Record<string, any>; fixture.calls.push({ capability, input: structuredClone(input), context: structuredClone(context) });
    if (capability === "directory.members.query") {
      const directory = new RecordIdentityDirectory(fixture.roster);
      return { output: { directory_digest: directory.digest, members: directory.members().map((m) => ({ member_id: m.id ?? null, display_name: m.name, type: m.type ?? "human", status: m.status, group_ids: m.groups ?? [], principals: m.principals ?? [] })) }, evidence: { synthetic: true } };
    }
    if (capability === "records.query") {
      if (options.recordsConnector) return options.recordsConnector.invoke(capability, input, context);
      if (fixture.failQuery) throw new Error("Synthetic Records provider is unavailable");
      const rows = input.projection_id === "sprint-roles" ? ["jonas-owner", "lea-contributor", "tim-contributor"].map((id) => ({ record_id: `role-${id}`, values: { person_ids: [id], lifecycle_state: "active", role: "delivery" } }))
        : input.projection_id === "sprint-close-submissions" ? fixture.submissions : input.filters?.group === "planned" ? fixture.planning : fixture.items;
      const instant = input.require_synced_through ?? fixture.now;
      const proof = input.require_scan_started_after !== undefined ? {
        scan_started_at: input.require_scan_started_after, source_proofs: [],
        source_scan_proofs: [{ source_id: "synthetic-test-source", source_digest: sha256(rows), run_id: "synthetic-sync",
          scan_started_at: input.require_scan_started_after, scan_completed_at: fixture.now, inventory_digest: sha256(rows), watermark: "synthetic-only" }],
      } : { synced_through: instant, source_proofs: [{ source_id: "synthetic-test-source", source_digest: sha256(rows), run_id: "synthetic-sync", synced_through: instant, watermark: "synthetic-only" }] };
      return { output: { projection_id: input.projection_id, rows: rows.map((row) => ({ ...row, instance_id: artifact.instance.id, projection_id: input.projection_id, record_type: "synthetic", source_version_id: sha256(row), projected_at: fixture.now })),
        observed_at: fixture.now, fresh_until: fixture.now, snapshot_id: sha256(rows), ...proof,
        access_decision: { allowed: true, projection_id: input.projection_id, principal_id: ENGINE_OPERATOR, policy_digest: "synthetic-test-policy", reason: "role-allowed", decided_at: fixture.now } }, evidence: { synthetic: true } };
    }
    if (capability === "communication.message.publish" && options.publicationConnector) return options.publicationConnector.invoke(capability, input, context);
    if (capability === "communication.message.publish" && fixture.unknownPublication) throw new CapabilityEffectOutcomeUnknownError("Synthetic publication outcome unknown", { synthetic: true });
    if (capability === "communication.message.publish") return { output: { destination_binding: input.destination_binding, message_id: `message-${fixture.calls.length}`, published_at: fixture.now,
      ...(fixture.missingThread ? {} : { thread_reference: input.thread_reference ?? `thread-${fixture.calls.length}` }) }, evidence: { synthetic: true, receipt: fixture.calls.length } };
    if (capability === "work-item.batch-update") {
      if (options.batchConnector) return options.batchConnector.invoke(capability, input, context);
      if (fixture.unknownBatch) throw new CapabilityEffectOutcomeUnknownError("Synthetic partial batch outcome", { synthetic: true, partial: true });
      return { output: { complete: true, results: input.updates.map((update: any) => ({ work_item_id: update.work_item_id, applied: true })) }, evidence: { synthetic: true, receipt: fixture.calls.length } };
    }
    throw new Error(`Unexpected synthetic Capability '${capability}'`);
  } };
  const conversation = (destinationBinding: string, output: JsonValue): WorkflowConversation => {
    const memberId = artifact.workflowBindings?.directRecipients.find((entry) => entry.destinationBinding === destinationBinding)?.memberId;
    const principal = memberId && new RecordIdentityDirectory(fixture.roster).members().find((member) => member.id === memberId)?.principals?.find((p) => p.startsWith("slack:"));
    return { surface: "synthetic", accountId: "test-account", channelId: destinationBinding, threadId: (output as Record<string, string>).thread_reference!, ...(principal ? { subjectPrincipal: principal } : {}) };
  };
  const engine = (pinned = artifact) => new WorkflowEngine({ verifyPublicationNotSent: options.verifyPublicationNotSent, artifact: pinned, store, control, timers, enabledWorkflowIds: artifact.workflows!.map((w) => w.id), operatorPrincipals: [ENGINE_OPERATOR],
    currentRoster: async () => fixture.roster, qualifyMessageDestinations: async () => ({ synthetic: true }), connectors: async () => [connector], clock: () => fixture.now,
    conversationForReceipt: options.conversationForReceipt ?? (async ({ destinationBinding, output }) => conversation(destinationBinding, output)) });
  return { ...fixture, get now() { return fixture.now; }, set now(value: string) { fixture.now = value; }, get roster() { return fixture.roster; },
    get missingThread() { return fixture.missingThread; }, set missingThread(value: boolean) { fixture.missingThread = value; },
    get unknownBatch() { return fixture.unknownBatch; }, set unknownBatch(value: boolean) { fixture.unknownBatch = value; },
    get unknownPublication() { return fixture.unknownPublication; }, set unknownPublication(value: boolean) { fixture.unknownPublication = value; },
    get failQuery() { return fixture.failQuery; }, set failQuery(value: boolean) { fixture.failQuery = value; }, engine, conversation };
}
