import type { CapabilityCallContext, CapabilityResult, Connector } from "../../capabilities/contracts.ts";

export interface SlackDestinationBinding {
  readonly id: string;
  readonly accountId: string;
  readonly kind: "channel" | "direct-message";
  readonly channelId?: string;
  readonly userId?: string;
}

export interface SlackMessageReceipt {
  readonly messageId: string;
  readonly threadReference: string;
  readonly publishedAt: string;
}

export interface SlackMessagePublisher {
  publishChannel(channelId: string, content: string): Promise<SlackMessageReceipt>;
  publishDirect(userId: string, content: string): Promise<SlackMessageReceipt>;
}

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
};

/** Thin Slack implementation of the provider-neutral communication Capability. */
export class SlackCommunicationConnector implements Connector {
  readonly id = "oregano/slack-communication";
  readonly version = "0.1.0";
  readonly capabilities = ["communication.message.publish"] as const;
  readonly #bindings: Map<string, SlackDestinationBinding>;
  readonly #publisher: SlackMessagePublisher;

  constructor(args: { bindings: readonly SlackDestinationBinding[]; publisher: SlackMessagePublisher }) {
    this.#bindings = new Map(args.bindings.map((binding) => [binding.id, structuredClone(binding)]));
    if (this.#bindings.size !== args.bindings.length) throw new Error("Slack destination binding ids must be unique");
    for (const binding of this.#bindings.values()) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(binding.accountId)) throw new Error(`Slack destination '${binding.id}' has an invalid account id`);
      if (binding.kind === "channel" && (!binding.channelId || binding.userId)) throw new Error(`Slack channel destination '${binding.id}' requires only channelId`);
      if (binding.kind === "direct-message" && (!binding.userId || binding.channelId)) throw new Error(`Slack direct-message destination '${binding.id}' requires only userId`);
    }
    this.#publisher = args.publisher;
  }

  async invoke(capability: string, input: unknown, context: CapabilityCallContext): Promise<CapabilityResult> {
    if (capability !== "communication.message.publish") throw new Error(`Slack Connector does not implement '${capability}'`);
    if (!context.idempotencyKey) throw new Error("Slack message effects require a claimed idempotency key");
    const value = object(input, "Slack message input");
    const bindingId = String(value.destination_binding);
    const binding = this.#bindings.get(bindingId);
    if (!binding) throw new Error(`Slack destination binding '${bindingId}' is not available to this Connector`);
    const content = String(value.content);
    const receipt = binding.kind === "channel"
      ? await this.#publisher.publishChannel(binding.channelId!, content)
      : await this.#publisher.publishDirect(binding.userId!, content);
    if (!receipt.messageId || !receipt.threadReference || !receipt.publishedAt) throw new Error("Slack provider returned an incomplete message receipt");
    return {
      output: {
        message_id: receipt.messageId,
        destination_binding: binding.id,
        thread_reference: receipt.threadReference,
        published_at: receipt.publishedAt,
      },
      evidence: {
        destination_binding: binding.id,
        account_id: binding.accountId,
        destination_kind: binding.kind,
        message_id: receipt.messageId,
        thread_reference: receipt.threadReference,
        published_at: receipt.publishedAt,
      },
    };
  }
}
