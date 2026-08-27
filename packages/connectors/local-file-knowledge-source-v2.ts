import { sha256 } from "../runtime/canonical.ts";
import {
  SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  assertSourceConnectorSupportsV2,
  createSourceEventV2,
  type ExactSourceInputV2,
  type SourceAccessSnapshotV2,
  type SourceBindingV2,
  type SourceConnectorDescriptorV2,
  type SourceConnectorV2,
  type SourceEventV2,
  type SourceHealthV2,
  type SourceReceiptOperationV2,
  type SourceReceiptV2,
  type SourceRequirementV2,
  type SourceVerificationV2,
} from "../knowledge/source-contracts-v2.ts";

const textualMedia = new Set(["text/markdown", "text/plain", "text/html", "application/json"]);

const makeReceipt = (input: {
  descriptor: SourceConnectorDescriptorV2;
  sourceId: string;
  operation: SourceReceiptOperationV2;
  observedAt: string;
  evidence: unknown;
  outcome?: SourceReceiptV2["outcome"];
  event?: SourceEventV2;
  reasonCode?: string;
}): SourceReceiptV2 => {
  const evidenceDigest = sha256(input.evidence);
  const value = {
    contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
    sourceId: input.sourceId,
    connectorId: input.descriptor.connectorId,
    connectorVersion: input.descriptor.connectorVersion,
    operation: input.operation,
    outcome: input.outcome ?? "succeeded",
    observedAt: input.observedAt,
    evidenceDigest,
    ...(input.event ? {
      deliveryId: input.event.deliveryId,
      providerObjectId: input.event.providerObjectId,
      ...(input.event.providerVersion ? { providerVersion: input.event.providerVersion } : {}),
    } : {}),
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
  };
  return { ...value, receiptId: sha256(value) };
};

export class LocalFileKnowledgeSourceConnectorV2 implements SourceConnectorV2 {
  readonly descriptor: SourceConnectorDescriptorV2;
  readonly sourceId: string;
  readonly #requirement: SourceRequirementV2;
  readonly #binding: SourceBindingV2;
  readonly #now: () => string;
  readonly #staged = new Map<string, { text: string; mediaType: ExactSourceInputV2["mediaType"]; digest: string }>();
  #revoked = false;

  constructor(input: {
    requirement: SourceRequirementV2;
    binding: SourceBindingV2;
    descriptor: SourceConnectorDescriptorV2;
    now?: () => string;
  }) {
    assertSourceConnectorSupportsV2(input);
    if (input.requirement.sourceKind !== "local-file" || input.requirement.deliveryMode !== "pull" || input.requirement.providerScope.kind !== "local-input") {
      throw new Error("Local Source requires the local-file/pull/exact-input-only profile.");
    }
    if (input.binding.providerIdentity.kind !== "local" || Object.keys(input.binding.secretRefs).length > 0 || input.binding.requiredScopes.length > 0) {
      throw new Error("Local Source binding must use local identity without secrets or provider scopes.");
    }
    if (input.requirement.access.mode === "provider-acl") throw new Error("Local Source does not invent provider ACL evidence; use a fixed policy or quarantine.");
    this.descriptor = structuredClone(input.descriptor);
    this.sourceId = input.requirement.sourceId;
    this.#requirement = structuredClone(input.requirement);
    this.#binding = structuredClone(input.binding);
    this.#now = input.now ?? (() => new Date().toISOString());
  }

  async verify(): Promise<SourceVerificationV2> {
    const observedAt = this.#now();
    const receipt = makeReceipt({
      descriptor: this.descriptor,
      sourceId: this.sourceId,
      operation: "verify",
      observedAt,
      evidence: { installationId: this.#binding.installationId, scope: "exact-input-only", secrets: 0 },
    });
    return {
      ok: !this.#revoked,
      sourceId: this.sourceId,
      connectorId: this.descriptor.connectorId,
      connectorVersion: this.descriptor.connectorVersion,
      providerIdentity: { kind: "local" },
      verifiedScopes: [],
      verifiedDeliveryModes: ["pull"],
      aclMapping: this.#requirement.access.mode === "fixed-policy" ? "verified" : "quarantine-only",
      receipt,
    };
  }

  async stageExactInput(input: ExactSourceInputV2): Promise<{ event: SourceEventV2; receipt: SourceReceiptV2 }> {
    if (this.#revoked) throw new Error("Local Source binding is revoked.");
    if (!input.providerObjectId.trim() || input.providerObjectId.length > 1_000 || input.providerObjectId.includes("\0")) throw new Error("Local input requires a bounded stable object identity.");
    if (!this.#requirement.content.mediaTypes.includes(input.mediaType) || !textualMedia.has(input.mediaType)) throw new Error(`Local input media type '${input.mediaType}' is not supported for inline ingestion.`);
    if (input.bytes.byteLength > this.#requirement.content.maxInlineBytes) throw new Error("Local input exceeds the configured inline boundary.");
    if (Number.isNaN(Date.parse(input.observedAt))) throw new Error("Local input observedAt must be an ISO timestamp.");
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes); }
    catch { throw new Error("Local input must be valid UTF-8 text."); }
    if (Buffer.byteLength(text) !== input.bytes.byteLength) throw new Error("Local input UTF-8 round trip changed the authorized bytes.");
    const digest = sha256(text);
    const event = createSourceEventV2({
      deliveryId: `local:${sha256({ sourceId: this.sourceId, objectId: input.providerObjectId, digest }).slice(0, 48)}`,
      sourceId: this.sourceId,
      providerTenantId: `local:${this.#binding.installationId}`,
      eventType: "updated",
      providerObjectId: input.providerObjectId,
      providerVersion: digest,
      occurredAt: new Date(input.observedAt).toISOString(),
      observedAt: new Date(input.observedAt).toISOString(),
      locator: `local-input:${encodeURIComponent(input.providerObjectId)}`,
      accessVersion: sha256(this.#requirement.access),
    });
    this.#staged.set(event.eventId, { text, mediaType: input.mediaType, digest });
    return {
      event,
      receipt: makeReceipt({
        descriptor: this.descriptor,
        sourceId: this.sourceId,
        operation: "enumerate",
        observedAt: event.observedAt,
        event,
        evidence: { eventId: event.eventId, contentDigest: digest, byteSize: input.bytes.byteLength, exactInputOnly: true },
        reasonCode: "exact-local-input-staged",
      }),
    };
  }

  async fetch(event: SourceEventV2) {
    const staged = this.#staged.get(event.eventId);
    if (!staged) throw new Error("Exact local input is not staged in this bounded invocation; retry with the same explicit input.");
    if (event.sourceId !== this.sourceId || event.providerVersion !== staged.digest) throw new Error("Local Source Event does not match its staged input.");
    const access: SourceAccessSnapshotV2 = {
      contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
      sourceId: this.sourceId,
      providerObjectId: event.providerObjectId,
      providerAccessVersion: event.accessVersion!,
      observedAt: event.observedAt,
      entries: [],
      evidenceDigest: sha256({ mode: this.#requirement.access.mode, rootPolicyId: this.#requirement.access.rootPolicyId, exactInputOnly: true }),
    };
    return {
      envelope: {
        contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
        sourceId: this.sourceId,
        providerTenantId: event.providerTenantId,
        providerObjectId: event.providerObjectId,
        providerVersion: staged.digest,
        eventId: event.eventId,
        observedAt: event.observedAt,
        locator: event.locator,
        mediaType: staged.mediaType,
        size: Buffer.byteLength(staged.text),
        contentDigest: staged.digest,
        accessPolicyId: this.#requirement.access.rootPolicyId,
        deletionState: "present" as const,
        content: { inlineText: staged.text },
      },
      access,
      receipt: makeReceipt({ descriptor: this.descriptor, sourceId: this.sourceId, operation: "fetch", observedAt: event.observedAt, event, evidence: { eventId: event.eventId, contentDigest: staged.digest, exactInputOnly: true } }),
    };
  }

  async health(): Promise<SourceHealthV2> {
    const checkedAt = this.#now();
    return {
      ok: !this.#revoked,
      sourceId: this.sourceId,
      status: this.#revoked ? "revoked" : "healthy",
      checkedAt,
      receipt: makeReceipt({ descriptor: this.descriptor, sourceId: this.sourceId, operation: "health", observedAt: checkedAt, outcome: this.#revoked ? "failed" : "succeeded", evidence: { revoked: this.#revoked } }),
    };
  }

  async revoke(): Promise<SourceReceiptV2> {
    this.#revoked = true;
    const observedAt = this.#now();
    return makeReceipt({ descriptor: this.descriptor, sourceId: this.sourceId, operation: "revoke", observedAt, evidence: { installationId: this.#binding.installationId }, reasonCode: "local-binding-revoked" });
  }
}
