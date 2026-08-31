import type { CapabilityCallContext, CapabilityResult, Connector, JsonValue } from "../../capabilities/contracts.ts";
import type { MondayEchoStore, MondayResourceBinding } from "./contracts.ts";
import { MondayClient } from "./client.ts";

const object = (value: unknown, label: string): Record<string, any> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, any>;
};

export class MondayWorkItemConnector implements Connector {
  readonly id = "oregano/monday-work-items";
  readonly version = "0.1.0";
  readonly capabilities = ["work-item.read", "work-item.update", "work-item.comment"] as const;
  readonly client: MondayClient;
  readonly bindings: Map<string, MondayResourceBinding>;
  readonly actorId: string;
  readonly instanceId: string;
  readonly echoStore: MondayEchoStore;
  readonly now: () => Date;

  constructor(args: { client: MondayClient; bindings: MondayResourceBinding[]; actorId: string; instanceId: string; echoStore: MondayEchoStore; now?: () => Date }) {
    this.client = args.client;
    this.bindings = new Map(args.bindings.map((binding) => [binding.id, structuredClone(binding)]));
    if (this.bindings.size !== args.bindings.length) throw new Error("Monday resource binding ids must be unique");
    this.actorId = args.actorId;
    this.instanceId = args.instanceId;
    this.echoStore = args.echoStore;
    this.now = args.now ?? (() => new Date());
  }

  async invoke(capability: string, input: unknown, context: CapabilityCallContext): Promise<CapabilityResult> {
    const value = object(input, "Monday Capability input");
    const binding = this.bindings.get(String(value.resource_binding));
    if (!binding) throw new Error(`Monday resource binding '${String(value.resource_binding)}' is not available to this Connector`);
    const workItemId = String(value.work_item_id);
    if (capability === "work-item.read") return this.read(binding, workItemId, value.fields);
    if (capability === "work-item.update") return this.update(binding, workItemId, value, context);
    if (capability === "work-item.comment") return this.comment(binding, workItemId, String(value.body), context);
    throw new Error(`Monday Connector does not implement '${capability}'`);
  }

  private async read(binding: MondayResourceBinding, workItemId: string, fields?: unknown): Promise<CapabilityResult> {
    const result = await this.client.readWorkItem(binding, workItemId, Array.isArray(fields) ? fields.map(String) : undefined);
    return {
      output: { work_item: result.data, provider_version: result.data.providerVersion, observed_at: this.now().toISOString() },
      evidence: { resource_binding: binding.id, work_item_id: workItemId, provider_version: result.data.providerVersion, observed_at: this.now().toISOString(), api_version: result.apiVersion, request_id: result.requestId },
    };
  }

  private async update(binding: MondayResourceBinding, workItemId: string, input: Record<string, any>, context: CapabilityCallContext): Promise<CapabilityResult> {
    if (!context.idempotencyKey) throw new Error("Monday work-item effects require a claimed idempotency key");
    const before = await this.client.readWorkItem(binding, workItemId);
    if (before.data.providerVersion !== String(input.expected_version)) throw new Error(`Monday work item '${workItemId}' changed since expected version '${String(input.expected_version)}'`);
    const changes = object(input.changes, "Monday work-item changes") as Record<string, JsonValue>;
    await this.client.updateWorkItem(binding, workItemId, changes);
    const after = await this.client.readWorkItem(binding, workItemId);
    const changedFields = Object.keys(changes).sort();
    await this.rememberEcho(binding, workItemId, after.data.providerVersion, context.idempotencyKey);
    return {
      output: { work_item: after.data, previous_version: before.data.providerVersion, provider_version: after.data.providerVersion, changed_fields: changedFields },
      evidence: { resource_binding: binding.id, work_item_id: workItemId, previous_version: before.data.providerVersion, provider_version: after.data.providerVersion, changed_fields: changedFields, api_version: after.apiVersion, request_id: after.requestId },
    };
  }

  private async comment(binding: MondayResourceBinding, workItemId: string, body: string, context: CapabilityCallContext): Promise<CapabilityResult> {
    if (!context.idempotencyKey) throw new Error("Monday work-item effects require a claimed idempotency key");
    await this.client.readWorkItem(binding, workItemId, []);
    const result = await this.client.comment(binding, workItemId, body);
    const after = await this.client.readWorkItem(binding, workItemId, []);
    await this.rememberEcho(binding, workItemId, after.data.providerVersion, context.idempotencyKey);
    const createdAt = result.data.create_update.created_at ?? this.now().toISOString();
    return {
      output: { comment_id: String(result.data.create_update.id), work_item_id: workItemId, provider_version: after.data.providerVersion, created_at: createdAt },
      evidence: { resource_binding: binding.id, work_item_id: workItemId, comment_id: String(result.data.create_update.id), provider_version: after.data.providerVersion, created_at: createdAt, api_version: result.apiVersion, request_id: result.requestId },
    };
  }

  private async rememberEcho(binding: MondayResourceBinding, workItemId: string, providerVersion: string, idempotencyKey: string): Promise<void> {
    const now = this.now();
    await this.echoStore.remember({
      instanceId: this.instanceId,
      resourceBinding: binding.id,
      workItemId,
      providerVersion,
      actorId: this.actorId,
      idempotencyKey,
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    });
  }
}
