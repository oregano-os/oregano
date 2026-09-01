import type { MondayEchoReceipt, MondayEchoStore } from "./contracts.ts";

const key = (receipt: Pick<MondayEchoReceipt, "instanceId" | "resourceBinding" | "workItemId" | "providerVersion" | "actorId">): string =>
  [receipt.instanceId, receipt.resourceBinding, receipt.workItemId, receipt.providerVersion, receipt.actorId].join("\0");

/** Test and local adapter. Production Instances provide a durable equivalent. */
export class InMemoryMondayEchoStore implements MondayEchoStore {
  readonly receipts = new Map<string, MondayEchoReceipt>();

  async remember(receipt: MondayEchoReceipt): Promise<void> {
    this.receipts.set(key(receipt), structuredClone(receipt));
  }

  async consumeMatch(args: { instanceId: string; resourceBinding: string; workItemId: string; providerVersion: string; actorId: string; now: string }): Promise<MondayEchoReceipt | undefined> {
    const receiptKey = key(args);
    const receipt = this.receipts.get(receiptKey);
    if (!receipt) return undefined;
    this.receipts.delete(receiptKey);
    if (receipt.expiresAt <= args.now) return undefined;
    return structuredClone(receipt);
  }
}
