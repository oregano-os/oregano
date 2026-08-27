import { sha256 } from "../runtime/canonical.ts";
import {
  SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
  assertSourceConnectorSupportsV2,
  type SourceAccessSnapshotV2,
  type SourceBindingV2,
  type SourceConnectorDescriptorV2,
  type SourceConnectorV2,
  type SourceEventV2,
  type SourceHealthV2,
  type SourceObjectDescriptorV2,
  type SourceReceiptOperationV2,
  type SourceReceiptV2,
  type SourceRequirementV2,
  type SourceVerificationV2,
} from "../knowledge/source-contracts-v2.ts";

const API_VERSION = "2026-03-10";

interface TreeCursorV2 {
  version: 2;
  treeSha: string;
  offset: number;
  checksum: string;
}

interface GitTreeEntry {
  path?: string;
  type?: string;
  sha?: string;
  size?: number;
}

export interface GitHubKnowledgeSourceV2Options {
  requirement: SourceRequirementV2;
  binding: SourceBindingV2;
  descriptor: SourceConnectorDescriptorV2;
  resolveSecret(reference: string): string | Promise<string>;
  fetch?: typeof globalThis.fetch;
  now?: () => string;
  retryDelay?: (milliseconds: number) => Promise<void>;
}

const receipt = (input: {
  descriptor: SourceConnectorDescriptorV2;
  sourceId: string;
  operation: SourceReceiptOperationV2;
  outcome?: SourceReceiptV2["outcome"];
  observedAt: string;
  evidence: unknown;
  deliveryId?: string;
  providerObjectId?: string;
  providerVersion?: string;
  cursor?: string;
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
    ...(input.deliveryId ? { deliveryId: input.deliveryId } : {}),
    ...(input.providerObjectId ? { providerObjectId: input.providerObjectId } : {}),
    ...(input.providerVersion ? { providerVersion: input.providerVersion } : {}),
    ...(input.cursor ? { cursorDigest: sha256(input.cursor) } : {}),
    ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
  };
  return { ...value, receiptId: sha256(value) };
};

const encodeCursor = (sourceId: string, treeSha: string, offset: number): string => {
  const value: TreeCursorV2 = {
    version: 2,
    treeSha,
    offset,
    checksum: sha256({ sourceId, treeSha, offset, version: 2 }),
  };
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
};

const decodeCursor = (sourceId: string, value: string): TreeCursorV2 => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("GitHub Source cursor is malformed.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("GitHub Source cursor is malformed.");
  const cursor = parsed as Partial<TreeCursorV2>;
  if (
    cursor.version !== 2
    || typeof cursor.treeSha !== "string"
    || !/^[0-9a-f]{40,64}$/i.test(cursor.treeSha)
    || !Number.isSafeInteger(cursor.offset)
    || Number(cursor.offset) < 0
    || cursor.checksum !== sha256({ sourceId, treeSha: cursor.treeSha, offset: cursor.offset, version: 2 })
  ) throw new Error("GitHub Source cursor failed integrity validation.");
  return cursor as TreeCursorV2;
};

const safeRepositoryPath = (value: string): boolean => value.length <= 1_000
  && !value.startsWith("/")
  && !value.includes("\\")
  && !value.split("/").includes("..");

export class GitHubKnowledgeSourceConnectorV2 implements SourceConnectorV2 {
  readonly descriptor: SourceConnectorDescriptorV2;
  readonly sourceId: string;
  readonly #requirement: SourceRequirementV2;
  readonly #binding: SourceBindingV2;
  readonly #resolveSecret: GitHubKnowledgeSourceV2Options["resolveSecret"];
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => string;
  readonly #retryDelay: (milliseconds: number) => Promise<void>;

  constructor(options: GitHubKnowledgeSourceV2Options) {
    assertSourceConnectorSupportsV2({ descriptor: options.descriptor, requirement: options.requirement, binding: options.binding });
    if (options.requirement.sourceKind !== "repository" || options.requirement.deliveryMode !== "pull") throw new Error("The GitHub Source Connector supports repository pull profiles only.");
    if (options.requirement.providerScope.kind !== "repository" || options.binding.providerIdentity.kind !== "repository") throw new Error("The GitHub Source Connector requires repository scope and provider identity.");
    if (options.requirement.access.mode === "provider-acl") throw new Error("The GitHub Source Connector cannot infer per-document provider ACLs; use a fixed root policy or quarantine.");
    const apiBaseUrl = options.binding.providerIdentity.apiBaseUrl ?? "https://api.github.com";
    if (new URL(apiBaseUrl).protocol !== "https:") throw new Error("GitHub Source apiBaseUrl must use HTTPS.");
    if (!options.binding.secretRefs.primary) throw new Error("The GitHub Source Connector requires secretRefs.primary.");
    this.descriptor = structuredClone(options.descriptor);
    this.sourceId = options.requirement.sourceId;
    this.#requirement = structuredClone(options.requirement);
    this.#binding = structuredClone({
      ...options.binding,
      providerIdentity: { ...options.binding.providerIdentity, apiBaseUrl: apiBaseUrl.replace(/\/$/, "") },
    });
    this.#resolveSecret = options.resolveSecret;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#retryDelay = options.retryDelay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async verify(): Promise<SourceVerificationV2> {
    const identity = this.#repositoryIdentity();
    const repository = await this.#request(`/repos/${encodeURIComponent(identity.accountId)}/${encodeURIComponent(identity.repositoryId)}`) as Record<string, unknown>;
    const observedIdentity = String(repository.full_name ?? "");
    const expectedIdentity = `${identity.accountId}/${identity.repositoryId}`;
    if (observedIdentity.toLocaleLowerCase("en") !== expectedIdentity.toLocaleLowerCase("en")) throw new Error(`Repository identity mismatch: expected '${expectedIdentity}', received '${observedIdentity || "unknown"}'.`);
    const observedAt = this.#now();
    const verificationReceipt = receipt({
      descriptor: this.descriptor,
      sourceId: this.sourceId,
      operation: "verify",
      observedAt,
      evidence: {
        repositoryIdentity: observedIdentity,
        ref: identity.ref,
        requiredScopes: this.#binding.requiredScopes,
        deliveryMode: this.#requirement.deliveryMode,
        accessMode: this.#requirement.access.mode,
      },
    });
    return {
      ok: true,
      sourceId: this.sourceId,
      connectorId: this.descriptor.connectorId,
      connectorVersion: this.descriptor.connectorVersion,
      providerIdentity: structuredClone(identity),
      verifiedScopes: [...this.#binding.requiredScopes],
      verifiedDeliveryModes: ["pull"],
      aclMapping: this.#requirement.access.mode === "quarantine" ? "quarantine-only" : "verified",
      receipt: verificationReceipt,
    };
  }

  async enumerate(input: { cursor?: string; pageSize: number }) {
    const identity = this.#repositoryIdentity();
    const scope = this.#repositoryScope();
    const prior = input.cursor ? decodeCursor(this.sourceId, input.cursor) : undefined;
    const treeish = prior?.treeSha ?? identity.ref;
    const tree = await this.#request(`/repos/${encodeURIComponent(identity.accountId)}/${encodeURIComponent(identity.repositoryId)}/git/trees/${encodeURIComponent(treeish)}?recursive=1`) as Record<string, unknown>;
    if (tree.truncated === true) throw new Error("Repository tree enumeration was truncated; synchronization stopped before reconciliation.");
    const treeSha = String(tree.sha ?? "");
    if (!/^[0-9a-f]{40,64}$/i.test(treeSha)) throw new Error("Repository tree response has no valid immutable SHA.");
    if (prior && prior.treeSha !== treeSha) throw new Error("GitHub Source cursor no longer identifies the same immutable tree.");
    const prefix = scope.pathPrefix ? `${scope.pathPrefix}/` : "";
    const rawEntries = Array.isArray(tree.tree) ? tree.tree as GitTreeEntry[] : [];
    const objects = rawEntries
      .filter((entry) => entry.type === "blob" && typeof entry.path === "string" && typeof entry.sha === "string" && typeof entry.size === "number")
      .filter((entry) => safeRepositoryPath(entry.path!))
      .filter((entry) => !prefix || entry.path!.startsWith(prefix))
      .filter((entry) => scope.includeExtensions.some((extension) => entry.path!.toLocaleLowerCase("en").endsWith(extension.toLocaleLowerCase("en"))))
      .filter((entry) => entry.size! <= this.#requirement.content.maxAssetBytes)
      .map((entry): SourceObjectDescriptorV2 => ({
        sourceId: this.sourceId,
        providerObjectId: entry.path!,
        providerVersion: entry.sha!,
        locator: entry.path!,
        mediaType: "text/markdown",
        size: entry.size!,
      }))
      .sort((left, right) => left.locator.localeCompare(right.locator));
    const pageSize = Math.max(1, Math.min(input.pageSize, 1_000));
    const offset = prior?.offset ?? 0;
    if (offset > objects.length) throw new Error("GitHub Source cursor offset exceeds the immutable inventory.");
    const pageObjects = objects.slice(offset, offset + pageSize);
    const nextOffset = offset + pageObjects.length;
    const complete = nextOffset >= objects.length;
    const nextCursor = complete ? undefined : encodeCursor(this.sourceId, treeSha, nextOffset);
    const observedAt = this.#now();
    const enumerationReceipt = receipt({
      descriptor: this.descriptor,
      sourceId: this.sourceId,
      operation: "enumerate",
      observedAt,
      cursor: input.cursor,
      evidence: { treeSha, offset, pageSize, returned: pageObjects.length, inventoryCount: objects.length, complete },
    });
    return {
      objects: pageObjects,
      ...(nextCursor ? { nextCursor } : {}),
      complete,
      completedWatermark: treeSha,
      receipt: enumerationReceipt,
    };
  }

  async fetch(event: SourceEventV2) {
    if (!["created", "updated"].includes(event.eventType) || !event.providerVersion) throw new Error("GitHub blob fetch requires a created or updated Source Event with a provider version.");
    if (event.providerObjectId !== event.locator || !safeRepositoryPath(event.locator)) throw new Error("GitHub Source Event locator is outside the repository boundary.");
    const identity = this.#repositoryIdentity();
    const blob = await this.#request(`/repos/${encodeURIComponent(identity.accountId)}/${encodeURIComponent(identity.repositoryId)}/git/blobs/${encodeURIComponent(event.providerVersion)}`) as Record<string, unknown>;
    if (blob.encoding !== "base64" || typeof blob.content !== "string") throw new Error(`Source object '${event.locator}' is not a base64 Git blob.`);
    const bytes = Buffer.from(blob.content.replace(/\s/g, ""), "base64");
    if (bytes.byteLength > this.#requirement.content.maxInlineBytes) throw new Error(`Source object '${event.locator}' exceeds the inline content boundary.`);
    const inlineText = bytes.toString("utf8").replace(/\r\n?/g, "\n");
    if (inlineText.includes("\uFFFD")) throw new Error(`Source object '${event.locator}' is not valid UTF-8 text.`);
    const size = Buffer.byteLength(inlineText);
    const contentDigest = sha256(inlineText);
    const access = this.#accessSnapshot(event);
    const fetchReceipt = receipt({
      descriptor: this.descriptor,
      sourceId: this.sourceId,
      operation: "fetch",
      observedAt: event.observedAt,
      deliveryId: event.deliveryId,
      providerObjectId: event.providerObjectId,
      providerVersion: event.providerVersion,
      evidence: { eventId: event.eventId, locator: event.locator, size, contentDigest, accessVersion: access.providerAccessVersion },
    });
    return {
      envelope: {
        contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
        sourceId: this.sourceId,
        providerTenantId: event.providerTenantId,
        providerObjectId: event.providerObjectId,
        providerVersion: event.providerVersion,
        eventId: event.eventId,
        observedAt: event.observedAt,
        locator: event.locator,
        mediaType: "text/markdown" as const,
        size,
        contentDigest,
        accessPolicyId: this.#requirement.access.rootPolicyId,
        deletionState: "present" as const,
        content: { inlineText },
      },
      access,
      receipt: fetchReceipt,
    };
  }

  async health(): Promise<SourceHealthV2> {
    const checkedAt = this.#now();
    try {
      await this.verify();
      return {
        ok: true,
        sourceId: this.sourceId,
        status: "healthy",
        checkedAt,
        receipt: receipt({ descriptor: this.descriptor, sourceId: this.sourceId, operation: "health", observedAt: checkedAt, evidence: { status: "healthy" } }),
      };
    } catch (error) {
      return {
        ok: false,
        sourceId: this.sourceId,
        status: "error",
        checkedAt,
        reasonCode: "provider-error",
        receipt: receipt({
          descriptor: this.descriptor,
          sourceId: this.sourceId,
          operation: "health",
          outcome: "failed",
          observedAt: checkedAt,
          reasonCode: "provider-error",
          evidence: { errorDigest: sha256(error instanceof Error ? error.message : String(error)) },
        }),
      };
    }
  }

  async revoke(): Promise<SourceReceiptV2> {
    const observedAt = this.#now();
    return receipt({
      descriptor: this.descriptor,
      sourceId: this.sourceId,
      operation: "revoke",
      observedAt,
      reasonCode: "local-binding-revoked",
      evidence: { installationId: this.#binding.installationId, localBindingRevoked: true },
    });
  }

  #repositoryIdentity(): Extract<SourceBindingV2["providerIdentity"], { kind: "repository" }> {
    if (this.#binding.providerIdentity.kind !== "repository") throw new Error("GitHub Source binding lost its repository identity.");
    return this.#binding.providerIdentity;
  }

  #repositoryScope(): Extract<SourceRequirementV2["providerScope"], { kind: "repository" }> {
    if (this.#requirement.providerScope.kind !== "repository") throw new Error("GitHub Source requirement lost its repository scope.");
    return this.#requirement.providerScope;
  }

  #accessSnapshot(event: SourceEventV2): SourceAccessSnapshotV2 {
    const providerAccessVersion = sha256({
      sourceId: this.sourceId,
      providerTenantId: event.providerTenantId,
      access: this.#requirement.access,
    });
    const evidenceDigest = sha256({
      providerAccessVersion,
      mode: this.#requirement.access.mode,
      rootPolicyId: this.#requirement.access.rootPolicyId,
      entries: [],
    });
    return {
      contractVersion: SOURCE_CONNECTOR_V2_CONTRACT_VERSION,
      sourceId: this.sourceId,
      providerObjectId: event.providerObjectId,
      providerAccessVersion,
      observedAt: event.observedAt,
      entries: [],
      evidenceDigest,
    };
  }

  async #request(path: string): Promise<unknown> {
    const secretRef = this.#binding.secretRefs.primary;
    const token = await this.#resolveSecret(secretRef);
    if (!token) throw new Error(`SecretRef '${secretRef}' resolved to an empty value.`);
    const identity = this.#repositoryIdentity();
    const apiBaseUrl = identity.apiBaseUrl ?? "https://api.github.com";
    let lastStatus = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await this.#fetch(`${apiBaseUrl}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": "oregano-company-knowledge",
        },
      });
      lastStatus = response.status;
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 3) break;
      const retryAfter = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(retryAfter) ? Math.min(retryAfter * 1_000, 1_000) : Math.min(100 * (2 ** (attempt - 1)), 1_000);
      await this.#retryDelay(delay);
    }
    throw new Error(`GitHub Source request failed after bounded retry (HTTP ${lastStatus}).`);
  }
}
